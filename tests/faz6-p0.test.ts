import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsRoute from "@/app/api/settings/route";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { onWorkerStarted } from "@/lib/backup/auto";
import { LIFECYCLE_ERROR_CODES, LIFECYCLE_ERROR_STATUS, LifecycleError } from "@/lib/backup/errors";
import { hasBackupPassphrase, lastSuccessfulBackup } from "@/lib/backup/shared";
import { PUBLIC_SECRET_NAMES } from "@/lib/client/types";
import { getDb, type Db } from "@/lib/db/client";
import {
  backupPathOf,
  classifyMigrationError,
  MIGRATE_RESULT_FILENAME,
  readMigrateResult,
  writeMigrateResult,
} from "@/lib/db/migrate-result";
import { MigrationBlockedError, MigrationVerificationError } from "@/lib/db/migrate";
import { backups, NOTIFICATION_KINDS } from "@/lib/db/schema";
import { en, EN_FRAGMENTS } from "@/lib/i18n/en";
import { tr, TR_FRAGMENTS } from "@/lib/i18n/tr";
import { getJobHandler } from "@/lib/jobs/registry";
import { registerLifecycleJobs } from "@/lib/lifecycle/jobs";
import { runPostInitHooks, runPreInitHooks } from "@/lib/lifecycle/pre-init";
import { notify } from "@/lib/notifications";
import { renderNotification } from "@/lib/notifications/render";
import {
  BACKUP_PASSPHRASE_SECRET,
  deleteSecret,
  getSecret,
  SECRET_NAMES,
  secretExists,
  setSecret,
} from "@/lib/secrets/store";
import { getSetting, SETTING_DEFAULTS, settingSchemas, USER_SETTING_KEYS } from "@/lib/settings";
import { childEnv } from "../electron/child-env";
import { hardenSession, hardenWebContents } from "../electron/hardening";
import {
  applyPendingLifecycleInMain,
  LIFECYCLE_IPC_CHANNELS,
  registerLifecycleIpc,
  type LifecycleIpcEvent,
} from "../electron/lifecycle";
import { handleMigrationFailure } from "../electron/migration-recovery";
import { createTestDb, type TestDb } from "./helpers/db";
import { mulberry32, seedLeads } from "./helpers/seed-leads";

/**
 * Faz 6 P0 temeli: iç ayar anahtarları (varsayılan + doğrulama + API'den yazılamazlık), yedek parolası gizli adı (listede
 * yok, ortam yedeği yok), hata kodu kataloğu ve TR+EN metinleri, yeni bildirim türleri, sözlük parçaları, paket
 * yer tutucularının güvenle çağrılabilirliği, Electron dikişleri (enjekte bağımlılıklarla), `migrate-result.json` ve
 * `scripts/migrate.ts` sırası (gerçek alt süreç). Gerçek dış ağ yok; yalnızca geçici klasörler.
 */

const REPO = path.resolve(__dirname, "..");
const ORIGIN = "http://127.0.0.1:3000";
const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const put = (body: unknown) =>
  settingsRoute.PUT(
    new Request(`${ORIGIN}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
      body: JSON.stringify(body),
    }),
    undefined,
  );

const FAZ6_KEYS = [
  "backup.schedule",
  "backup.folder",
  "retention.leads",
  "retention.lastRun",
  "onboarding.checklist",
] as const;

describe("Faz 6 ayarları: şemalar, varsayılanlar, iç anahtarlar", () => {
  it("varsayılanlar kendi şemalarından geçer ve İÇ anahtardır (ayarlar API'si yazamaz)", () => {
    for (const k of FAZ6_KEYS) {
      expect(settingSchemas[k].safeParse(SETTING_DEFAULTS[k]).success, k).toBe(true);
      expect(USER_SETTING_KEYS as readonly string[]).not.toContain(k);
    }
    expect(SETTING_DEFAULTS["backup.schedule"]).toEqual({
      auto: true,
      onStartup: true,
      weekly: true,
      keepStartup: 7,
      keepWeekly: 4,
      includeSecrets: true,
    });
    expect(SETTING_DEFAULTS["backup.folder"]).toBeNull();
    expect(SETTING_DEFAULTS["retention.leads"]).toEqual({ enabled: true, months: 12 });
    expect(SETTING_DEFAULTS["retention.lastRun"]).toBeNull();
    expect(SETTING_DEFAULTS["onboarding.checklist"]).toEqual({ dismissedAt: null });
  });

  it("sınırlar: tutma sayıları, ay aralığı (yalnızca kısaltılabilir), klasör biçimi, son çalışma", () => {
    const sched = settingSchemas["backup.schedule"];
    const base = SETTING_DEFAULTS["backup.schedule"];
    expect(sched.safeParse({ ...base, keepStartup: 30, keepWeekly: 52 }).success).toBe(true);
    for (const bad of [
      { keepStartup: 0 },
      { keepStartup: 31 },
      { keepWeekly: 0 },
      { keepWeekly: 53 },
      { keepStartup: 2.5 },
      { auto: "yes" },
    ])
      expect(sched.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    const ret = settingSchemas["retention.leads"];
    expect(ret.safeParse({ enabled: false, months: 1 }).success).toBe(true);
    expect(ret.safeParse({ enabled: true, months: 13 }).success).toBe(false);
    expect(ret.safeParse({ enabled: true, months: 0 }).success).toBe(false);
    const folder = settingSchemas["backup.folder"];
    expect(folder.safeParse("/Users/me/Yedekler").success).toBe(true);
    expect(folder.safeParse("").success).toBe(false);
    expect(folder.safeParse("a".repeat(1025)).success).toBe(false);
    expect(folder.safeParse("/tmp/a\0b").success).toBe(false);
    const last = settingSchemas["retention.lastRun"];
    expect(last.safeParse({ at: 1, cutoff: 0, deleted: 3 }).success).toBe(true);
    expect(last.safeParse({ at: 1, cutoff: 0, deleted: -1 }).success).toBe(false);
    expect(settingSchemas["onboarding.checklist"].safeParse({ dismissedAt: "dün" }).success).toBe(
      false,
    );
  });

  describe("veritabanıyla", () => {
    let t: TestDb;
    let db: Db;
    beforeEach(async () => {
      t = await createTestDb();
      db = await getDb();
    });
    afterEach(async () => {
      await t.cleanup();
    });

    it("PUT /api/settings iç anahtarları reddeder; değer değişmez", async () => {
      for (const k of FAZ6_KEYS) {
        const res = await put({ [k]: SETTING_DEFAULTS[k] });
        expect(res.status, k).toBe(400);
      }
      expect(await getSetting(db, "retention.leads")).toEqual({ enabled: true, months: 12 });
    });

    it("lastSuccessfulBackup: yalnızca 'ok' satırları, en yenisi; yoksa null", async () => {
      expect(await lastSuccessfulBackup(db)).toBeNull();
      const row = (name: string, status: "ok" | "failed", at: number, kind = "manual" as const) =>
        db.insert(backups).values({
          kind,
          status,
          fileName: name,
          folder: t.dir,
          sizeBytes: status === "ok" ? 1 : null,
          sha256: status === "ok" ? "c".repeat(64) : null,
          appVersion: "0.1.0",
          schemaMigrations: 7,
          errorCode: status === "failed" ? "BACKUP_DISK_FULL" : null,
          createdAt: at - 5,
          finishedAt: at,
        });
      await row("universal-mail-20261101-000000-manual.umbk", "ok", 1000);
      await row("universal-mail-20261102-000000-startup.umbk", "failed", 3000);
      await row("universal-mail-20261103-000000-weekly.umbk", "ok", 2000, "weekly" as never);
      expect(await lastSuccessfulBackup(db)).toEqual({ at: 2000, kind: "weekly" });
    });

    it("yeni bildirim türleri kaydedilir ve iki dilde metne dönüşür", async () => {
      expect(NOTIFICATION_KINDS).toContain("backup.failed");
      expect(NOTIFICATION_KINDS).toContain("retention.purged");
      const a = await notify(db, {
        kind: "backup.failed",
        dedupeKey: "backup.failed:2026-11-16",
        params: { code: "BACKUP_DISK_FULL" },
        url: "/settings",
      });
      expect(a.created).toBe(true);
      const b = await notify(db, {
        kind: "retention.purged",
        dedupeKey: "retention.purged:2026-11-16",
        params: { n: 1234 },
        url: "/settings",
      });
      expect(b.created).toBe(true);
    });
  });
});

describe("bildirim metinleri (backup.failed, retention.purged)", () => {
  it("bilinen kodlar özel metin, diğerleri genel metin; sayı yerelleştirilir", () => {
    for (const locale of ["tr", "en"] as const) {
      const other = renderNotification(
        { kind: "backup.failed", params: { code: "BACKUP_FAILED" } },
        locale,
      );
      for (const c of [
        "BACKUP_PASSPHRASE_REQUIRED",
        "BACKUP_FOLDER_UNWRITABLE",
        "BACKUP_DISK_FULL",
      ]) {
        const r = renderNotification({ kind: "backup.failed", params: { code: c } }, locale);
        expect(r.title).toBe(other.title);
        expect(r.body).not.toBe(other.body);
      }
      expect(renderNotification({ kind: "backup.failed", params: {} }, locale).body).toBe(
        other.body,
      );
    }
    expect(renderNotification({ kind: "retention.purged", params: { n: 1234 } }, "tr").title).toBe(
      "Eski kayıtlar silindi: 1.234",
    );
    expect(renderNotification({ kind: "retention.purged", params: { n: 1234 } }, "en").title).toBe(
      "Old records deleted: 1,234",
    );
  });
});

describe("yedek parolası gizli adı", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpBase, "um-f6s-"));
    process.env.UM_DATA_DIR = dir;
    process.env.UM_MASTER_KEY = "ab".repeat(32);
    delete process.env.UM_REQUIRE_MASTER_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("depoca kabul edilir, genel listede (ve arayüz listesinde) yok, ortamdan okunmaz", async () => {
    expect(SECRET_NAMES as readonly string[]).not.toContain(BACKUP_PASSPHRASE_SECRET);
    expect(PUBLIC_SECRET_NAMES as readonly string[]).not.toContain(BACKUP_PASSPHRASE_SECRET);
    process.env.BACKUP_PASSPHRASE = "ortamdan-gelen-parola";
    process.env.UM_BACKUP_PASSPHRASE = "ortamdan-gelen-parola";
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBeUndefined();
    expect(await hasBackupPassphrase()).toBe(false);
    await setSecret(BACKUP_PASSPHRASE_SECRET, "çok-gizli-yedek-parolası");
    expect(await secretExists(BACKUP_PASSPHRASE_SECRET)).toBe(true);
    expect(await hasBackupPassphrase()).toBe(true);
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBe("çok-gizli-yedek-parolası");
    // Düz metin dosyada yok
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain("gizli-yedek");
    await deleteSecret(BACKUP_PASSPHRASE_SECRET);
    expect(await hasBackupPassphrase()).toBe(false);
  });

  it("ana anahtar zorunlu ve yoksa 'parola yok' sayılır (fırlatmaz)", async () => {
    delete process.env.UM_MASTER_KEY;
    process.env.UM_REQUIRE_MASTER_KEY = "1";
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ v: 1, items: { x: {} } }));
    expect(await hasBackupPassphrase()).toBe(false);
  });
});

describe("hata kodları ve metinleri", () => {
  it("her Faz 6 kodu katalogda, HTTP durumu tanımlı ve iki dilde metni var", () => {
    expect(LIFECYCLE_ERROR_CODES).toHaveLength(19);
    for (const c of LIFECYCLE_ERROR_CODES) {
      expect(API_ERROR_CODES as readonly string[]).toContain(c);
      expect(LIFECYCLE_ERROR_STATUS[c], c).toBeGreaterThanOrEqual(400);
      const key = `apiError.${c}` as keyof typeof tr;
      expect(tr[key], c).toBeTruthy();
      expect(en[key], c).toBeTruthy();
      expect(en[key]).not.toBe(tr[key]);
    }
    expect(LIFECYCLE_ERROR_STATUS.BACKUP_DISK_FULL).toBe(507);
    expect(LIFECYCLE_ERROR_STATUS.BACKUP_FILE_MISSING).toBe(410);
    expect(LIFECYCLE_ERROR_STATUS.BACKUP_TOO_LARGE).toBe(413);
    const e = new LifecycleError("LIFECYCLE_PENDING", "Bekleyen işlem var.");
    expect(e.status).toBe(409);
    expect(e.name).toBe("LifecycleError");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("sözlük parçaları", () => {
  it("backup, install, security parçaları iki dilde kayıtlı ve Ayarlar gezinme anahtarı var", () => {
    for (const f of ["backup", "install", "security"] as const) {
      expect(Object.keys(TR_FRAGMENTS[f]).length, f).toBeGreaterThan(0);
      expect(Object.keys(EN_FRAGMENTS[f]).sort()).toEqual(Object.keys(TR_FRAGMENTS[f]).sort());
    }
    expect(tr["settings.nav.backup"]).toBe("Yedekler");
    expect(en["settings.nav.backup"]).toBe("Backups");
  });
});

describe("paket yer tutucuları güvenle çağrılabilir (davranış yok)", () => {
  // Paket Y yer tutucuları doldurdu: işçi dikişinin imzası aynı kaldı; iş kaydı artık iki işleyiciyi kaydeder
  // (davranış testleri: tests/backup-auto-jobs.test.ts, tests/retention.test.ts).
  it("işçi: açılış yedeği dikişi aynı imzada; iş kaydı backup.auto ve data.retention işleyicilerini ekler", () => {
    expect(onWorkerStarted).toHaveLength(2);
    expect(() => registerLifecycleJobs()).not.toThrow();
    expect(getJobHandler("backup.auto")).toBeTypeOf("function");
    expect(getJobHandler("data.retention")).toBeTypeOf("function");
  });

  it("migrate kancaları: bekleyen işlem uygulanmaz", async () => {
    const log = vi.fn();
    const pre = await runPreInitHooks({ dataDir: tmpBase, log });
    expect(pre).toEqual({ applied: null });
    await expect(runPostInitHooks({} as Db, pre)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    await expect(
      applyPendingLifecycleInMain({ userDataDir: tmpBase, dataDir: tmpBase, log }),
    ).resolves.toEqual({ applied: null });
  });
});

describe("Electron dikişleri (enjekte bağımlılıklarla)", () => {
  it("childEnv eskisinin aynısı: 127.0.0.1, telemetri kapalı, ana anahtar zorunlu, sunucu klasörü yolları", () => {
    const env = childEnv({
      port: 4321,
      masterKey: "k",
      dataDir: "/veri",
      serverDir: "/sunucu",
      baseEnv: { PATH: "/bin", HOSTNAME: "0.0.0.0" } as unknown as NodeJS.ProcessEnv,
    });
    expect(env).toEqual({
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HOSTNAME: "127.0.0.1",
      PORT: "4321",
      UM_DATA_DIR: "/veri",
      UM_MASTER_KEY: "k",
      UM_REQUIRE_MASTER_KEY: "1",
      UM_MIGRATIONS_DIR: path.join("/sunucu", "drizzle"),
      UM_STATIC_DATA_DIR: path.join("/sunucu", "data"),
    });
  });

  it("hardenWebContents: yeni pencere hep reddedilir; dış http(s) tarayıcıya; yerel dışı gezinme engellenir", () => {
    let openHandler: ((d: { url: string }) => { action: "deny" }) | undefined;
    let navigate: ((e: { preventDefault(): void }, url: string) => void) | undefined;
    const opened: string[] = [];
    hardenWebContents(
      {
        setWindowOpenHandler: (h) => void (openHandler = h),
        // Paket G başka olaylar da dinler (will-redirect, will-attach-webview…); burada yalnızca gezinme sınanır.
        on: (ev: string, l: (e: { preventDefault(): void }, url: string) => void) => {
          if (ev === "will-navigate") navigate = l;
        },
      },
      {
        isLocal: (u) => u.startsWith("http://127.0.0.1:5000"),
        openExternal: (u) => void opened.push(u),
        log: () => {},
      },
    );
    expect(openHandler!({ url: "https://firma.com/" })).toEqual({ action: "deny" });
    expect(openHandler!({ url: "http://127.0.0.1:5000/x" })).toEqual({ action: "deny" });
    expect(openHandler!({ url: "file:///etc/passwd" })).toEqual({ action: "deny" });
    expect(opened).toEqual(["https://firma.com/"]);
    const ev = () => {
      const e = { prevented: false, preventDefault: () => void (e.prevented = true) };
      return e;
    };
    const local = ev();
    navigate!(local, "http://127.0.0.1:5000/settings");
    expect(local.prevented).toBe(false);
    const ext = ev();
    navigate!(ext, "https://example.com/");
    expect(ext.prevented).toBe(true);
    const js = ev();
    navigate!(js, "javascript:alert(1)");
    expect(js.prevented).toBe(true);
    expect(opened).toEqual(["https://firma.com/", "https://example.com/"]);
  });

  it("hardenSession: her izin isteği reddedilir", () => {
    let handler: ((wc: unknown, p: string, cb: (granted: boolean) => void) => void) | undefined;
    hardenSession({ setPermissionRequestHandler: (h) => void (handler = h) });
    const answers: boolean[] = [];
    for (const p of ["media", "geolocation", "notifications"])
      handler!(null, p, (g) => void answers.push(g));
    expect(answers).toEqual([false, false, false]);
  });

  it("registerLifecycleIpc: üç kanal; yalnızca yerel kökenden gelen çağrı işlenir", async () => {
    const handlers = new Map<string, (e: LifecycleIpcEvent, ...a: unknown[]) => unknown>();
    const relaunch = vi.fn(async () => {});
    registerLifecycleIpc(
      { handle: (c, l) => void handlers.set(c, l) },
      {
        isLocal: (u) => u.startsWith("http://127.0.0.1:5000"),
        relaunch,
        chooseFolder: async () => "/Users/me/Yedekler",
        chooseFile: async () => "/Users/me/y.umbk",
      },
    );
    expect([...handlers.keys()].sort()).toEqual([...LIFECYCLE_IPC_CHANNELS].sort());
    const local = { senderFrame: { url: "http://127.0.0.1:5000/settings" } };
    const foreign = { senderFrame: { url: "https://evil.example/" } };
    expect(await handlers.get("um:choose-folder")!(foreign)).toBeNull();
    expect(await handlers.get("um:choose-backup-file")!({ senderFrame: null })).toBeNull();
    expect(await handlers.get("um:relaunch")!(foreign)).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
    expect(await handlers.get("um:choose-folder")!(local)).toBe("/Users/me/Yedekler");
    expect(await handlers.get("um:choose-backup-file")!(local)).toBe("/Users/me/y.umbk");
    expect(await handlers.get("um:relaunch")!(local)).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("handleMigrationFailure: genel hata kutusu yerine koda özel iletişim kutusu (ayrıntı: electron-migration-recovery)", async () => {
    // Paket K yer tutucuyu doldurdu; tam kapsam tests/electron-migration-recovery.test.ts'tedir. Burada yalnızca dikiş:
    // ana sürecin verdiği bağımlılıklarla çağrılır, genel hata kutusunu kullanmaz, ilk düğme "retry" döndürür.
    const boxes: string[] = [];
    const errorBoxes: string[] = [];
    const action = await handleMigrationFailure(null, {
      dataDir: "/veri",
      logDir: "/gunluk",
      attempt: 1,
      exitCode: 1,
      dbInUse: () => false,
      t: (k, p) => `${k}${p ? JSON.stringify(p) : ""}`,
      showMessageBox: (spec) => (boxes.push(spec.title), 0),
      showErrorBox: (title) => void errorBoxes.push(title),
      openPath: () => {},
      exists: () => false,
      copyFile: () => {},
      rename: () => {},
      readdir: () => [],
      now: () => 0,
      log: () => {},
    });
    expect(action).toBe("retry");
    expect(boxes).toEqual(["electron.migrate.title"]);
    expect(errorBoxes).toEqual([]);
  });
});

describe("migrate-result.json", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpBase, "um-f6m-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("atomik yazım ve doğrulamalı okuma; veri klasörü dışındaki yedek yolu yazılmaz", () => {
    expect(readMigrateResult(dir)).toBeNull();
    const inside = path.join(dir, "backups", "pre-migrate-2026.db");
    writeMigrateResult(dir, {
      ok: false,
      code: "VERIFY_FAILED",
      applied: 0,
      total: 7,
      backupPath: inside,
      at: 5,
    });
    expect(readMigrateResult(dir)).toEqual({
      v: 1,
      ok: false,
      code: "VERIFY_FAILED",
      applied: 0,
      total: 7,
      backupPath: inside,
      at: 5,
    });
    expect(fs.readdirSync(dir)).toEqual([MIGRATE_RESULT_FILENAME]);
    writeMigrateResult(dir, {
      ok: false,
      code: "FAILED",
      applied: 0,
      total: 7,
      backupPath: path.join(tmpBase, "baska", "x.db"),
    });
    expect(readMigrateResult(dir)?.backupPath).toBeUndefined();
    writeMigrateResult(dir, { ok: false, code: "FAILED", applied: 0, total: 7, backupPath: dir });
    expect(readMigrateResult(dir)?.backupPath).toBeUndefined();
    for (const bad of [
      "{",
      "null",
      JSON.stringify({ v: 2, ok: true, code: "OK", applied: 0, total: 0, at: 0 }),
      JSON.stringify({ v: 1, ok: true, code: "NOPE", applied: 0, total: 0, at: 0 }),
      JSON.stringify({ v: 1, ok: true, code: "OK", applied: -1, total: 0, at: 0 }),
    ]) {
      fs.writeFileSync(path.join(dir, MIGRATE_RESULT_FILENAME), bad);
      expect(readMigrateResult(dir), bad).toBeNull();
    }
    // Dışarıdaki yolu elle yazılmış dosya da kabul edilmez.
    fs.writeFileSync(
      path.join(dir, MIGRATE_RESULT_FILENAME),
      JSON.stringify({
        v: 1,
        ok: false,
        code: "FAILED",
        applied: 0,
        total: 1,
        at: 1,
        backupPath: "/etc/passwd",
      }),
    );
    expect(readMigrateResult(dir)?.backupPath).toBeUndefined();
  });

  it("yazılamayan klasörde sessizce geçer", () => {
    expect(() =>
      writeMigrateResult(path.join(dir, "yok", "yok"), {
        ok: true,
        code: "OK",
        applied: 1,
        total: 1,
      }),
    ).not.toThrow();
  });

  it("hata sınıflandırması türe ve SQLite koduna göre", () => {
    expect(classifyMigrationError(new MigrationBlockedError("x"))).toBe("BLOCKED");
    const v = new MigrationVerificationError("x", "/veri/backups/pre-migrate-1.db");
    expect(classifyMigrationError(v)).toBe("VERIFY_FAILED");
    expect(backupPathOf(v)).toBe("/veri/backups/pre-migrate-1.db");
    expect(backupPathOf(new Error("x"))).toBeUndefined();
    expect(backupPathOf(null)).toBeUndefined();
    expect(classifyMigrationError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(
      "DISK_FULL",
    );
    expect(
      classifyMigrationError(
        new Error("sarılmış", { cause: Object.assign(new Error("i"), { code: "SQLITE_FULL" }) }),
      ),
    ).toBe("DISK_FULL");
    expect(classifyMigrationError(Object.assign(new Error("x"), { code: "SQLITE_CORRUPT" }))).toBe(
      "CORRUPT",
    );
    expect(classifyMigrationError(Object.assign(new Error("x"), { code: "SQLITE_NOTADB" }))).toBe(
      "CORRUPT",
    );
    expect(classifyMigrationError(new Error("başka"))).toBe("FAILED");
    expect(classifyMigrationError("metin")).toBe("FAILED");
    expect(classifyMigrationError(null)).toBe("FAILED");
  });
});

function runMigrateScript(
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "migrate.ts")],
      { cwd: REPO, env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe("scripts/migrate.ts: sıra ve sonuç dosyası", () => {
  it("kaynakta sıra: pre → init → post → sonuç; hata yolunda sınıflandırılmış sonuç", () => {
    const src = fs.readFileSync(path.join(REPO, "scripts", "migrate.ts"), "utf8");
    const body = src.slice(src.indexOf("async function main"));
    const at = (s: string) => body.indexOf(s);
    expect(at("runPreInitHooks(")).toBeGreaterThan(0);
    expect(at("runPreInitHooks(")).toBeLessThan(at("initDatabase()"));
    expect(at("initDatabase()")).toBeLessThan(at("runPostInitHooks("));
    expect(at("runPostInitHooks(")).toBeLessThan(at('code: "OK"'));
    expect(at('code: "OK"')).toBeLessThan(at("classifyMigrationError(e)"));
  });

  it("gerçek alt süreç: başarıda OK sonucu (uygulanan = toplam); bozuk veritabanında CORRUPT ve çıkış 1", async () => {
    const dir = fs.mkdtempSync(path.join(tmpBase, "um-f6r-"));
    try {
      const env = {
        UM_DATA_DIR: dir,
        UM_DB_PATH: path.join(dir, "universal-mail.db"),
        UM_MIGRATIONS_DIR: path.join(REPO, "drizzle"),
        UM_STATIC_DATA_DIR: path.join(REPO, "data"),
        UM_MASTER_KEY: "cd".repeat(32),
      };
      const total = (
        JSON.parse(
          fs.readFileSync(path.join(REPO, "drizzle", "meta", "_journal.json"), "utf8"),
        ) as { entries: unknown[] }
      ).entries.length;
      const ok = await runMigrateScript(env);
      expect(ok.code, ok.err).toBe(0);
      const r = readMigrateResult(dir);
      expect(r).toMatchObject({ ok: true, code: "OK", applied: total, total });
      const again = await runMigrateScript(env);
      expect(again.code, again.err).toBe(0);
      expect(readMigrateResult(dir)).toMatchObject({ ok: true, applied: 0, total });

      const bad = fs.mkdtempSync(path.join(tmpBase, "um-f6b-"));
      try {
        const badDb = path.join(bad, "universal-mail.db");
        fs.writeFileSync(badDb, Buffer.alloc(8192, 0x41));
        const res = await runMigrateScript({ ...env, UM_DATA_DIR: bad, UM_DB_PATH: badDb });
        expect(res.code).toBe(1);
        expect(readMigrateResult(bad)).toMatchObject({ ok: false, code: "CORRUPT", applied: 0 });
      } finally {
        fs.rmSync(bad, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("arayüz yuvaları ve paketleme yapılandırması", () => {
  it("Ayarlar 'backup' bölümünü 'data'dan hemen sonra; gösterge paneli kurulum kartını başlığın altında gösterir", () => {
    const settings = fs.readFileSync(
      path.join(REPO, "src/features/settings/settings-page.tsx"),
      "utf8",
    );
    expect(settings).toMatch(
      /\{ id: "data", key: "settings\.nav\.data" \},\s*\{ id: "backup", key: "settings\.nav\.backup" \}/,
    );
    expect(settings).toMatch(/<div id="backup"[^>]*>\s*<BackupSection \/>/);
    const dash = fs.readFileSync(
      path.join(REPO, "src/features/dashboard/dashboard-page.tsx"),
      "utf8",
    );
    expect(dash.indexOf("<OnboardingChecklistCard />")).toBeGreaterThan(
      dash.indexOf("<PageHeader"),
    );
    expect(dash.indexOf("<OnboardingChecklistCard />")).toBeLessThan(
      dash.indexOf("<DashboardSkeleton />"),
    );
  });

  it("electron-builder.config.cjs: kimlik main.ts ile aynı; paket betikleri bu dosyayı kullanır; eski yml yok", async () => {
    const cfg = createRequire(__filename)("../electron-builder.config.cjs") as {
      appId: string;
      productName: string;
      nsis: { deleteAppDataOnUninstall: boolean };
    };
    const main = fs.readFileSync(path.join(REPO, "electron/main.ts"), "utf8");
    expect(main).toContain(`app.setName("${cfg.productName}")`);
    expect(main).toContain(`app.setAppUserModelId("${cfg.appId}")`);
    expect(cfg.nsis.deleteAppDataOnUninstall).toBe(false);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.dist).toContain("--config electron-builder.config.cjs");
    expect(pkg.scripts["dist:dir"]).toContain("--config electron-builder.config.cjs");
    expect(fs.existsSync(path.join(REPO, "electron-builder.yml"))).toBe(false);
  });
});

describe("tests/helpers/seed-leads.ts", () => {
  it("mulberry32 ve tohum: aynı tohum aynı veri; dağılım sözleşmedeki aralıklarda", async () => {
    const a = mulberry32(9);
    const b = mulberry32(9);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const t1 = await createTestDb();
    try {
      const c = (await import("@/lib/db/client")).getClient;
      const client = await c();
      const r = await seedLeads(client, { n: 2000, seed: 11 });
      expect(r.leads).toBe(2000);
      const pct = (x: number) => x / r.leads;
      expect(pct(r.archived)).toBeGreaterThan(0.005);
      expect(pct(r.archived)).toBeLessThan(0.04);
      expect(pct(r.withWebsite)).toBeGreaterThan(0.15);
      expect(pct(r.withWebsite)).toBeLessThan(0.25);
      expect(pct(r.contacted)).toBeGreaterThan(0.03);
      expect(pct(r.contacted)).toBeLessThan(0.08);
      expect(r.registry).toBeGreaterThan(0);
      expect(r.cached).toBeGreaterThan(0);
      const one = async (sql: string) => Number((await client.execute(sql)).rows[0]?.[0] ?? 0);
      expect(await one("SELECT COUNT(*) FROM leads")).toBe(2000);
      expect(await one("SELECT COUNT(*) FROM gcache.place_cache")).toBe(r.cached);
      expect(await one("SELECT COUNT(*) FROM lead_emails WHERE is_primary = 1")).toBeGreaterThan(0);
      expect(await one("SELECT COUNT(DISTINCT novelty_label) FROM leads")).toBe(4);
      expect(await one("SELECT COUNT(DISTINCT source) FROM leads")).toBe(4);
      expect(
        await one(
          "SELECT COUNT(*) FROM leads WHERE source IN ('registry','import') AND place_id IS NOT NULL",
        ),
      ).toBe(0);
      expect(await one("SELECT COUNT(*) FROM pragma_foreign_key_check")).toBe(0);
      const sig = await one(
        "SELECT SUM(novelty_score * 7 + length(coalesce(display_name,''))) FROM leads",
      );
      await t1.cleanup();
      const t2 = await createTestDb();
      try {
        const client2 = await c();
        await seedLeads(client2, { n: 2000, seed: 11 });
        expect(
          Number(
            (
              await client2.execute(
                "SELECT SUM(novelty_score * 7 + length(coalesce(display_name,''))) FROM leads",
              )
            ).rows[0]?.[0],
          ),
        ).toBe(sig);
      } finally {
        await t2.cleanup();
      }
    } catch (e) {
      await t1.cleanup().catch(() => {});
      throw e;
    }
  });
});
