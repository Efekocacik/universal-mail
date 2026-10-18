import fs from "node:fs";
import path from "node:path";
import { closeDb } from "../src/lib/db/client";
import { initDatabase } from "../src/lib/db/init";

// Geliştirme: .env.local varsa yükle
const envFile = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

initDatabase()
  .then(async (r) => {
    console.log(
      r.migrated.pending > 0
        ? `✔ ${r.migrated.pending} şema geçişi uygulandı${r.migrated.backupPath ? ` (yedek: ${r.migrated.backupPath})` : ""}.`
        : "✔ Veritabanı güncel.",
    );
    if (r.seededCategories > 0) console.log(`✔ ${r.seededCategories} yerleşik kategori eklendi.`);
    await closeDb();
  })
  .catch((e) => {
    console.error("✖ Veritabanı hazırlanamadı:", e);
    process.exit(1);
  });
