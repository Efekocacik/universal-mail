import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failureCode,
  handleMigrationFailure,
  MAIN_DB_FILENAME,
  MIGRATION_RETRY_DIALOGS,
  rememberBackup,
  restorableBackup,
  RETRYABLE_CODES,
  restorePreMigrateBackup,
  type MigrationRecoveryDeps,
} from "../electron/migration-recovery";
import { openDatabase } from "@/lib/db/client";
import {
  MIGRATE_RESULT_CODES,
  readMigrateResult,
  type MigrateResult,
  type MigrateResultCode,
} from "@/lib/db/migrate-result";
import { runMigrations } from "@/lib/db/migrate";
import { t, type TrKey } from "@/lib/i18n";
import {
  brokenLastMigration,
  partialMigrations,
  SOURCE_MIGRATIONS,
  TOTAL_MIGRATIONS,
} from "./helpers/migration-dirs";

/**
 * Faz 6 (sözleşme K.2): şema geçişi başarısız olunca gösterilen kurtarma iletişim kutusu.
 * Birim: her kod × her düğme, yedek yolu doğrulaması, kopyalama/taşıma/yerine koyma hataları ve geri alma, yeniden
 * deneme sınırı (sahte dosya sistemi; gerçek iletişim kutusu yok).
 * Entegrasyon: gerçek `scripts/migrate.ts` bozuk bir geçişle başarısız olur → sonuç dosyası → "güncelleme öncesi
 * yedeğe dön" gerçek dosyalarla çalışır → veritabanı yedekteki hâline döner, önceki dosya silinmeden kenara alınır.
 * Yalnızca geçici klasörler.
 */

const DATA = path.resolve("/um-test/data");
const LOGS = path.resolve("/um-test/logs");
const BACKUPS = path.join(DATA, "backups");
const DB = path.join(DATA, MAIN_DB_FILENAME);
const PRE = path.join(BACKUPS, "pre-migrate-2026-11-16T10-00-00-000Z.db");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0, 0);
const STAMP = "2026-11-16T12-00-00-000Z";
const ASIDE = path.join(BACKUPS, `failed-migrate-${STAMP}.db`);

type Box = Parameters<MigrationRecoveryDeps["showMessageBox"]>[0];

interface Fake {
  deps: MigrationRecoveryDeps;
  files: Map<string, string>;
  boxes: Box[];
  opened: string[];
  logs: string[];
}

/**
 * Sahte bağımlılıklar: bellek içi dosya sistemi; iletişim kutusu yanıtları düğme ETİKETİYLE verilir (sıra değişse de
 * test doğru düğmeye basar); yanıt kalmadıysa iptal (Esc) sayılır.
 */
function fake(
  opts: {
    attempt?: number;
    answers?: string[];
    files?: Record<string, string>;
    failCopy?: (from: string) => boolean;
    failRename?: (from: string, to: string) => boolean;
    dbInUse?: () => boolean;
    remembered?: string | null;
  } = {},
): Fake {
  const files = new Map(Object.entries(opts.files ?? {}));
  const boxes: Box[] = [];
  const opened: string[] = [];
  const logs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const deps: MigrationRecoveryDeps = {
    dataDir: DATA,
    logDir: LOGS,
    attempt: opts.attempt ?? 1,
    exitCode: 1,
    rememberedBackup: opts.remembered ?? null,
    dbInUse: opts.dbInUse ?? (() => false),
    t: (key: TrKey, params?: Record<string, string | number>) => t(key, params, "tr"),
    showMessageBox: (spec) => {
      boxes.push(spec);
      const label = answers.shift();
      if (label === undefined) return spec.cancelId;
      const i = spec.buttons.indexOf(label);
      if (i < 0) throw new Error(`"${label}" düğmesi yok: ${spec.buttons.join(" | ")}`);
      return i;
    },
    showErrorBox: () => {
      throw new Error("genel hata kutusu kullanılmamalı");
    },
    openPath: (p) => opened.push(p),
    exists: (p) => files.has(p),
    copyFile: (from, to) => {
      if (opts.failCopy?.(from))
        throw Object.assign(new Error("ENOSPC: yer yok"), { code: "ENOSPC" });
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, v);
    },
    rename: (from, to) => {
      if (opts.failRename?.(from, to)) throw new Error(`EPERM ${from}`);
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    readdir: () => [],
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { deps, files, boxes, opened, logs };
}

const L = {
  retry: t("electron.migrate.btn.retry", undefined, "tr"),
  restore: t("electron.migrate.btn.restore", undefined, "tr"),
  logs: t("electron.migrate.btn.logs", undefined, "tr"),
  quit: t("electron.migrate.btn.quit", undefined, "tr"),
  yes: t("electron.migrate.confirm.yes", undefined, "tr"),
  no: t("electron.migrate.confirm.no", undefined, "tr"),
  ok: t("electron.migrate.btn.ok", undefined, "tr"),
};
const FAILURE_CODES = MIGRATE_RESULT_CODES.filter((c) => c !== "OK") as Exclude<
  MigrateResultCode,
  "OK"
>[];
const result = (code: MigrateResultCode, backupPath?: string): MigrateResult => ({
  v: 1,
  ok: false,
  code,
  applied: 0,
  total: 7,
  at: NOW,
  ...(backupPath ? { backupPath } : {}),
});
/** Canlı veritabanı (+ -wal/-shm) ve güncelleme öncesi yedek (+ -wal). */
const LIVE = {
  [DB]: "canli",
  [`${DB}-wal`]: "canli-wal",
  [`${DB}-shm`]: "canli-shm",
  [PRE]: "yedek",
  [`${PRE}-wal`]: "yedek-wal",
};

/** Koda göre beklenen düğmeler (yedek varken, ilk deneme). */
const EXPECTED_BUTTONS: Record<(typeof FAILURE_CODES)[number], string[]> = {
  BLOCKED: [L.retry, L.logs, L.quit], // başka süreç açıkken yedeğe dönüş YOK
  DISK_FULL: [L.retry, L.restore, L.logs, L.quit],
  FAILED: [L.retry, L.restore, L.logs, L.quit],
  CORRUPT: [L.restore, L.logs, L.quit], // yeniden deneme düzeltmez
  VERIFY_FAILED: [L.restore, L.logs, L.quit], // geçiş zaten uygulandı
};
const RETRYABLE = FAILURE_CODES.filter((c) => RETRYABLE_CODES.has(c));
const RESTORABLE = FAILURE_CODES.filter((c) => c !== "BLOCKED");

describe("iletişim kutusu: her kod × her düğme", () => {
  it.each(FAILURE_CODES)(
    "%s: başlık, koda özel metin, koda özel düğmeler ve Esc = Çık",
    async (code) => {
      const f = fake({ files: LIVE });
      expect(await handleMigrationFailure(result(code, PRE), f.deps)).toBe("quit");
      expect(f.boxes).toHaveLength(1);
      const b = f.boxes[0]!;
      expect(b.title).toBe("Veritabanı güncellenemedi");
      expect(b.message).toBe(t(`electron.migrate.body.${code}` as TrKey, undefined, "tr"));
      expect(b.buttons).toEqual(EXPECTED_BUTTONS[code]);
      expect(b.cancelId).toBe(b.buttons.indexOf(L.quit));
      // Enter: yeniden deneme varsa o, yoksa yedeğe dönüş (onu ayrıca onay izler).
      expect(b.buttons[b.defaultId]).toBe(RETRYABLE_CODES.has(code) ? L.retry : L.restore);
      expect(b.noLink).toBe(true);
      if (code === "BLOCKED") {
        expect(b.detail).not.toContain(t("electron.migrate.backupAvailable", undefined, "tr"));
        expect(b.detail).not.toContain(t("electron.migrate.noBackup", undefined, "tr"));
      } else expect(b.detail).toContain(t("electron.migrate.backupAvailable", undefined, "tr"));
      expect(b.detail).toContain(LOGS);
      // Dosyalara dokunulmadı.
      expect(Object.fromEntries(f.files)).toEqual(LIVE);
    },
  );

  it.each(RETRYABLE)("%s: Yeniden dene → retry; Çık → quit", async (code) => {
    expect(
      await handleMigrationFailure(
        result(code, PRE),
        fake({ files: LIVE, answers: [L.retry] }).deps,
      ),
    ).toBe("retry");
    expect(
      await handleMigrationFailure(
        result(code, PRE),
        fake({ files: LIVE, answers: [L.quit] }).deps,
      ),
    ).toBe("quit");
  });

  it.each(["VERIFY_FAILED", "CORRUPT"] as const)(
    "%s: Yeniden dene YOK (geçiş uygulanmış/dosya bozuk); Enter yedeğe dönüşe, yedek yoksa Çık'a gider",
    async (code) => {
      for (const attempt of [1, 2, 3]) {
        const f = fake({ attempt, files: LIVE });
        f.deps.showMessageBox = (spec) => (f.boxes.push(spec), spec.defaultId); // kullanıcı hep Enter'a basar
        // Enter → yedeğe dön → onay kutusunda Enter = Vazgeç → ana kutuya döner; döngü sınırında çıkılır. Asla retry yok.
        expect(await handleMigrationFailure(result(code, PRE), f.deps)).toBe("quit");
        expect(f.boxes.every((b) => !b.buttons.includes(L.retry))).toBe(true);
        expect(Object.fromEntries(f.files)).toEqual(LIVE); // onaysız hiçbir dosya değişmedi
        expect(f.boxes[0]!.detail).not.toContain(
          t("electron.migrate.retryExhausted", undefined, "tr"),
        );
      }
      const none = fake({ files: { [DB]: "canli" } });
      await handleMigrationFailure(result(code), none.deps);
      expect(none.boxes[0]!.buttons).toEqual([L.logs, L.quit]);
      expect(none.boxes[0]!.defaultId).toBe(1); // Çık
    },
  );

  it.each(FAILURE_CODES)(
    "%s: Günlük klasörünü aç → klasör açılır, iletişim kutusu yeniden gösterilir",
    async (code) => {
      const f = fake({ files: LIVE, answers: [L.logs, L.logs, L.quit] });
      expect(await handleMigrationFailure(result(code, PRE), f.deps)).toBe("quit");
      expect(f.opened).toEqual([LOGS, LOGS]);
      expect(f.boxes).toHaveLength(3);
    },
  );

  it.each(RESTORABLE)(
    "%s: yedeğe dön → onay → dosyalar yer değiştirir, bilgi verilir, quit",
    async (code) => {
      const f = fake({ files: LIVE, answers: [L.restore, L.yes, L.ok] });
      expect(await handleMigrationFailure(result(code, PRE), f.deps)).toBe("quit");
      expect(Object.fromEntries(f.files)).toEqual({
        [DB]: "yedek",
        [`${DB}-wal`]: "yedek-wal",
        [ASIDE]: "canli",
        [`${ASIDE}-wal`]: "canli-wal",
        [`${ASIDE}-shm`]: "canli-shm",
        [PRE]: "yedek",
        [`${PRE}-wal`]: "yedek-wal",
      });
      expect(f.boxes.map((b) => b.type)).toEqual(["error", "warning", "info"]);
      expect(f.boxes[1]!.message).toContain(`failed-migrate-${STAMP}.db`);
      expect(f.boxes[1]!.cancelId).toBe(1); // Esc = Vazgeç
      expect(f.boxes[1]!.defaultId).toBe(1); // Enter = Vazgeç
      expect(f.boxes[2]!.title).toBe(t("electron.migrate.restored.title", undefined, "tr"));
      expect(f.boxes[2]!.message).toContain("Universal Mail sürümünü yeniden kurun");
    },
  );

  it("BLOCKED: hatırlanan yedek olsa bile yedeğe dönüş sunulmaz", async () => {
    const f = fake({ files: LIVE, remembered: PRE });
    await handleMigrationFailure(result("BLOCKED", PRE), f.deps);
    expect(f.boxes[0]!.buttons).not.toContain(L.restore);
  });

  it("onaydan sonra veritabanı başka bir süreçte açıksa dosyalara dokunulmaz, kullanıcıya söylenir", async () => {
    let checks = 0;
    const f = fake({
      files: LIVE,
      answers: [L.restore, L.yes, L.ok, L.quit],
      dbInUse: () => (checks++, true),
    });
    expect(await handleMigrationFailure(result("FAILED", PRE), f.deps)).toBe("quit");
    expect(checks).toBe(1);
    expect(Object.fromEntries(f.files)).toEqual(LIVE);
    expect(f.boxes.map((b) => b.type)).toEqual(["error", "warning", "warning", "error"]);
    expect(f.boxes[2]!.title).toBe(t("electron.migrate.inUse.title", undefined, "tr"));
    expect(f.boxes[2]!.message).toBe(t("electron.migrate.inUse.body", undefined, "tr"));
  });

  it("CORRUPT metni yedeğin de bozuk olabileceğini, şifreli yedeklerin yerini ve veri klasörünü söyler", async () => {
    const f = fake({ files: { [DB]: "canli" } });
    await handleMigrationFailure(result("CORRUPT"), f.deps);
    for (const lang of ["tr", "en"] as const) {
      const body = t("electron.migrate.body.CORRUPT", undefined, lang);
      expect(body).toContain(".umbk");
      expect(body).toContain("backups");
      expect(body).not.toMatch(/dönebilir|can go back/);
    }
    expect(f.boxes[0]!.detail).toContain(DATA);
  });

  it("sonuç dosyası yoksa genel hata metni ve yedek düğmesi yok", async () => {
    const f = fake({ files: LIVE });
    await handleMigrationFailure(null, f.deps);
    expect(f.boxes[0]!.message).toBe(t("electron.migrate.body.FAILED", undefined, "tr"));
    expect(f.boxes[0]!.buttons).toEqual([L.retry, L.logs, L.quit]);
    expect(f.boxes[0]!.detail).toContain(t("electron.migrate.noBackup", undefined, "tr"));
    expect(failureCode(null)).toBe("FAILED");
    expect(failureCode({ ...result("OK"), ok: true })).toBe("FAILED");
  });

  it("onayda Vazgeç: hiçbir dosya değişmez ve ana iletişim kutusuna dönülür", async () => {
    const f = fake({ files: LIVE, answers: [L.restore, L.no, L.quit] });
    expect(await handleMigrationFailure(result("CORRUPT", PRE), f.deps)).toBe("quit");
    expect(Object.fromEntries(f.files)).toEqual(LIVE);
    expect(f.boxes.map((b) => b.type)).toEqual(["error", "warning", "error"]);
  });

  it("İngilizce arayüzde düğmeler ve metin İngilizce", async () => {
    const f = fake({ files: LIVE });
    f.deps.t = (key, params) => t(key, params, "en");
    await handleMigrationFailure(result("DISK_FULL", PRE), f.deps);
    expect(f.boxes[0]!.title).toBe("The database could not be updated");
    expect(f.boxes[0]!.buttons).toEqual([
      "Try again",
      "Go back to the pre-update backup",
      "Open the log folder",
      "Quit",
    ]);
    expect(f.boxes[0]!.message).toMatch(/free disk space/);
  });
});

describe("yedek yolu doğrulaması", () => {
  const files = { ...LIVE };
  it.each([
    ["veri klasörü dışı", path.resolve("/baska/backups/pre-migrate-2026.db")],
    ["alt klasör", path.join(BACKUPS, "alt", "pre-migrate-2026.db")],
    ["başka ad", path.join(BACKUPS, "manual-2026.db")],
    ["yedek uzantısı değil", path.join(BACKUPS, "pre-migrate-2026.db-wal")],
    ["göreli kaçış", `${BACKUPS}/../pre-migrate-2026.db`],
    ["diskte yok", path.join(BACKUPS, "pre-migrate-yok.db")],
  ])("%s → yedek düğmesi gösterilmez", async (_name, p) => {
    const f = fake({ files: { ...files, [p]: "x" } });
    if (_name === "diskte yok") f.files.delete(p);
    expect(restorableBackup(result("CORRUPT", p), f.deps)).toBeNull();
    await handleMigrationFailure(result("CORRUPT", p), f.deps);
    expect(f.boxes[0]!.buttons).not.toContain(L.restore);
  });

  it("ilk kurulumda (yedek yok) yedek düğmesi yok", async () => {
    const f = fake({ files: { [DB]: "yeni" } });
    await handleMigrationFailure(result("FAILED"), f.deps);
    expect(f.boxes[0]!.buttons).toEqual([L.retry, L.logs, L.quit]);
  });

  it("geçerli yol kabul edilir", () => {
    expect(restorableBackup(result("FAILED", PRE), fake({ files: LIVE }).deps)).toBe(PRE);
  });

  it("yedek dosyası günlük klasörü açılırken taşınırsa düğme kaybolur", async () => {
    const f = fake({ files: LIVE, answers: [L.logs] });
    f.deps.openPath = () => f.files.delete(PRE);
    await handleMigrationFailure(result("CORRUPT", PRE), f.deps);
    expect(f.boxes[0]!.buttons).toContain(L.restore);
    expect(f.boxes[1]!.buttons).not.toContain(L.restore);
  });
});

describe("yedeğe dönüş hataları: hiçbir dosya silinmez", () => {
  it("kopya hazırlanamazsa canlı dosyalara dokunulmaz; kullanıcıya söylenir", async () => {
    const f = fake({
      files: LIVE,
      answers: [L.restore, L.yes, L.ok, L.quit],
      failCopy: () => true,
    });
    expect(await handleMigrationFailure(result("CORRUPT", PRE), f.deps)).toBe("quit");
    expect(Object.fromEntries(f.files)).toEqual(LIVE);
    const err = f.boxes[2]!;
    expect(err.title).toBe(t("electron.migrate.restoreFailed.title", undefined, "tr"));
    expect(err.message).toBe(t("electron.migrate.restoreFailed.body", undefined, "tr"));
    expect(err.detail).toContain(DATA);
    // Hata sonrası ana iletişim kutusu yeniden gösterildi (kullanıcı çıkabildi).
    expect(f.boxes[3]!.title).toBe("Veritabanı güncellenemedi");
  });

  it("kenara alma yarıda kalırsa yapılan taşımalar geri alınır", () => {
    const f = fake({ files: LIVE, failRename: (from) => from === `${DB}-shm` });
    const r = restorePreMigrateBackup(PRE, f.deps, NOW);
    expect(r).toEqual({ ok: false, step: "move", rolledBack: true });
    // Canlı dosyalar yerinde; yalnızca hazırlanan kopya (silinmeden) kaldı.
    for (const [p, v] of Object.entries(LIVE)) expect(f.files.get(p), p).toBe(v);
    expect([...f.files.keys()].filter((p) => p.startsWith(ASIDE))).toEqual([]);
  });

  it("yerine koyma yarıda kalırsa önceki veritabanı geri gelir", () => {
    let failed = false;
    const f = fake({
      files: LIVE,
      // Yalnızca yedeğin -wal dosyasını yerine koyma adımı (bir kez) başarısız olur; geri alma çalışır.
      failRename: (from, to) =>
        !failed && to === `${DB}-wal` && (failed = from.includes(".restore-")),
    });
    const r = restorePreMigrateBackup(PRE, f.deps, NOW);
    expect(r).toEqual({ ok: false, step: "place", rolledBack: true });
    for (const [p, v] of Object.entries(LIVE)) expect(f.files.get(p), p).toBe(v);
  });

  it("geri alma da başarısızsa 'yarıda kaldı' metni gösterilir", async () => {
    let placeFailed = false;
    const f = fake({
      files: LIVE,
      answers: [L.restore, L.yes, L.ok, L.quit],
      failRename: (from, to) => {
        if (to === `${DB}-wal`) {
          placeFailed = true;
          return true;
        }
        return placeFailed && from.startsWith(ASIDE); // geri alma adımı başarısız
      },
    });
    expect(await handleMigrationFailure(result("VERIFY_FAILED", PRE), f.deps)).toBe("quit");
    expect(f.boxes[2]!.message).toBe(t("electron.migrate.restoreFailed.partial", undefined, "tr"));
    // Yine de hiçbir içerik kaybolmadı: her değer bir dosyada duruyor.
    const values = new Set(f.files.values());
    for (const v of ["canli", "canli-wal", "canli-shm", "yedek", "yedek-wal"])
      expect(values).toContain(v);
  });

  it("yedeğin -wal dosyası yoksa yalnızca ana dosya yerine konur", () => {
    const files = { [DB]: "canli", [PRE]: "yedek" };
    const f = fake({ files });
    expect(restorePreMigrateBackup(PRE, f.deps, NOW)).toEqual({ ok: true, movedTo: ASIDE });
    expect(Object.fromEntries(f.files)).toEqual({
      [DB]: "yedek",
      [ASIDE]: "canli",
      [PRE]: "yedek",
    });
  });
});

describe("aynı açılıştaki önceki yedek hatırlanır", () => {
  it("2. denemede kopya alınamadı (disk dolu, sonuçta yedek yok): yedeğe dönüş yine sunulur", async () => {
    const files = { ...LIVE };
    // main.ts runMigrateChild ile aynı akış.
    let remembered: string | null = null;
    const attempts = [result("DISK_FULL", PRE), result("DISK_FULL"), null];
    const boxes: Box[][] = [];
    for (const [i, res] of attempts.entries()) {
      const f = fake({ attempt: i + 1, files, answers: [] });
      remembered = rememberBackup(res, remembered, f.deps);
      f.deps.rememberedBackup = remembered;
      await handleMigrationFailure(res, f.deps);
      boxes.push(f.boxes);
    }
    expect(remembered).toBe(PRE);
    for (const b of boxes) expect(b[0]!.buttons).toContain(L.restore);
  });

  it("hatırlanan yedek diskten silinmişse veya geçersizse kullanılmaz", () => {
    const f = fake({ files: { [DB]: "canli" } });
    expect(rememberBackup(result("FAILED"), PRE, f.deps)).toBeNull();
    expect(restorableBackup(result("FAILED"), { ...f.deps, rememberedBackup: PRE })).toBeNull();
    const g = fake({ files: { ...LIVE, "/baska/pre-migrate-1.db": "x" } });
    expect(rememberBackup(result("FAILED"), "/baska/pre-migrate-1.db", g.deps)).toBeNull();
    // Bu denemenin geçerli yedeği öncekinden önceliklidir.
    const NEWER = path.join(BACKUPS, "pre-migrate-2026-11-16T11-00-00-000Z.db");
    const h = fake({ files: { ...LIVE, [NEWER]: "y" } });
    expect(rememberBackup(result("FAILED", NEWER), PRE, h.deps)).toBe(NEWER);
  });
});

describe("yeniden deneme sınırı", () => {
  it(`ilk ${MIGRATION_RETRY_DIALOGS} gösterimde Yeniden dene var; sonrasında yalnızca yedek/günlük/çık`, async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const f = fake({ attempt, files: LIVE });
      await handleMigrationFailure(result("FAILED", PRE), f.deps);
      const has = f.boxes[0]!.buttons.includes(L.retry);
      expect(has, `deneme ${attempt}`).toBe(attempt <= MIGRATION_RETRY_DIALOGS);
      if (!has) {
        expect(f.boxes[0]!.buttons).toEqual([L.restore, L.logs, L.quit]);
        expect(f.boxes[0]!.detail).toContain(t("electron.migrate.retryExhausted", undefined, "tr"));
      }
    }
  });

  it("ana sürecin döngüsü: kullanıcı hep ilk düğmeye bassa da en çok 2 yeniden deneme olur", async () => {
    // electron/main.ts runMigrateChild ile aynı: başarısızlıkta işleyiciyi çağırır, "retry" ise yeniden dener.
    let spawns = 0;
    for (let attempt = 1; ; attempt++) {
      spawns++; // geçiş alt süreci (hep başarısız)
      const f = fake({ attempt, files: { [DB]: "yeni" } });
      f.deps.showMessageBox = (spec) => (f.boxes.push(spec), 0);
      const action = await handleMigrationFailure(result("FAILED"), f.deps);
      if (action !== "retry") break;
      expect(attempt).toBeLessThan(10);
    }
    expect(spawns).toBe(MIGRATION_RETRY_DIALOGS + 1);
    expect(spawns).toBeLessThan(4); // main.ts MIGRATION_MAX_ATTEMPTS: genel kutuya hiç düşülmez
  });

  it("günlük klasörü sonsuz kez açılmaya çalışılsa da döngü sınırlıdır", async () => {
    const f = fake({ files: LIVE });
    f.deps.showMessageBox = (spec) => (f.boxes.push(spec), spec.buttons.indexOf(L.logs));
    expect(await handleMigrationFailure(result("FAILED", PRE), f.deps)).toBe("quit");
    expect(f.opened.length).toBeGreaterThan(5);
    expect(f.opened.length).toBeLessThanOrEqual(25);
  });
});

/* --------------------------- gerçek dosyalarla uçtan uca --------------------------- */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const REPO = path.resolve(__dirname, "..");
const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function runMigrateScript(dataDir: string, migrations: string): Promise<number> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("UM_")) env[k] = v;
  Object.assign(env, {
    UM_DATA_DIR: dataDir,
    UM_MIGRATIONS_DIR: migrations,
    UM_STATIC_DATA_DIR: path.join(REPO, "data"),
    UM_MASTER_KEY: "ab".repeat(32),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "scripts", "migrate.ts")],
      { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function realDeps(
  dataDir: string,
  logDir: string,
  answers: string[],
  boxes: Box[],
): MigrationRecoveryDeps {
  return {
    dataDir,
    logDir,
    attempt: 1,
    exitCode: 1,
    dbInUse: () => false,
    t: (key, params) => t(key, params, "tr"),
    showMessageBox: (spec) => {
      boxes.push(spec);
      const label = answers.shift();
      return label === undefined ? spec.cancelId : spec.buttons.indexOf(label);
    },
    showErrorBox: () => undefined,
    openPath: () => undefined,
    exists: (p) => fs.existsSync(p),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    rename: (from, to) => fs.renameSync(from, to),
    readdir: (d) => fs.readdirSync(d),
    now: () => Date.now(),
    log: () => undefined,
  };
}

describe("uçtan uca: bozuk güncelleme → yedeğe dönüş (gerçek dosyalar)", () => {
  it("geçiş alt süreci başarısız olur, sonuç dosyası yedeği gösterir, yedeğe dönüş veriyi geri getirir", async () => {
    const dataDir = fs.mkdtempSync(path.join(tmpBase, "um-rec-"));
    const old = partialMigrations(TOTAL_MIGRATIONS - 1, "um-rec-old-");
    const broken = brokenLastMigration("um-rec-bad-");
    cleanup.push(dataDir, old, broken);
    const dbFile = path.join(dataDir, MAIN_DB_FILENAME);

    // Eski sürüm: veri dolu veritabanı.
    process.env.UM_DATA_DIR = dataDir;
    process.env.UM_DB_PATH = dbFile;
    process.env.UM_MIGRATIONS_DIR = old;
    const h = await openDatabase(dbFile);
    await runMigrations(h.db, h.client);
    await h.client.executeMultiple(
      fs.readFileSync(path.join(__dirname, "fixtures", "schema", "0000.sql"), "utf8"),
    );
    h.client.close();

    // Yeni (bozuk) sürümün açılışı.
    expect(await runMigrateScript(dataDir, broken)).toBe(1);
    const res = readMigrateResult(dataDir);
    expect(res).toMatchObject({ ok: false, code: "FAILED", applied: 0 });
    expect(res!.backupPath).toMatch(/pre-migrate-[^/\\]+\.db$/);

    // Başarısız açılıştan sonra canlı dosyada bir değişiklik olduğunu varsay (ör. kısmen uygulanmış geçiş).
    const live = await openDatabase(dbFile);
    await live.client.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('fx.after', '1', 1)",
    );
    await live.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    live.client.close();

    const boxes: Box[] = [];
    const deps = realDeps(dataDir, path.join(dataDir, "logs"), [L.restore, L.yes, L.ok], boxes);
    expect(await handleMigrationFailure(res, deps)).toBe("quit");
    expect(boxes.map((b) => b.type)).toEqual(["error", "warning", "info"]);

    // Veritabanı yedekteki hâlinde: fikstür verisi var, sonradan eklenen satır yok, geçiş sayısı eski.
    const back = await openDatabase(dbFile);
    const one = async (sql: string) => (await back.client.execute(sql)).rows[0]?.[0];
    expect(await one("SELECT COUNT(*) FROM leads")).toBe(3);
    expect(await one("SELECT COUNT(*) FROM settings WHERE key = 'fx.after'")).toBe(0);
    expect(await one("SELECT COUNT(*) FROM __drizzle_migrations")).toBe(TOTAL_MIGRATIONS - 1);
    expect(await one("PRAGMA integrity_check")).toBe("ok");
    back.client.close();
    // Önceki dosya silinmedi: kenara alınan kopyada sonradan eklenen satır duruyor.
    const aside = fs
      .readdirSync(path.join(dataDir, "backups"))
      .filter((n) => /^failed-migrate-.+\.db$/.test(n));
    expect(aside).toHaveLength(1);
    const kept = await openDatabase(path.join(dataDir, "backups", aside[0]!));
    expect(
      (await kept.client.execute("SELECT COUNT(*) FROM settings WHERE key = 'fx.after'"))
        .rows[0]?.[0],
    ).toBe(1);
    kept.client.close();
    // Güncelleme öncesi yedek de yerinde (kopyalandı, taşınmadı).
    expect(fs.existsSync(res!.backupPath!)).toBe(true);

    // Düzeltilmiş sürüm kurulunca açılış başarılı olur.
    expect(await runMigrateScript(dataDir, SOURCE_MIGRATIONS)).toBe(0);
    expect(readMigrateResult(dataDir)).toMatchObject({ ok: true, code: "OK", applied: 1 });
  }, 90_000);

  it("VERIFY_FAILED: yeniden çalıştırma da VERIFY_FAILED + aynı yedek döner (bozuk veritabanıyla açılmaz); Yeniden dene sunulmaz", async () => {
    const dataDir = fs.mkdtempSync(path.join(tmpBase, "um-rec-v-"));
    const old = partialMigrations(TOTAL_MIGRATIONS - 1, "um-rec-vold-");
    cleanup.push(dataDir, old);
    const dbFile = path.join(dataDir, MAIN_DB_FILENAME);
    process.env.UM_DATA_DIR = dataDir;
    process.env.UM_DB_PATH = dbFile;
    process.env.UM_MIGRATIONS_DIR = old;
    const h = await openDatabase(dbFile);
    await runMigrations(h.db, h.client);
    await h.client.execute("PRAGMA foreign_keys = OFF");
    await h.client.execute(
      "INSERT INTO place_snapshots (scan_id, place_id, was_future) VALUES (424242, 'p-1', 0)",
    );
    await h.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    h.client.close();

    expect(await runMigrateScript(dataDir, SOURCE_MIGRATIONS)).toBe(1);
    const first = readMigrateResult(dataDir);
    expect(first).toMatchObject({ ok: false, code: "VERIFY_FAILED" });
    expect(first!.backupPath).toMatch(/pre-migrate-[^/\\]+\.db$/);
    // Uygulamayı kapatıp yeniden açma (veya eski davranıştaki "Yeniden dene"): yine başarısız, aynı yedek.
    expect(await runMigrateScript(dataDir, SOURCE_MIGRATIONS)).toBe(1);
    const second = readMigrateResult(dataDir);
    expect(second).toMatchObject({ ok: false, code: "VERIFY_FAILED" });
    expect(second!.backupPath).toBe(first!.backupPath);

    const boxes: Box[] = [];
    await handleMigrationFailure(second, realDeps(dataDir, path.join(dataDir, "logs"), [], boxes));
    expect(boxes[0]!.buttons).toEqual([L.restore, L.logs, L.quit]);
    expect(boxes[0]!.defaultId).toBe(0);
  }, 90_000);
});
