import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDatabase, type Db } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

export interface TestDb {
  db: Db;
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
}

const REPO = path.resolve(__dirname, "..", "..");

/** Her test için geçici klasörde, gerçek migrasyonlar uygulanmış yeni bir SQLite dosyası açar. */
export async function createTestDb(): Promise<TestDb> {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-test-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_DB_PATH = path.join(dir, "test.db");
  process.env.UM_MIGRATIONS_DIR = path.join(REPO, "drizzle");
  process.env.UM_STATIC_DATA_DIR = path.join(REPO, "data");
  const handle = await openDatabase(process.env.UM_DB_PATH);
  await runMigrations(handle.db, handle.client);
  return {
    db: handle.db,
    dir,
    path: process.env.UM_DB_PATH,
    cleanup: async () => {
      handle.client.close();
      await closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
