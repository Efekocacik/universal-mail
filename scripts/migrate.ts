import fs from "node:fs";
import path from "node:path";
import { cacheDbPath, dataDir, migrationsDir } from "../src/lib/config/paths";
import { wipeSessionCacheFiles } from "../src/lib/config/session-cache";
import { closeDb, getDb } from "../src/lib/db/client";
import { initDatabase } from "../src/lib/db/init";
import {
  backupPathOf,
  classifyMigrationError,
  writeMigrateResult,
} from "../src/lib/db/migrate-result";
import { runPostInitHooks, runPreInitHooks } from "../src/lib/lifecycle/pre-init";

// Geliştirme: .env.local varsa yükle
const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Google oturum önbelleği her açılışta silinir (Google verisi kalıcı saklanmaz). Uygulama başlatıcıları (Electron,
// `npm run dev`) bunu açıkça ister; elle çalıştırmada önbelleğe dokunulmaz.
if (process.argv.includes("--wipe-session") || process.env.UM_WIPE_SESSION === "1") {
  const n = wipeSessionCacheFiles(cacheDbPath());
  if (n > 0) console.log("✔ Önceki oturumun Google önbelleği silindi.");
}

/** Sürümdeki toplam geçiş sayısı (sonuç dosyası için; okunamazsa 0). */
function journalTotal(): number {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(migrationsDir(), "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    return j.entries.length;
  } catch {
    return 0;
  }
}

/**
 * Faz 6 sırası (sözleşme P0.6): bekleyen yaşam döngüsü işlemi (geri yükleme / verileri silme) veritabanı AÇILMADAN
 * uygulanır → şema geçişi + seed'ler → denetim kayıtları → `migrate-result.json`. Hata olursa sonuç dosyası koda
 * çevrilmiş hatayla yazılır ve süreç 1 ile çıkar (Electron bunu okuyup kurtarma iletişim kutusunu gösterir).
 */
async function main(): Promise<void> {
  const dir = dataDir();
  const total = journalTotal();
  try {
    const pre = await runPreInitHooks({ dataDir: dir, log: (m) => console.log(m) });
    const r = await initDatabase();
    await runPostInitHooks(await getDb(), pre);
    console.log(
      r.migrated.pending > 0
        ? `✔ ${r.migrated.pending} şema geçişi uygulandı${r.migrated.backupPath ? ` (yedek: ${r.migrated.backupPath})` : ""}.`
        : "✔ Veritabanı güncel.",
    );
    if (r.seededCategories > 0) console.log(`✔ ${r.seededCategories} yerleşik kategori eklendi.`);
    const f = r.seededFaz3;
    if (f.countryPolicies > 0) console.log(`✔ ${f.countryPolicies} ülke politikası eklendi.`);
    if (f.templates > 0) console.log(`✔ ${f.templates} hazır e-posta şablonu eklendi.`);
    if (f.demoMailbox > 0) console.log("✔ Demo posta kutusu eklendi (gerçek gönderim yapmaz).");
    writeMigrateResult(dir, {
      ok: true,
      code: "OK",
      applied: r.migrated.pending,
      total,
      backupPath: r.migrated.backupPath,
    });
    await closeDb();
  } catch (e) {
    console.error("✖ Veritabanı hazırlanamadı:", e);
    writeMigrateResult(dir, {
      ok: false,
      code: classifyMigrationError(e),
      applied: 0,
      total,
      backupPath: backupPathOf(e),
    });
    process.exit(1);
  }
}

void main();
