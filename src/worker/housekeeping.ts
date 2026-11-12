import type { Db } from "@/lib/db/client";
import { enqueueJob, pruneFinishedJobs } from "@/lib/jobs/queue";
import { pruneNotifications } from "@/lib/notifications";
import { enqueueRdap } from "@/lib/novelty/rdap-job";
import { purgeExpiredGoogleData } from "@/lib/places/cache";
import { purgeDerivedFlags } from "@/lib/places/retention";
import { FUTURE_WATCH_JOB } from "@/lib/scan/future-watch";
import { loadNoveltyConfig, recomputeNovelty } from "@/lib/scan/novelty-sync";
import { PLACE_ID_REFRESH_JOB } from "@/lib/scan/place-id-refresh";
import { dayKey, FIRST_TICK_DELAY_MS, scheduleTick } from "@/lib/scan/schedule";
import { getSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/util";

/** M3: bitmiş iş kayıtları bu kadar gün tutulur (gün anahtarlı tekilleştirme yalnızca o günü kapsar). */
export const FINISHED_JOB_RETENTION_MS = 7 * 86_400_000;
export const HOUSEKEEPING_INTERVAL_MS = 6 * 3_600_000;

export interface HousekeepingResult {
  coordinates: number;
  cacheRows: number;
  derivedFlags: number;
  noveltyUpdated: number;
  notificationsPruned: number;
  enqueued: string[];
  errors: string[];
}

/**
 * İşçi bakım turu (açılışta ve 6 saatte bir). Her adım bağımsızdır: biri başarısız olursa diğerleri yine çalışır ve
 * hata günlüğe yazılır. Bütün adımlar idempotenttir ve `now` enjekte edilebilir (M1 kabul testi).
 *  1. Google saklama politikası: süresi dolan koordinat/önbellek, ayarlıysa türetilmiş bayraklar (retention.ts).
 *  2. Yenilik skorları (zamanla sona eren sinyaller düşer; RDAP açıksa alan adı yaşı dahil).
 *  3. M3: 7 günden eski bitmiş işler ve eski bildirimler silinir.
 *  4. Gün anahtarlı arka plan işleri: açılış izleme, yer kimliği yenileme; RDAP işi (tekil).
 *  5. Zamanlama tick zinciri yeniden kurulur (koptuysa; tekil).
 */
export async function runHousekeeping(
  db: Db,
  opts: { now: number; log?: (m: string) => void },
): Promise<HousekeepingResult> {
  const { now } = opts;
  const log = opts.log ?? (() => undefined);
  const res: HousekeepingResult = {
    coordinates: 0,
    cacheRows: 0,
    derivedFlags: 0,
    noveltyUpdated: 0,
    notificationsPruned: 0,
    enqueued: [],
    errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      res.errors.push(name);
      log(`bakım adımı başarısız (${name}): ${errorMessage(e).slice(0, 160)}`);
    }
  };
  const s = await getSettings(db, [
    "google.cacheDays",
    "google.derivedFlagsDays",
    "novelty.futureWatch",
    "novelty.rdap",
  ] as const);

  await step("google", async () => {
    const r = await purgeExpiredGoogleData(db, s["google.cacheDays"], now);
    res.coordinates = r.coordinates;
    res.cacheRows = r.cacheRows;
    const d = await purgeDerivedFlags(db, s["google.derivedFlagsDays"], now);
    res.derivedFlags = d.places + d.snapshots;
    if (r.coordinates + r.cacheRows + res.derivedFlags > 0)
      log(
        `süresi dolan Google verisi silindi (${r.coordinates} konum, ${r.cacheRows} önbellek satırı, ${res.derivedFlags} türetilmiş bayrak).`,
      );
  });
  await step("novelty", async () => {
    res.noveltyUpdated = await recomputeNovelty(db, await loadNoveltyConfig(db), { now });
    if (res.noveltyUpdated > 0) log(`${res.noveltyUpdated} lead'in yenilik skoru güncellendi.`);
  });
  await step("prune", async () => {
    await pruneFinishedJobs(db, FINISHED_JOB_RETENTION_MS, now);
    res.notificationsPruned = await pruneNotifications(db, { now });
  });
  await step("enqueue", async () => {
    const day = dayKey(now);
    if (s["novelty.futureWatch"].enabled) {
      const id = await enqueueJob(
        db,
        FUTURE_WATCH_JOB,
        {},
        { dedupeKey: `${FUTURE_WATCH_JOB}:${day}`, runAt: now, maxAttempts: 1 },
      );
      if (id !== null) res.enqueued.push(FUTURE_WATCH_JOB);
    }
    const ids = await enqueueJob(
      db,
      PLACE_ID_REFRESH_JOB,
      { limit: 500 },
      { dedupeKey: `${PLACE_ID_REFRESH_JOB}:${day}`, runAt: now, maxAttempts: 1 },
    );
    if (ids !== null) res.enqueued.push(PLACE_ID_REFRESH_JOB);
    if (s["novelty.rdap"].enabled && (await enqueueRdap(db, { runAt: now, now })) !== null)
      res.enqueued.push("novelty.rdap");
  });
  await step("tick", async () => {
    await scheduleTick(db, { runAt: now + FIRST_TICK_DELAY_MS, now });
  });
  return res;
}
