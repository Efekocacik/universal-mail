import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { MaintenanceError } from "@/lib/db/maintenance";
import {
  MigrationBlockedError,
  MigrationVerificationError,
  runMigrations,
  VERIFY_PENDING_FILENAME,
  withBackupPath,
} from "@/lib/db/migrate";
import { FileLockTimeoutError, isFileLockHeld, withFileLock } from "@/lib/util/file-lock";
import {
  backupPathOf,
  classifyMigrationError,
  readMigrateResult,
  writeMigrateResult,
} from "@/lib/db/migrate-result";
import {
  brokenLastMigration,
  partialMigrations,
  SOURCE_MIGRATIONS,
  TOTAL_MIGRATIONS,
} from "./helpers/migration-dirs";

/**
 * Faz 6 (sözleşme K.2): GERÇEK geçiş hatalarının `migrate-result.json`'a doğru kodla ve geçiş öncesi yedeğin yoluyla
 * yansıması. Birim sınıflandırma ve dosya biçimi tests/faz6-p0.test.ts'te; burada uçtan uca:
 *   - dolu veritabanında bozuk geçiş SQL'i → hata `backupPath` taşır (K'nin migrate.ts eki), veritabanı değişmez, sonuç
 *     dosyası FAILED + yedek yolu;
 *   - veritabanı olmayan dosya → CORRUPT;
 *   - `withBackupPath`: dondurulmuş/ilkel hatada `cause` zinciri ve SQLite kodu korunur.
 * Yalnızca geçici klasörler.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const SOURCE = SOURCE_MIGRATIONS;
const LAST = TOTAL_MIGRATIONS;

const ENV = ["UM_DATA_DIR", "UM_DB_PATH", "UM_MIGRATIONS_DIR"] as const;
const saved: Record<string, string | undefined> = {};
const cleanup: string[] = [];
const clients: Client[] = [];
let dir = "";

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(tmpBase, "um-mr-"));
  cleanup.push(dir);
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = path.join(dir, "universal-mail.db");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("gerçek geçiş hatası → migrate-result.json", () => {
  it("bozuk geçiş: hata yedek yolunu taşır, veritabanı değişmez, sonuç FAILED + yedek", async () => {
    const old = partialMigrations(LAST - 1);
    const broken = brokenLastMigration();
    cleanup.push(old, broken);
    process.env.UM_MIGRATIONS_DIR = old;
    const h = await openDatabase(process.env.UM_DB_PATH!);
    clients.push(h.client);
    await runMigrations(h.db, h.client);
    await h.client.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('budget.monthlyUsd', '42', 1)",
    );

    process.env.UM_MIGRATIONS_DIR = broken;
    let err: unknown;
    try {
      await runMigrations(h.db, h.client);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const bp = backupPathOf(err);
    expect(bp).toBeTruthy();
    expect(path.dirname(bp!)).toBe(path.join(dir, "backups"));
    expect(fs.existsSync(bp!)).toBe(true);
    expect(classifyMigrationError(err)).toBe("FAILED");
    // İşlem geri alındı: yarım tablo yok, geçiş sayısı aynı, veri yerinde.
    const one = async (sql: string) => (await h.client.execute(sql)).rows[0]?.[0];
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name = 'fx_should_roll_back'")).toBe(
      0,
    );
    expect(await one("SELECT COUNT(*) FROM __drizzle_migrations")).toBe(LAST - 1);
    expect(await one("SELECT value FROM settings WHERE key = 'budget.monthlyUsd'")).toBe("42");

    writeMigrateResult(dir, {
      ok: false,
      code: classifyMigrationError(err),
      applied: 0,
      total: LAST,
      backupPath: bp,
    });
    expect(readMigrateResult(dir)).toMatchObject({
      ok: false,
      code: "FAILED",
      backupPath: bp,
      applied: 0,
    });
  });

  it("veritabanı olmayan dosya CORRUPT olarak sınıflanır", async () => {
    fs.writeFileSync(process.env.UM_DB_PATH!, Buffer.alloc(8192, 0x41));
    process.env.UM_MIGRATIONS_DIR = SOURCE;
    let err: unknown;
    try {
      const h = await openDatabase(process.env.UM_DB_PATH!);
      clients.push(h.client);
      await runMigrations(h.db, h.client);
    } catch (e) {
      err = e;
    }
    expect(classifyMigrationError(err)).toBe("CORRUPT");
  });
});

describe("withBackupPath", () => {
  it("yedek yoksa hatayı olduğu gibi döndürür", () => {
    const e = new Error("x");
    expect(withBackupPath(e, undefined)).toBe(e);
    expect(backupPathOf(e)).toBeUndefined();
  });

  it("hataya yedek yolunu ekler; var olan yolu ezmez", () => {
    const e = Object.assign(new Error("x"), { code: "SQLITE_FULL" });
    expect(withBackupPath(e, "/v/backups/pre-migrate-1.db")).toBe(e);
    expect(backupPathOf(e)).toBe("/v/backups/pre-migrate-1.db");
    expect(classifyMigrationError(e)).toBe("DISK_FULL");
    // Görünmez özellik: hata günlüğe yazılırken yol JSON'a karışmaz.
    expect(Object.keys(e)).toEqual(["code"]);
    const pre = Object.assign(new Error("y"), { backupPath: "/v/backups/pre-migrate-0.db" });
    withBackupPath(pre, "/v/backups/pre-migrate-1.db");
    expect(backupPathOf(pre)).toBe("/v/backups/pre-migrate-0.db");
  });

  it("dondurulmuş veya ilkel hata sarılır; neden zinciri ve SQLite kodu korunur", () => {
    const frozen = Object.freeze(Object.assign(new Error("dolu"), { code: "SQLITE_FULL" }));
    const w = withBackupPath(frozen, "/v/backups/pre-migrate-2.db") as Error;
    expect(w).not.toBe(frozen);
    expect(w.message).toBe("dolu");
    expect(w.cause).toBe(frozen);
    expect(backupPathOf(w)).toBe("/v/backups/pre-migrate-2.db");
    expect(classifyMigrationError(w)).toBe("DISK_FULL");
    const p = withBackupPath("metin", "/v/backups/pre-migrate-3.db") as Error;
    expect(p.message).toBe("metin");
    expect(backupPathOf(p)).toBe("/v/backups/pre-migrate-3.db");
    expect(classifyMigrationError(p)).toBe("FAILED");
  });
});

describe("BLOCKED sınıflaması: başka bir süreç veritabanını tutuyor", () => {
  it("bakım kilidi, migrate.lock zaman aşımı, K4 yoklaması, SQLITE_BUSY/LOCKED → BLOCKED", async () => {
    expect(classifyMigrationError(new MaintenanceError("Bakım kilidi alınamadı"))).toBe("BLOCKED");
    expect(classifyMigrationError(new MigrationBlockedError("yazıyor"))).toBe("BLOCKED");
    // Gerçek migrate.lock: canlı başka bir süreç (üst süreç) tutuyor → kısa zaman aşımı.
    const lock = path.join(dir, "migrate.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.ppid));
    expect(isFileLockHeld(lock)).toBe(true);
    let err: unknown;
    try {
      await withFileLock(lock, async () => undefined, 50);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FileLockTimeoutError);
    expect(classifyMigrationError(err)).toBe("BLOCKED");
    // Sahibi ölmüş kilit "tutulmuyor" sayılır (ve isFileLockHeld hiçbir şey silmez).
    fs.writeFileSync(path.join(lock, "pid"), "999999999");
    expect(isFileLockHeld(lock)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(isFileLockHeld(path.join(dir, "yok.lock"))).toBe(false);

    for (const code of ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"])
      expect(classifyMigrationError(Object.assign(new Error("x"), { code })), code).toBe("BLOCKED");
    expect(classifyMigrationError(new Error("SQLITE_BUSY: database is locked"))).toBe("BLOCKED");
    // Geçiş sırasında BUSY: yedek yolu eklenmiş (sarılmış) hata da BLOCKED kalır.
    const frozen = Object.freeze(
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    );
    expect(classifyMigrationError(withBackupPath(frozen, "/v/backups/pre-migrate-1.db"))).toBe(
      "BLOCKED",
    );
    // Sarılmış doğrulama hatası yine VERIFY_FAILED.
    const v = Object.freeze(new MigrationVerificationError("ihlal", undefined));
    expect(classifyMigrationError(withBackupPath(v, "/v/backups/pre-migrate-1.db"))).toBe(
      "VERIFY_FAILED",
    );
  });
});

describe("doğrulama başarısızsa yeniden deneme/yeniden açılış bozuk veritabanıyla açılmaz", () => {
  async function oldDbWithFkViolation() {
    const old = partialMigrations(LAST - 1);
    cleanup.push(old);
    process.env.UM_MIGRATIONS_DIR = old;
    const h = await openDatabase(process.env.UM_DB_PATH!);
    clients.push(h.client);
    await runMigrations(h.db, h.client);
    await h.client.execute("PRAGMA foreign_keys = OFF");
    await h.client.execute(
      "INSERT INTO place_snapshots (scan_id, place_id, was_future) VALUES (424242, 'p-1', 0)",
    );
    await h.client.execute("PRAGMA foreign_keys = ON");
    return h;
  }
  const marker = () => path.join(dir, VERIFY_PENDING_FILENAME);

  it("geçiş uygulanır, denetim başarısız → ikinci çalıştırma (bekleyen 0) denetimi YENİDEN yapar ve aynı yedeği bildirir", async () => {
    const h = await oldDbWithFkViolation();
    process.env.UM_MIGRATIONS_DIR = SOURCE;
    const first = await runMigrations(h.db, h.client).catch((e: unknown) => e);
    expect(classifyMigrationError(first)).toBe("VERIFY_FAILED");
    const bp = backupPathOf(first);
    expect(bp && fs.existsSync(bp)).toBe(true);
    expect(fs.existsSync(marker())).toBe(true);
    // Geçiş gerçekten uygulandı (yeniden çalıştırmada bekleyen yok).
    expect((await h.client.execute("SELECT COUNT(*) FROM __drizzle_migrations")).rows[0]?.[0]).toBe(
      LAST,
    );

    // "Yeniden dene" veya uygulamayı kapatıp açma: eskiden { pending: 0 } dönüp bozuk veritabanıyla açılırdı.
    const second = await runMigrations(h.db, h.client).catch((e: unknown) => e);
    expect(classifyMigrationError(second)).toBe("VERIFY_FAILED");
    expect(backupPathOf(second)).toBe(bp);
    const backups = fs.readdirSync(path.join(dir, "backups")).filter((n) => n.endsWith(".db"));
    expect(backups).toHaveLength(1); // yeni yedek alınmadı

    // Sorun giderilince işaret silinir ve sonraki açılışlar denetimsiz geçer.
    await h.client.execute("DELETE FROM place_snapshots WHERE scan_id = 424242");
    expect(await runMigrations(h.db, h.client)).toEqual({ pending: 0 });
    expect(fs.existsSync(marker())).toBe(false);
    expect(await runMigrations(h.db, h.client)).toEqual({ pending: 0 });
  });

  it("başarılı geçiş işaret bırakmaz", async () => {
    process.env.UM_MIGRATIONS_DIR = SOURCE;
    const h = await openDatabase(process.env.UM_DB_PATH!);
    clients.push(h.client);
    expect((await runMigrations(h.db, h.client)).pending).toBe(LAST);
    expect(fs.existsSync(marker())).toBe(false);
  });
});

describe("güncelleme öncesi yedek: atomik kopya ve aynı açılışta yeniden kullanım", () => {
  async function oldDb() {
    const old = partialMigrations(LAST - 1);
    cleanup.push(old);
    process.env.UM_MIGRATIONS_DIR = old;
    const h = await openDatabase(process.env.UM_DB_PATH!);
    clients.push(h.client);
    await runMigrations(h.db, h.client);
    await h.client.execute(
      "INSERT INTO settings (key, value, updated_at) VALUES ('budget.monthlyUsd', '42', 1)",
    );
    process.env.UM_MIGRATIONS_DIR = SOURCE;
    return h;
  }
  const listBackups = () => fs.readdirSync(path.join(dir, "backups")).sort();

  it("kopya ENOSPC ile yarıda kalırsa yarım dosya kalmaz, sonuç DISK_FULL, veritabanı değişmez", async () => {
    const h = await oldDb();
    const real = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      real(from, to, mode);
      if (String(to).includes("pre-migrate-"))
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    const err = await runMigrations(h.db, h.client).catch((e: unknown) => e);
    expect(classifyMigrationError(err)).toBe("DISK_FULL");
    expect(listBackups()).toEqual([]); // ne pre-migrate-*.db ne .tmp
    expect((await h.client.execute("SELECT COUNT(*) FROM __drizzle_migrations")).rows[0]?.[0]).toBe(
      LAST - 1,
    );
  });

  it("önceki denemenin yedeği verilirse yeni kopya alınmaz; geçersiz yol yok sayılır", async () => {
    const h = await oldDb();
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    const prev = path.join(dir, "backups", "pre-migrate-2026-11-16T10-00-00-000Z.db");
    fs.copyFileSync(process.env.UM_DB_PATH!, prev);
    const r = await runMigrations(h.db, h.client, { reuseBackupPath: prev });
    expect(r).toEqual({ pending: 1, backupPath: prev });
    expect(listBackups()).toEqual([path.basename(prev)]);
  });

  it.each([
    ["diskte yok", () => path.join(dir, "backups", "pre-migrate-yok.db")],
    [
      "veri klasörü dışı",
      () => {
        const p = path.join(dir, "pre-migrate-2026-11-16T10-00-00-000Z.db");
        fs.writeFileSync(p, "x");
        return p;
      },
    ],
    [
      "başka ad",
      () => {
        fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
        const p = path.join(dir, "backups", "failed-migrate-1.db");
        fs.writeFileSync(p, "x");
        return p;
      },
    ],
  ])("%s: yeniden kullanım yolu reddedilir, yeni yedek alınır", async (_n, make) => {
    const h = await oldDb();
    const reuse = make();
    const r = await runMigrations(h.db, h.client, { reuseBackupPath: reuse });
    expect(r.pending).toBe(1);
    expect(r.backupPath).toMatch(/pre-migrate-\d{4}-.+\.db$/);
    expect(path.dirname(r.backupPath!)).toBe(path.join(dir, "backups"));
    expect(r.backupPath).not.toBe(reuse);
    expect(listBackups().filter((n) => n.startsWith("pre-migrate-"))).toEqual([
      path.basename(r.backupPath!),
    ]);
  });
});
