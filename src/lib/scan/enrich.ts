import { and, eq, inArray } from "drizzle-orm";
import { canSpend, recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { leads, places } from "@/lib/db/schema";
import type { SkuId } from "@/lib/domain/types";
import { emitEvent } from "@/lib/events";
import type { NoveltyConfig } from "@/lib/novelty/score";
import { upsertCache } from "@/lib/places/cache";
import { PlacesApiError } from "@/lib/places/errors";
import { ENRICH_DETAILS_FIELDS, REFRESH_FIELDS } from "@/lib/places/fields";
import type { PlacesProvider } from "@/lib/places/provider";
import { sleep as defaultSleep } from "@/lib/util";
import { recomputeNovelty } from "./novelty-sync";

/**
 * refresh: ad, adres, konum, tür ve durum önbelleğe yeniden yüklenir (Place Details Pro, ücretsiz kotası geniş).
 *          Uygulama yeniden açıldıktan sonra Google verisi boşken listeyi doldurmak için kullanılır.
 * enrich:  ayrıca web sitesi, telefon ve değerlendirme sayısı alınır (Place Details Enterprise).
 */
export type EnrichMode = "refresh" | "enrich";

export interface EnrichDeps {
  db: Db;
  provider: PlacesProvider;
  getBudgetUsd: () => Promise<number>;
  getNoveltyConfig: () => Promise<NoveltyConfig>;
  sleep?: (ms: number) => Promise<void>;
  /** İki çağrı arası bekleme (ms). Varsayılan: demo 10, Google 120 (kota dostu). */
  minIntervalMs?: number;
  shouldStop?: () => boolean;
  now?: () => number;
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  /** Bütçe nedeniyle durduysa sebebi. */
  stoppedReason?: string;
}

export function skuForMode(mode: EnrichMode): SkuId {
  return mode === "enrich" ? "place_details_enterprise" : "place_details_pro";
}

/**
 * Seçili işletmeleri Place Details ile günceller. Veri YALNIZCA oturum önbelleğine yazılır (bkz. db/cache-schema.ts);
 * kalıcı kayda yalnızca koordinat ve türetilmiş bayraklar gider. Her çağrıdan önce bütçe denetlenir.
 * `enrich` modunda `place.enriched` olayı yayınlanır; Faz 2 e-posta bulma, web sitesini bu olayda ANLIK okur ve
 * yalnızca işletmenin kendi sitesinden bulduğu bilgileri (e-posta, kaynak sayfa) kalıcı kaydeder.
 */
export async function enrichPlaces(
  deps: EnrichDeps,
  placeIds: string[],
  mode: EnrichMode = "enrich",
  opts: { findEmails?: boolean; useExternal?: boolean } = {},
): Promise<EnrichResult> {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const fields = mode === "enrich" ? ENRICH_DETAILS_FIELDS : REFRESH_FIELDS;
  const sku = skuForMode(mode);
  const done: string[] = [];
  let skipped = 0;
  let stoppedReason: string | undefined;

  for (const id of placeIds) {
    if (deps.shouldStop?.()) break;
    const spend = await canSpend(db, provider.id, await deps.getBudgetUsd(), sku, 1);
    if (!spend.ok) {
      stoppedReason = spend.reason;
      break;
    }

    const existing = (await db.select().from(places).where(eq(places.placeId, id)).limit(1))[0];
    if (!existing) {
      skipped++;
      continue;
    }

    let result;
    try {
      result = await provider.getDetails(id, fields);
    } catch (e) {
      if (e instanceof PlacesApiError && e.kind === "invalid") {
        skipped++;
        continue;
      }
      throw e;
    }
    await recordUsage(db, provider.id, result.sku, 1, now());
    const p = result.place;
    if (!p) {
      skipped++;
      continue;
    }

    const t = now();
    await upsertCache(db, [p], t);
    if (mode === "enrich")
      await db.update(placeCache).set({ enrichedAt: t }).where(eq(placeCache.placeId, id));

    const wasFuture = p.businessStatus === "FUTURE_OPENING";
    const isClosed = p.businessStatus === "CLOSED_PERMANENTLY";
    const opened = existing.wasFuture && !wasFuture && !isClosed;
    await db
      .update(places)
      .set({
        lat: p.lat,
        lng: p.lng,
        coordsFetchedAt: t,
        wasFuture,
        isClosed,
        openedDetectedAt: opened ? t : existing.openedDetectedAt,
        updatedAt: t,
      })
      .where(eq(places.placeId, id));
    if (mode === "enrich") {
      await db
        .update(leads)
        .set({ status: "enriched", updatedAt: t })
        .where(and(eq(leads.placeId, id), eq(leads.status, "new")));
    }
    done.push(id);
    await sleep(deps.minIntervalMs ?? (provider.id === "mock" ? 10 : 120));
  }

  if (done.length > 0) {
    await recomputeNovelty(db, await deps.getNoveltyConfig(), { placeIds: done, now: now() });
    if (mode === "enrich")
      await emitEvent("place.enriched", {
        placeIds: done,
        findEmails: opts.findEmails,
        useExternal: opts.useExternal,
      });
  }
  return { enriched: done.length, skipped, stoppedReason };
}

export async function placeIdsForLeads(db: Db, leadIds: number[]): Promise<string[]> {
  if (leadIds.length === 0) return [];
  const rows = await db
    .select({ placeId: leads.placeId })
    .from(leads)
    .where(inArray(leads.id, leadIds));
  return rows.map((r) => r.placeId).filter((p): p is string => !!p);
}
