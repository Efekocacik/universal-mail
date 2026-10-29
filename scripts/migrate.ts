import fs from "node:fs";
import path from "node:path";
import { cacheDbPath } from "../src/lib/config/paths";
import { wipeSessionCacheFiles } from "../src/lib/config/session-cache";
import { closeDb } from "../src/lib/db/client";
import { initDatabase } from "../src/lib/db/init";

// Geliştirme: .env.local varsa yükle
const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Google oturum önbelleği her açılışta silinir (Google verisi kalıcı saklanmaz). Uygulama başlatıcıları (Electron,
// `npm run dev`) bunu açıkça ister; elle çalıştırmada önbelleğe dokunulmaz.
if (process.argv.includes("--wipe-session") || process.env.UM_WIPE_SESSION === "1") {
  const n = wipeSessionCacheFiles(cacheDbPath());
  if (n > 0) console.log("✔ Önceki oturumun Google önbelleği silindi.");
}

initDatabase()
  .then(async (r) => {
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
    await closeDb();
  })
  .catch((e) => {
    console.error("✖ Veritabanı hazırlanamadı:", e);
    process.exit(1);
  });
