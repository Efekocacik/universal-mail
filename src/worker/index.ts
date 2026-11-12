import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { isMailSchedulerEnabled, startMailScheduler } from "@/lib/mail/scheduler/job";
import { isDemoInboxEnabled, startInboxScheduler } from "@/lib/mail/scheduler/inbox-job";
import {
  scheduleUnsubscribeDrainIfActive,
  startUnsubscribeDrain,
} from "@/lib/unsubscribe/drain-job";
import { FIRST_TICK_DELAY_MS, scheduleTick } from "@/lib/scan/schedule";
import {
  bindEmailEvents,
  registerCoreHandlers,
  registerEmailHandlers,
  registerMailHandlers,
} from "./handlers";
import { registerScanBackgroundHandlers } from "./background";
import { runHousekeeping, startHousekeepingLoop } from "./housekeeping";
import { Worker } from "./loop";
import { withShortRetry } from "./retry";
import { createWakeGate, createWorkerMessageHandler, handleWake } from "./wake";

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
  registerEmailHandlers();
  registerScanBackgroundHandlers();
  bindEmailEvents();
  const db = await getDb();
  // Faz 3 gönderim zamanlayıcısı: varsayılan KAPALI. Demo bayrağı (FAZ3_DEMO_SCHEDULER_ENABLED) veya canlı gönderim
  // kapısı (isLiveSendingPermitted; kodda sabit, bu sürümde açık) ile açılır. Kapalıyken veritabanına yazmaz.
  const schedulerEnabled = isMailSchedulerEnabled(process.env);
  const inboxEnabled = isDemoInboxEnabled(process.env);
  registerMailHandlers({ enabled: schedulerEnabled, inboxEnabled, db });
  const inbox = await startInboxScheduler(db, { env: process.env });
  if (inbox.enabled)
    console.log(
      inbox.live
        ? "[worker] gelen kutusu eşitleme açık (gerçek Gmail okuma dahil)."
        : "[worker] demo gelen kutusu açık (yalnızca demo).",
    );
  const drain = await startUnsubscribeDrain(db, { env: process.env });
  if (drain.enabled) console.log("[worker] çıkış olayı çekme işi açık.");
  const mailScheduler = await startMailScheduler(db, {
    env: process.env,
    log: (m) => console.log(`[worker] ${m}`),
  });
  if (mailScheduler.enabled)
    console.log(
      isLiveSendingPermitted()
        ? "[worker] gönderim zamanlayıcısı açık (canlı gönderim kapısı açık)."
        : "[worker] demo gönderim zamanlayıcısı açık (yalnızca demo).",
    );
  const worker = new Worker({ db, workerId: `worker-${process.pid}` });
  const startLog = (m: string) => console.log(`[worker] ${m}`);
  // Kesilen işlerin toparlanması bakım turundan ÖNCE ve tek başına çalışır: bakım turunun tick/kuyruk işlemleri aynı
  // tek bağlantıda açıkken recover'ın sorguları TRANSACTION_ACTIVE ile reddedilip işçiyi açılışta çökertiyordu.
  await withShortRetry("recover", () => worker.recover(), { log: startLog });

  // Faz 4 bakım turu (Google saklama politikası, yenilik skorları, M3 iş/bildirim temizliği, arka plan işleri ve
  // zamanlama tick zinciri). Açılışta ve 6 saatte bir; adımlar birbirinden bağımsız ve idempotenttir. Başarısız tur
  // (ör. açılışta aynı süreçteki işlem tek bağlantıyı tutarken) kısa süre sonra yeniden denenir.
  const hkLog = (m: string) => console.log(`[worker] ${m}`);
  const housekeeping = startHousekeepingLoop({
    run: () => runHousekeeping(db, { now: Date.now(), log: hkLog }),
    onError: (e) => console.error("[worker] bakım turu başarısız:", e),
    log: hkLog,
  });
  // Zamanlanmış taramalar: ilk tick açılıştan 60 sn sonra (tekil; kuyrukta varsa eklenmez).
  // Başarısız olursa işçi çökmez: bakım turunun `tick` adımı zinciri yeniden kurar.
  await withShortRetry(
    "tick",
    () => scheduleTick(db, { runAt: Date.now() + FIRST_TICK_DELAY_MS, now: Date.now() }),
    { log: startLog },
  ).catch((e) => console.error("[worker] ilk tick kurulamadı (bakım turu yeniden kuracak):", e));
  const wakeGate = createWakeGate();
  // Çıkış olayı çekme zinciri kendini yeniden planlar; beklenmedik bir kopmaya karşı (ör. iş başarısız işaretlendi)
  // düzenli olarak yeniden kurulur. İdempotent: kuyrukta/çalışan tur varsa yenisi eklenmez; iş kapalıysa veya adres
  // yoksa veritabanına yazmaz.
  const rearmDrain = setInterval(() => {
    scheduleUnsubscribeDrainIfActive(db, { env: process.env }).catch((e) =>
      console.error("[worker] çıkış çekme işi yeniden kurulamadı:", e),
    );
  }, 10 * 60_000);

  const shutdown = () => {
    console.log("[worker] kapanış isteği alındı; iş güvenle durduruluyor...");
    worker.stop();
    mailScheduler.stop();
    housekeeping.stop();
    clearInterval(rearmDrain);
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Electron ana süreci IPC ile de kapanış bildirebilir.
  // Faz 4: bilgisayar uykudan uyandı / ekran kilidi açıldı / pencere öne geldi → kaçırılan zamanlamalar ve bekleyen
  // gönderim hemen değerlendirilir.
  process.on(
    "message",
    createWorkerMessageHandler({
      shutdown,
      gate: wakeGate,
      wake: () => handleWake(db, { now: Date.now(), mailEnabled: mailScheduler.enabled }),
      onError: (e) => console.error("[worker] uyandırma işlenemedi:", e),
    }),
  );

  await worker.run({ recover: false });
  process.exit(0);
}

// Yakalanmamış hata/ret: nedeni günlüğe yazılır ve süreç hata koduyla kapanır; Electron ana süreci işçiyi yeniden başlatır
// (sessizce yarım durumda çalışmaya devam etmez). Ayrıntı güvenli tutulur: yalnızca hata iletisi/yığını.
// Hata nesnesinin tamamı (ek alanları, `cause` zinciri) yazılmaz; yalnızca yığın veya ileti.
const crashText = (e: unknown): string =>
  e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : `[${typeof e}]`;
process.on("uncaughtException", (e) => {
  console.error("[worker] yakalanmamış hata; işçi yeniden başlatılacak:", crashText(e));
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[worker] yakalanmamış ret; işçi yeniden başlatılacak:", crashText(e));
  process.exit(1);
});

main().catch((e) => {
  console.error("[worker] başlatılamadı:", e);
  process.exit(1);
});
