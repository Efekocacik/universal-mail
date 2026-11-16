import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Faz 6 (paket K) test yardımcıları: GEÇİCİ migrasyon klasörleri. Gerçek `drizzle/` klasöründen kopyalanır; geçmiş bir
 * sürümün kurulumunu (ilk n geçiş) veya son geçişi bozuk bir sürümü taklit eder. Çağıran klasörü kendisi siler.
 */

const tmpBase = () => process.env.TMPDIR ?? os.tmpdir();
export const SOURCE_MIGRATIONS = path.resolve(__dirname, "..", "..", "drizzle");

interface Journal {
  entries: { tag: string }[];
}
export function readJournal(): Journal {
  return JSON.parse(
    fs.readFileSync(path.join(SOURCE_MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}
/** Bu sürümdeki toplam geçiş sayısı. */
export const TOTAL_MIGRATIONS = readJournal().entries.length;

/** Yalnızca ilk `count` geçişi içeren klasör (o sürümün kurulumu). */
export function partialMigrations(count: number, prefix = "um-mig-"): string {
  const d = fs.mkdtempSync(path.join(tmpBase(), prefix));
  fs.mkdirSync(path.join(d, "meta"));
  const journal = readJournal();
  journal.entries = journal.entries.slice(0, count);
  fs.writeFileSync(path.join(d, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries)
    fs.copyFileSync(path.join(SOURCE_MIGRATIONS, `${e.tag}.sql`), path.join(d, `${e.tag}.sql`));
  return d;
}

/**
 * Tüm geçişleri içeren ama SONUNCUSU bozuk klasör: önce bir tablo oluşturur, sonra olmayan tabloyu okur (işlem geri
 * alınmalı, yarım tablo kalmamalı).
 */
export function brokenLastMigration(prefix = "um-mig-bad-"): string {
  const d = partialMigrations(TOTAL_MIGRATIONS, prefix);
  const last = readJournal().entries[TOTAL_MIGRATIONS - 1]!.tag;
  fs.writeFileSync(
    path.join(d, `${last}.sql`),
    "CREATE TABLE `fx_should_roll_back` (`a` integer);\n--> statement-breakpoint\nSELECT * FROM `fx_no_such_table`;\n",
  );
  return d;
}
