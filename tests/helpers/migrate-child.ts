/**
 * İki gerçek süreçli migrasyon yarışı için alt süreç (yalnızca testlerde, `node --import tsx` ile çalışır).
 * Verilen GEÇİCİ test veritabanına kendi bağlantısını açar, ortak başlangıç anına kadar bekler ve migrasyonu çalıştırır.
 * Gerçek `.data` veritabanına ve ağa erişmez.
 *
 * Kullanım: migrate-child.ts <dbFile> <startAtMs> <tag> <bare|init>
 *   bare: yalnızca `runMigrations` (süreçler arası `migrate.lock` OLMADAN; en zor durum)
 *   init: gerçek açılış yolu `initDatabase` (`migrate.lock` + seed'ler)
 */
import path from "node:path";
import { openDatabase } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { runMigrations } from "@/lib/db/migrate";

async function main(): Promise<void> {
  const [file, startAt, tag, mode] = process.argv.slice(2);
  if (!file || !startAt || !tag || !mode) throw new Error("eksik argüman");
  process.env.UM_DB_PATH = file;
  process.env.UM_DATA_DIR ??= path.dirname(file);
  const t0 = Date.now();
  let result: { pending: number } | { error: string };
  try {
    if (mode === "init") {
      while (Date.now() < Number(startAt)) {
        /* ortak başlangıç anına kadar bekle */
      }
      result = { pending: (await initDatabase()).migrated.pending };
    } else {
      const h = await openDatabase(file);
      while (Date.now() < Number(startAt)) {
        /* ortak başlangıç anına kadar bekle */
      }
      result = { pending: (await runMigrations(h.db, h.client)).pending };
      h.client.close();
    }
  } catch (e) {
    result = { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  process.stdout.write(JSON.stringify({ tag, ms: Date.now() - t0, ...result }));
  process.exit(0);
}

void main();
