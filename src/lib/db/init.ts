import path from "node:path";
import { dataDir } from "@/lib/config/paths";
import { seedCategories } from "@/lib/scan/categories";
import { withFileLock } from "@/lib/util/file-lock";
import { getClient, getDb } from "./client";
import { runMigrations, type MigrationResult } from "./migrate";

export interface InitResult {
  migrated: MigrationResult;
  seededCategories: number;
}

/**
 * Veritabanını hazırlar: bekleyen şema geçişlerini uygular (öncesinde yedek alır) ve yerleşik kategorileri
 * ekler. İşlem dosya kilidi altında olduğundan aynı anda birden çok süreç çağırsa bile güvenlidir.
 */
export async function initDatabase(): Promise<InitResult> {
  return withFileLock(path.join(dataDir(), "migrate.lock"), async () => {
    const [db, client] = await Promise.all([getDb(), getClient()]);
    const migrated = await runMigrations(db, client);
    const seededCategories = await seedCategories(db);
    return { migrated, seededCategories };
  });
}
