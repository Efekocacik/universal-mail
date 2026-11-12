import { z } from "zod";
import { registerJobHandler, type JobContext } from "@/lib/jobs/registry";
import { createProvider } from "@/lib/places/factory";
import { backgroundPrecheck } from "@/lib/scan/background";
import { FUTURE_WATCH_JOB, runFutureWatch } from "@/lib/scan/future-watch";
import { loadNoveltyConfig, recomputeNovelty } from "@/lib/scan/novelty-sync";
import { placeIdsForDomains, RDAP_JOB, runRdapBatch } from "@/lib/novelty/rdap-job";
import { PLACE_ID_REFRESH_JOB, runPlaceIdRefresh } from "@/lib/scan/place-id-refresh";
import {
  runDueSchedules,
  scheduleTick,
  SCHEDULE_TICK_JOB,
  TICK_INTERVAL_MS,
} from "@/lib/scan/schedule";
import { getSetting } from "@/lib/settings";

const refreshPayload = z
  .object({ limit: z.number().int().min(1).max(5000).optional(), manual: z.boolean().optional() })
  .passthrough();

/**
 * Faz 4 arka plan işleri (Paket B). Hepsi idempotenttir ve saat enjeksiyonuna açıktır (`now`).
 * - `scan.schedule.tick`: zamanı gelen zamanlamaları çalıştırır ve bir sonraki tick'i (5 dk) planlar. Tick hatası bile
 *   zinciri koparmaz (`finally`). Bakım turu da zinciri yeniden kurar.
 * - `places.watch_future`: yakında açılacak yerlerin durumunu denetler (ayar `novelty.futureWatch`).
 * - `places.refresh_ids`: 12 aydan eski yer kimliklerini yeniler (ücretsiz IDs Only).
 * - `novelty.rdap`: web sitesi alan adlarının kayıt tarihini (RDAP) alır ve bağlı lead'lerin skorunu yeniler.
 */
export function registerScanBackgroundHandlers(opts: { now?: () => number } = {}): void {
  const clock = opts.now ?? Date.now;

  registerJobHandler(SCHEDULE_TICK_JOB, async (ctx: JobContext) => {
    const now = clock();
    try {
      const out = await runDueSchedules(ctx.db, { now, log: ctx.log });
      if (out.length > 0)
        ctx.log(`zamanlama turu: ${out.map((o) => `#${o.scheduleId} ${o.outcome}`).join(", ")}`);
    } finally {
      await scheduleTick(ctx.db, {
        runAt: now + TICK_INTERVAL_MS,
        now,
        exceptJobId: ctx.job.id,
      });
    }
  });

  registerJobHandler(FUTURE_WATCH_JOB, async (ctx: JobContext) => {
    const cfg = await getSetting(ctx.db, "novelty.futureWatch");
    if (!cfg.enabled) return ctx.log("açılış izleme kapalı");
    const pre = await backgroundPrecheck(ctx.db, "watch_future", { now: clock(), log: ctx.log });
    if (!pre.ok) return;
    await runFutureWatch(
      {
        db: ctx.db,
        provider: await createProvider(ctx.db),
        getBudgetUsd: () => getSetting(ctx.db, "budget.monthlyUsd"),
        getNoveltyConfig: () => loadNoveltyConfig(ctx.db),
        now: clock,
        shouldStop: ctx.shouldStop,
        log: ctx.log,
      },
      { everyDays: cfg.everyDays, maxPerRun: cfg.maxPerRun },
    );
  });

  registerJobHandler(PLACE_ID_REFRESH_JOB, async (ctx: JobContext) => {
    const { limit } = refreshPayload.parse(ctx.payload ?? {});
    const pre = await backgroundPrecheck(ctx.db, "refresh_ids", { now: clock(), log: ctx.log });
    if (!pre.ok) return;
    await runPlaceIdRefresh(
      {
        db: ctx.db,
        provider: await createProvider(ctx.db),
        getBudgetUsd: () => getSetting(ctx.db, "budget.monthlyUsd"),
        now: clock,
        shouldStop: ctx.shouldStop,
        log: ctx.log,
      },
      { limit: limit ?? 500 },
    );
  });
  registerJobHandler(RDAP_JOB, async (ctx: JobContext) => {
    const res = await runRdapBatch({
      db: ctx.db,
      now: clock,
      shouldStop: ctx.shouldStop,
      log: ctx.log,
      continueAfterJobId: ctx.job.id,
    });
    const ids = await placeIdsForDomains(ctx.db, res.domains);
    if (ids.length > 0)
      await recomputeNovelty(ctx.db, await loadNoveltyConfig(ctx.db), {
        placeIds: ids,
        now: clock(),
      });
  });
}
