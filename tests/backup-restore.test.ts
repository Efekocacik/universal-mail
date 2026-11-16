import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleError } from "@/lib/backup/errors";
import { writeEncryptedBackup } from "@/lib/backup/format";
import {
  cancelStage,
  readStage,
  scheduleRestore,
  STAGE_TTL_MS,
  verifyAndStage,
} from "@/lib/backup/restore";
import { backupFilePath, createBackup, snapshotDatabase } from "@/lib/backup/service";
import { toLibsqlUrl } from "@/lib/config/paths";
import { auditLog, backups } from "@/lib/db/schema";
import {
  createPending,
  newNonce,
  PENDING_FILE,
  readPending,
  readResult,
  stageDirOf,
} from "@/lib/lifecycle/pending";
import { runPostInitHooks, runPreInitHooks } from "@/lib/lifecycle/pre-init";
import { cancelPending, scheduleWipe } from "@/lib/lifecycle/service";
import { BACKUP_PASSPHRASE_SECRET, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { backupEnv, dumpTables, insertLead, TEST_PASS, type BackupEnv } from "./helpers/backup-env";

/**
 * Paket Y.3/Y.6: geri yükleme ve silme yeniden başlatmada uygulanır. Yedek → sil → geri yükle eşitliği (başka ana
 * anahtarla, gizli bilgiler yeniden şifrelenir), eski şemalı (0004) yedeğin geri yüklenip güncellenmesi, daha yeni
 * şemanın reddi, hazırlık süresi, eksik hazırlıkta mevcut verinin korunması ve bozuk işaretin yok sayılması.
 */

const REPO = path.resolve(__dirname, "..");
const T = Date.UTC(2026, 10, 16, 9, 0, 0);
let env: BackupEnv;
const logs: string[] = [];
const log = (m: string) => logs.push(m);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof LifecycleError ? e.code : `OTHER:${(e as Error).message}`;
  }
};

function partialMigrations(count: number): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "um-mig-y-"));
  fs.mkdirSync(path.join(d, "meta"));
  const journal = JSON.parse(
    fs.readFileSync(path.join(REPO, "drizzle", "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(d, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as { tag: string }[])
    fs.copyFileSync(path.join(REPO, "drizzle", `${e.tag}.sql`), path.join(d, `${e.tag}.sql`));
  return d;
}
const UPTO_0004 = partialMigrations(5);
afterAll(() => fs.rmSync(UPTO_0004, { recursive: true, force: true }));

/** Yeniden başlatma benzetimi: bağlantı kapanır → ön kanca → açılış + migrasyon → son kanca. */
async function restart() {
  await env.close();
  const pre = await runPreInitHooks({ dataDir: env.dir, log, now: T + 60_000 });
  await env.reopen();
  await runPostInitHooks(env.db, pre);
  return pre;
}

beforeEach(async () => {
  logs.length = 0;
  env = await backupEnv();
  await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
});
afterEach(async () => {
  await env.done();
});

describe("yedek → tüm verileri sil → geri yükle", () => {
  it("veriler bire bir geri gelir; gizli bilgiler YENİ ana anahtarla açılır; yedek parolası geri gelir", async () => {
    const raw = env.raw();
    for (let i = 0; i < 25; i++)
      await insertLead(raw, { createdAt: T - i * 1000, name: `Kafe ${i}` });
    await setSetting(env.db, "budget.monthlyUsd", 123);
    await setSecret("google.placesKey", "AIza-gidis-donus");
    const before = await dumpTables(env.client);
    const made = await createBackup(env.db, { kind: "manual", now: T });
    const file = backupFilePath(made.backup)!;

    // Tüm verilerimi sil (yedekler kalsın) → yeniden başlat: ilk kurulum durumu.
    await scheduleWipe(env.db, { confirm: "verilerimi sil", deleteBackups: false, now: T });
    expect((await restart()).applied).toEqual({ kind: "wipe", ok: true });
    expect(Number((await env.client.execute("SELECT COUNT(*) FROM leads")).rows[0]![0])).toBe(0);
    expect(await getSetting(env.db, "setup.completed")).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(env.dir, "secrets.json"))).toBe(false);
    expect(readResult(env.dir)).toMatchObject({ kind: "wipe", ok: true });

    // Başka bir makine: farklı ana anahtar.
    process.env.UM_MASTER_KEY = "cd".repeat(32);
    expect(
      await code(
        verifyAndStage(env.db, {
          source: { kind: "path", path: file },
          passphrase: "yanlış-parola-1",
        }),
      ),
    ).toBe("BACKUP_WRONG_PASSPHRASE");
    const v = await verifyAndStage(env.db, {
      source: { kind: "path", path: file },
      passphrase: TEST_PASS,
      now: T,
    });
    expect(v.summary.counts.leads).toBe(25);
    expect(v.summary.kind).toBe("manual");
    expect(v.hasSecrets).toBe(true);
    expect(v.migrationNeeded).toBe(false);
    await scheduleRestore(env.db, {
      stageId: v.stageId,
      confirm: true,
      restoreSecrets: true,
      now: T,
    });
    expect(readPending(env.dir)).toMatchObject({
      kind: "restore",
      stageId: v.stageId,
      restoreSecrets: true,
    });
    expect(
      await code(
        scheduleRestore(env.db, {
          stageId: v.stageId,
          confirm: true,
          restoreSecrets: true,
          now: T,
        }),
      ),
    ).toBe("LIFECYCLE_PENDING");

    const pre = await restart();
    expect(pre.applied).toEqual({ kind: "restore", ok: true });
    expect(await dumpTables(env.client)).toEqual(before);
    expect(await getSecret("google.placesKey")).toBe("AIza-gidis-donus");
    expect(await getSecret(BACKUP_PASSPHRASE_SECRET)).toBe(TEST_PASS);
    expect(readPending(env.dir)).toBeNull();
    expect(fs.existsSync(stageDirOf(env.dir, v.stageId))).toBe(false);
    expect(readResult(env.dir)).toMatchObject({ kind: "restore", ok: true, secretsRestored: true });
    // Mevcut (boş) veritabanının ve gizli bilgilerin kopyası alındı.
    expect(
      fs.readdirSync(path.join(env.dir, "backups")).some((f) => /^pre-restore-.+\.db$/.test(f)),
    ).toBe(true);
    // Anlık görüntüdeki kendi "running" satırı kurtarıldı; yeni yedek hemen alınabilir.
    expect((await env.db.select().from(backups)).every((b) => b.status !== "running")).toBe(true);
    expect((await createBackup(env.db, { kind: "manual", now: T + 120_000 })).backup.status).toBe(
      "ok",
    );
    const audits = (await env.db.select().from(auditLog)).map((a) => a.action);
    expect(audits).toContain("data.restore.applied");
  });

  it("gizli bilgiler istenmezse mevcut depo korunur", async () => {
    await setSecret("google.placesKey", "AIza-eski");
    const made = await createBackup(env.db, { kind: "manual", now: T });
    await setSecret("google.placesKey", "AIza-yeni");
    const v = await verifyAndStage(env.db, {
      source: { kind: "backup", id: made.backup.id },
      passphrase: TEST_PASS,
      now: T,
    });
    await scheduleRestore(env.db, {
      stageId: v.stageId,
      confirm: true,
      restoreSecrets: false,
      now: T,
    });
    await restart();
    expect(await getSecret("google.placesKey")).toBe("AIza-yeni");
    expect(readResult(env.dir)).toMatchObject({ ok: true, secretsRestored: false });
  });
});

describe("şema sürümü", () => {
  it("0004 şemalı eski yedek geri yüklenir ve açılışta güncel şemaya taşınır (veri korunur)", async () => {
    const oldFile = path.join(env.dir, "old.db");
    const oc = createClient({ url: toLibsqlUrl(oldFile) });
    await oc.execute("PRAGMA foreign_keys = ON");
    await migrate(drizzle(oc), { migrationsFolder: UPTO_0004 });
    await insertLead(oc, { createdAt: T, name: "Eski Şema Kafe" });
    oc.close();
    const snap = path.join(env.dir, "old-snap.db");
    const n = await snapshotDatabase(snap, oldFile);
    expect(n).toBe(5);
    const bytes = fs.readFileSync(snap);
    const umbk = path.join(env.dir, "eski.umbk");
    await writeEncryptedBackup({
      passphrase: TEST_PASS,
      meta: {
        app: "universal-mail",
        appVersion: "0.0.9",
        createdAt: T - 86_400_000,
        kind: "weekly",
        schemaMigrations: 5,
        includesSecrets: false,
        compression: "gzip",
      },
      manifest: {
        dbBytes: bytes.length,
        dbSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      },
      dbFile: snap,
      out: fs.createWriteStream(umbk),
      log2N: 14,
    });
    const v = await verifyAndStage(env.db, {
      source: { kind: "path", path: umbk },
      passphrase: TEST_PASS,
      now: T,
    });
    expect(v.migrationNeeded).toBe(true);
    expect(v.summary).toMatchObject({
      appVersion: "0.0.9",
      schemaMigrations: 5,
      includesSecrets: false,
    });
    expect(v.summary.counts.leads).toBe(1);
    await scheduleRestore(env.db, {
      stageId: v.stageId,
      confirm: true,
      restoreSecrets: true,
      now: T,
    });
    await restart();
    const total = JSON.parse(
      fs.readFileSync(path.join(REPO, "drizzle", "meta", "_journal.json"), "utf8"),
    ).entries.length;
    expect(
      Number((await env.client.execute("SELECT COUNT(*) FROM __drizzle_migrations")).rows[0]![0]),
    ).toBe(total);
    const names = await env.client.execute("SELECT display_name FROM leads");
    expect(names.rows.map((r) => r.display_name)).toEqual(["Eski Şema Kafe"]);
    // 0006 tablosu oluştu; geçiş öncesi otomatik kopya alındı. Listede yalnızca geri yükleme öncesi alınan şifreli
    // güvenlik yedeği var (diskten eşitlendi; geri dönüş yolu).
    expect(await env.db.select().from(backups)).toEqual([
      expect.objectContaining({ kind: "manual", status: "ok", createdAt: T }),
    ]);
    expect(
      fs.readdirSync(path.join(env.dir, "backups")).some((f) => f.startsWith("pre-migrate-")),
    ).toBe(true);
  });

  it("daha yeni şemalı yedek BACKUP_SCHEMA_NEWER ile reddedilir ve hazırlık kalmaz", async () => {
    const raw = env.raw();
    await raw.execute(
      "INSERT INTO __drizzle_migrations(hash, created_at) VALUES ('gelecek', 9999999999999)",
    );
    const made = await createBackup(env.db, { kind: "manual", now: T });
    await raw.execute("DELETE FROM __drizzle_migrations WHERE hash = 'gelecek'");
    expect(
      await code(
        verifyAndStage(env.db, {
          source: { kind: "backup", id: made.backup.id },
          passphrase: TEST_PASS,
        }),
      ),
    ).toBe("BACKUP_SCHEMA_NEWER");
    expect(fs.readdirSync(path.join(env.dir, "restore-staging"))).toEqual([]);
    const fail = (
      await env.db.select().from(auditLog).where(eq(auditLog.action, "backup.restore.verify"))
    )[0]!;
    expect(fail.detail).toMatchObject({ ok: false, code: "BACKUP_SCHEMA_NEWER" });
  });

  it("uygulama veritabanı olmayan (ama doğru şifrelenmiş) dosya reddedilir", async () => {
    const junk = path.join(env.dir, "junk.db");
    const jc = createClient({ url: toLibsqlUrl(junk) });
    await jc.execute("CREATE TABLE x(a)");
    jc.close();
    const bytes = fs.readFileSync(junk);
    const umbk = path.join(env.dir, "junk.umbk");
    await writeEncryptedBackup({
      passphrase: TEST_PASS,
      meta: {
        app: "universal-mail",
        appVersion: "0.1.0",
        createdAt: T,
        kind: "manual",
        schemaMigrations: 0,
        includesSecrets: false,
        compression: "gzip",
      },
      manifest: {
        dbBytes: bytes.length,
        dbSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      },
      dbFile: junk,
      out: fs.createWriteStream(umbk),
      log2N: 14,
    });
    expect(
      await code(
        verifyAndStage(env.db, { source: { kind: "path", path: umbk }, passphrase: TEST_PASS }),
      ),
    ).toBe("BACKUP_BAD_FORMAT");
    fs.writeFileSync(path.join(env.dir, "metin.txt"), "x");
    expect(
      await code(
        verifyAndStage(env.db, {
          source: { kind: "path", path: path.join(env.dir, "metin.txt") },
          passphrase: TEST_PASS,
        }),
      ),
    ).toBe("BACKUP_BAD_FORMAT");
    expect(
      await code(
        verifyAndStage(env.db, {
          source: { kind: "path", path: path.join(env.dir, "yok.umbk") },
          passphrase: TEST_PASS,
        }),
      ),
    ).toBe("BACKUP_FILE_MISSING");
  });
});

describe("hazırlık ve işaret güvenliği", () => {
  it("hazırlık 1 saat geçerli; süresi dolunca RESTORE_STAGE_NOT_FOUND; yeni doğrulama eskisini siler; iptal idempotent", async () => {
    const made = await createBackup(env.db, { kind: "manual", now: T });
    const src = { kind: "backup" as const, id: made.backup.id };
    const a = await verifyAndStage(env.db, { source: src, passphrase: TEST_PASS, now: T });
    expect(readStage(env.dir, a.stageId, T + STAGE_TTL_MS - 1)).not.toBeNull();
    expect(
      await code(
        scheduleRestore(env.db, {
          stageId: a.stageId,
          confirm: true,
          restoreSecrets: false,
          now: T + STAGE_TTL_MS + 1,
        }),
      ),
    ).toBe("RESTORE_STAGE_NOT_FOUND");
    expect(
      await code(
        scheduleRestore(env.db, {
          stageId: a.stageId,
          confirm: false,
          restoreSecrets: false,
          now: T,
        }),
      ),
    ).toBe("RESTORE_CONFIRM_REQUIRED");
    const b = await verifyAndStage(env.db, { source: src, passphrase: TEST_PASS, now: T });
    expect(fs.existsSync(stageDirOf(env.dir, a.stageId))).toBe(false);
    await scheduleRestore(env.db, {
      stageId: b.stageId,
      confirm: true,
      restoreSecrets: false,
      now: T,
    });
    // Bekleyen işlem varken yeni doğrulama ve silme planı reddedilir.
    expect(await code(verifyAndStage(env.db, { source: src, passphrase: TEST_PASS }))).toBe(
      "LIFECYCLE_PENDING",
    );
    expect(
      await code(scheduleWipe(env.db, { confirm: "DELETE MY DATA", deleteBackups: true })),
    ).toBe("LIFECYCLE_PENDING");
    expect(await cancelStage(env.db, b.stageId)).toBe(true);
    expect(readPending(env.dir)).toBeNull();
    expect(await cancelStage(env.db, b.stageId)).toBe(false);
    expect(await cancelStage(env.db, "../../etc")).toBe(false);
    expect(await cancelPending(env.db)).toBe(false);
  });

  it("hazırlık eksikse işaret silinir, sonuç ok:false, mevcut veritabanına dokunulmaz", async () => {
    await insertLead(env.raw(), { createdAt: T, name: "Kalmalı" });
    const before = await dumpTables(env.client);
    createPending(env.dir, {
      v: 1,
      kind: "restore",
      stageId: "a".repeat(32),
      restoreSecrets: true,
      at: T,
      nonce: newNonce(),
    });
    const pre = await restart();
    expect(pre.applied).toEqual({ kind: "restore", ok: false, code: "RESTORE_STAGE_NOT_FOUND" });
    expect(await dumpTables(env.client)).toEqual(before);
    expect(readPending(env.dir)).toBeNull();
    expect(readResult(env.dir)).toMatchObject({
      kind: "restore",
      ok: false,
      code: "RESTORE_STAGE_NOT_FOUND",
    });
  });

  it("bozuk işaret yok sayılır ve silinir; işaret yoksa hiçbir şey yapılmaz", async () => {
    fs.writeFileSync(path.join(env.dir, PENDING_FILE), "{bozuk");
    expect((await restart()).applied).toBeNull();
    expect(fs.existsSync(path.join(env.dir, PENDING_FILE))).toBe(false);
    fs.writeFileSync(
      path.join(env.dir, PENDING_FILE),
      JSON.stringify({ v: 1, kind: "wipe", deleteBackups: "evet" }),
    );
    expect((await restart()).applied).toBeNull();
    expect((await restart()).applied).toBeNull();
    expect(logs.some((l) => l.includes("bozuk"))).toBe(true);
  });
});
