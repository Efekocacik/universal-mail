import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { purgeExpiredGoogleData } from "@/lib/places/cache";
import { getSetting } from "@/lib/settings";
import { recomputeNovelty } from "@/lib/scan/novelty-sync";
import { registerCoreHandlers } from "./handlers";
import { Worker } from "./loop";

/** Geliştirme: `.env.local` dosyasını yükle (üretimde Electron ortam değişkenlerini verir). */
function loadDevEnv(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (process.env.NODE_ENV !== "production" && fs.existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* geçersiz dosya yok sayılır */
    }
  }
}

async function main(): Promise<void> {
  loadDevEnv();
  const init = await initDatabase();
  if (init.migrated.pending > 0)
    console.log(`[worker] ${init.migrated.pending} şema geçişi uygulandı.`);

  registerCoreHandlers();
  const db = await getDb();
  const worker = new Worker({ db, workerId: `worker-${process.pid}` });

  // Zamanla sona eren yenilik sinyallerini (ör. "son 60 gün") düzenli yenile.
  const refreshNovelty = async () => {
    try {
      const n = await recomputeNovelty(db, await getSetting(db, "novelty.thresholds"));
      if (n > 0) console.log(`[worker] ${n} lead'in yenilik skoru güncellendi.`);
    } catch (e) {
      console.error("[worker] yenilik yenilemesi başarısız:", e);
    }
  };
  // Google şartları gereği süresi dolan konumlar ve önbellek satırları düzenli silinir.
  const purgeGoogle = async () => {
    try {
      const r = await purgeExpiredGoogleData(db, await getSetting(db, "google.cacheDays"));
      if (r.coordinates + r.cacheRows > 0)
        console.log(
          `[worker] süresi dolan Google verisi silindi (${r.coordinates} konum, ${r.cacheRows} önbellek satırı).`,
        );
    } catch (e) {
      console.error("[worker] Google veri temizliği başarısız:", e);
    }
  };
  const housekeeping = async () => {
    await purgeGoogle();
    await refreshNovelty();
  };
  void housekeeping();
  const interval = setInterval(housekeeping, 6 * 3_600_000);

  const shutdown = () => {
    console.log("[worker] kapanış isteği alındı; iş güvenle durduruluyor...");
    worker.stop();
    clearInterval(interval);
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Electron ana süreci IPC ile de kapanış bildirebilir.
  process.on("message", (m) => {
    if (m === "shutdown") shutdown();
  });

  await worker.run();
  process.exit(0);
}

main().catch((e) => {
  console.error("[worker] başlatılamadı:", e);
  process.exit(1);
});
