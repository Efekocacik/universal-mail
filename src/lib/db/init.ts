import path from "node:path";
import { seedCountryPolicies } from "@/lib/compliance/policies";
import { dataDir } from "@/lib/config/paths";
import { seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { seedCategories } from "@/lib/scan/categories";
import { withFileLock } from "@/lib/util/file-lock";
import { getClient, getDb } from "./client";
import { runMigrations, type MigrationResult } from "./migrate";

export interface InitResult {
  migrated: MigrationResult;
  seededCategories: number;
  /** Faz 3: eklenen ülke politikası satırları, hazır şablonlar ve demo posta kutusu. */
  seededFaz3: { countryPolicies: number; templates: number; demoMailbox: number };
}

/**
 * Veritabanını hazırlar: bekleyen şema geçişlerini uygular (öncesinde yedek alır) ve yerleşik kategorileri,
 * ülke politikalarını, hazır şablonları ve demo posta kutusunu ekler. Seed'ler var olan kayıtların üzerine yazmaz.
 * İşlem dosya kilidi altında olduğundan aynı anda birden çok süreç çağırsa bile güvenlidir.
 */
export async function initDatabase(): Promise<InitResult> {
  return withFileLock(path.join(dataDir(), "migrate.lock"), async () => {
    const [db, client] = await Promise.all([getDb(), getClient()]);
    const migrated = await runMigrations(db, client);
    const seededCategories = await seedCategories(db);
    const seededFaz3 = {
      countryPolicies: await seedCountryPolicies(db),
      templates: await seedBuiltinTemplates(db),
      demoMailbox: await seedDemoMailbox(db),
    };
    return { migrated, seededCategories, seededFaz3 };
  });
}
