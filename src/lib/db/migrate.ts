import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { backupsDir, dbPath, migrationsDir } from "@/lib/config/paths";
import type { Client } from "@libsql/client";
import type { Db } from "./client";

interface Journal {
  entries: { idx: number; tag: string }[];
}

export interface MigrationResult {
  pending: number;
  backupPath?: string;
}

async function appliedCount(client: Client): Promise<number> {
  try {
    const res = await client.execute("SELECT COUNT(*) AS n FROM __drizzle_migrations");
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return 0; // tablo henüz yok
  }
}

function journalCount(folder: string): number {
  const file = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  return journal.entries.length;
}

function pruneBackups(dir: string, keep = 5): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("pre-migrate-") && f.endsWith(".db"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * Bekleyen şema geçişlerini uygular. Veritabanında zaten veri varsa geçişten ÖNCE yedek alır
 * (NFR-10). Geçiş başarısız olursa yedek yerinde kalır ve hata yukarı fırlatılır.
 */
export async function runMigrations(db: Db, client: Client): Promise<MigrationResult> {
  const folder = migrationsDir();
  const pending = journalCount(folder) - (await appliedCount(client));
  if (pending <= 0) return { pending: 0 };

  let backupPath: string | undefined;
  const existing = await appliedCount(client);
  if (existing > 0 && fs.existsSync(dbPath())) {
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupsDir(), `pre-migrate-${stamp}.db`);
    fs.copyFileSync(dbPath(), backupPath);
    pruneBackups(backupsDir());
  }

  await migrate(db, { migrationsFolder: folder });
  return { pending, backupPath };
}
