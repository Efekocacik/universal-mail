import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { runMigrations, withBackupPath } from "@/lib/db/migrate";
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
