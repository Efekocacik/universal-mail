import { z } from "zod";
import {
  getJobHandler,
  NonRetryableJobError,
  registerJobHandler,
  type JobContext,
} from "@/lib/jobs/registry";
import { createProvider } from "@/lib/places/factory";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { scanStatusOf, setScanStatus } from "@/lib/scan/store";
import { errorMessage } from "@/lib/util";
import { getSetting } from "@/lib/settings";
import type { Db } from "@/lib/db/client";

const scanPayload = z.object({ scanId: z.number().int() });
const enrichPayload = z.object({ placeIds: z.array(z.string()).min(1).max(500) });

/** Veri toplama işleri, kullanım onayı verilmeden çalışmaz (FR-SET-08). */
async function requireConsent(db: Db): Promise<void> {
  if (!(await getSetting(db, "consent"))) {
    throw new NonRetryableJobError(
      "Kullanım onayı verilmediği için veri toplama işi çalıştırılmadı.",
    );
  }
}

async function sharedDeps(db: Db) {
  await requireConsent(db);
  return {
    db,
    provider: await createProvider(db),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
  };
}

/**
 * Faz 1 işleyicileri. Yeni bir iş türü eklemek için aynı şekilde `registerJobHandler` çağrılır;
 * örn. Faz 2'de `enrich.website`, Faz 3'te `mail.send`.
 */
export function registerCoreHandlers(): void {
  registerJobHandler("scan.run", async (ctx: JobContext) => {
    const { scanId } = scanPayload.parse(ctx.payload);
    const deps = await sharedDeps(ctx.db);
    try {
      const outcome = await runScan({ ...deps, shouldStop: ctx.shouldStop, log: ctx.log }, scanId);
      ctx.log(`Tarama ${scanId}: ${outcome}`);
    } catch (e) {
      // Beklenmeyen hata: tarama "çalışıyor" görünmeye devam etmesin.
      const message = errorMessage(e);
      if ((await scanStatusOf(ctx.db, scanId)) === "running") {
        await setScanStatus(ctx.db, scanId, "failed", { error: message, finishedAt: Date.now() });
      }
      throw e;
    }
  });

  registerJobHandler("place.enrich", async (ctx: JobContext) => {
    const { placeIds } = enrichPayload.parse(ctx.payload);
    const deps = await sharedDeps(ctx.db);
    const res = await enrichPlaces({ ...deps, shouldStop: ctx.shouldStop }, placeIds);
    ctx.log(
      `Zenginleştirme: ${res.enriched} tamam, ${res.skipped} atlandı${res.stoppedReason ? ` (${res.stoppedReason})` : ""}`,
    );
  });
}

export { getJobHandler };
