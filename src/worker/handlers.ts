import { z } from "zod";
import {
  getJobHandler,
  NonRetryableJobError,
  registerJobHandler,
  type JobContext,
} from "@/lib/jobs/registry";
import { createEmailDeps } from "@/lib/email/deps";
import { enqueueEmailSearch, leadIdsForPlaces } from "@/lib/email/enqueue";
import { findEmailsForLeads } from "@/lib/email/service";
import { onEvent } from "@/lib/events";
import { getDb } from "@/lib/db/client";
import { createProvider } from "@/lib/places/factory";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan } from "@/lib/scan/runner";
import { scanStatusOf, setScanStatus } from "@/lib/scan/store";
import { errorMessage } from "@/lib/util";
import { getSetting } from "@/lib/settings";
import type { Db } from "@/lib/db/client";

const scanPayload = z.object({ scanId: z.number().int() });
const enrichPayload = z.object({
  placeIds: z.array(z.string()).min(1).max(500),
  mode: z.enum(["refresh", "enrich"]).default("enrich"),
  /** Zenginleştirme bitince web sitesinden e-posta aramayı da başlat (Faz 2). */
  findEmails: z.boolean().optional(),
  useExternal: z.boolean().optional(),
});
const emailPayload = z.object({
  leadIds: z.array(z.number().int()).min(1).max(500),
  force: z.boolean().optional(),
  useExternal: z.boolean().optional(),
});

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
    const { placeIds, mode, findEmails, useExternal } = enrichPayload.parse(ctx.payload);
    const deps = await sharedDeps(ctx.db);
    const res = await enrichPlaces({ ...deps, shouldStop: ctx.shouldStop }, placeIds, mode, {
      findEmails,
      useExternal,
    });
    ctx.log(
      `Zenginleştirme: ${res.enriched} tamam, ${res.skipped} atlandı${res.stoppedReason ? ` (${res.stoppedReason})` : ""}`,
    );
  });
}

/**
 * Faz 2: e-posta bulma. İş türü `enrich.email`; Google zenginleştirmesinden gelen `place.enriched` olayı
 * (findEmails işaretliyse) lead'leri bu işe yönlendirir. Yeni bir kayıt, işçi döngüsünü değiştirmeden eklenir.
 */
export function registerEmailHandlers(): void {
  registerJobHandler("enrich.email", async (ctx: JobContext) => {
    const { leadIds, force, useExternal } = emailPayload.parse(ctx.payload);
    await requireConsent(ctx.db);
    const deps = await createEmailDeps(ctx.db, {
      useExternal,
      shouldStop: ctx.shouldStop,
      log: ctx.log,
    });
    const res = await findEmailsForLeads(deps, leadIds, {
      force,
      // Geçici hata: 24 saat sonra en fazla bir kez; yeniden deneme "kuyrukta" görünmesin diye işaretlenmez.
      scheduleRetry: async (ids, runAt) => {
        await enqueueEmailSearch(ctx.db, ids, { runAt, useExternal, markQueued: false });
      },
    });
    ctx.log(
      `E-posta bulma: ${res.processed} site sonucu, ${res.found} lead'de adres bulundu, ${res.notFound} bulunamadı, ` +
        `${res.blocked} engelli, ${res.failed} hata (${res.retryScheduled} yeniden deneme), ` +
        `${res.noWebsite} sitesiz, ${res.needsGoogle} Google verisi bekliyor`,
    );
  });
}

let emailEventsBound = false;
/** `place.enriched` olayını dinleyip (findEmails ise) e-posta aramasını kuyruğa alır. Süreç başına bir kez bağlanır. */
export function bindEmailEvents(): void {
  if (emailEventsBound) return;
  emailEventsBound = true;
  onEvent("place.enriched", async ({ placeIds, findEmails, useExternal }) => {
    if (!findEmails) return;
    const db = await getDb();
    const ids = await leadIdsForPlaces(db, placeIds);
    await enqueueEmailSearch(db, ids, { useExternal });
  });
}

export function resetEmailEventsForTests(): void {
  emailEventsBound = false;
}

export { getJobHandler };
