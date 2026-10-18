import { and, eq, inArray } from "drizzle-orm";
import { canSpend, recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { leads, places } from "@/lib/db/schema";
import { emitEvent } from "@/lib/events";
import type { NoveltyConfig } from "@/lib/novelty/score";
import { PlacesApiError } from "@/lib/places/errors";
import { DETAILS_ENRICH_FIELDS } from "@/lib/places/fields";
import type { PlacesProvider } from "@/lib/places/provider";
import { sleep as defaultSleep } from "@/lib/util";
import { recomputeNovelty } from "./novelty-sync";

export interface EnrichDeps {
  db: Db;
  provider: PlacesProvider;
  getBudgetUsd: () => Promise<number>;
  getNoveltyConfig: () => Promise<NoveltyConfig>;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  now?: () => number;
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  /** Bütçe nedeniyle durduysa sebebi. */
  stoppedReason?: string;
}

/**
 * Seçili işletmelerin web sitesi, telefon ve değerlendirme sayısını Place Details (Enterprise) ile alır.
 * Her çağrıdan önce bütçe denetlenir. Başarılı olunca `place.enriched` olayı yayınlanır; Faz 2 e-posta
 * bulma bu olaya abone olur.
 */
export async function enrichPlaces(deps: EnrichDeps, placeIds: string[]): Promise<EnrichResult> {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const done: string[] = [];
  let skipped = 0;
  let stoppedReason: string | undefined;

  for (const id of placeIds) {
    if (deps.shouldStop?.()) break;
    const spend = await canSpend(
      db,
      provider.id,
      await deps.getBudgetUsd(),
      "place_details_enterprise",
      1,
    );
    if (!spend.ok) {
      stoppedReason = spend.reason;
      break;
    }

    const existing = await db.select().from(places).where(eq(places.placeId, id)).limit(1);
    const row = existing[0];
    if (!row) {
      skipped++;
      continue;
    }

    let result;
    try {
      result = await provider.getDetails(id, DETAILS_ENRICH_FIELDS);
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
    const opened = row.businessStatus === "FUTURE_OPENING" && p.businessStatus === "OPERATIONAL";
    await db
      .update(places)
      .set({
        website: p.website ?? row.website,
        phone: p.phone ?? row.phone,
        intlPhone: p.intlPhone ?? row.intlPhone,
        userRatingCount: p.userRatingCount ?? row.userRatingCount,
        businessStatus: p.businessStatus ?? row.businessStatus,
        openingDate: p.businessStatus ? (p.openingDate ?? null) : row.openingDate,
        openedDetectedAt: opened ? t : row.openedDetectedAt,
        enrichedAt: t,
        googleFetchedAt: t,
        updatedAt: t,
      })
      .where(eq(places.placeId, id));
    await db
      .update(leads)
      .set({ status: "enriched", updatedAt: t })
      .where(and(eq(leads.placeId, id), eq(leads.status, "new")));
    done.push(id);
    await sleep(120);
  }

  if (done.length > 0) {
    await recomputeNovelty(db, await deps.getNoveltyConfig(), { placeIds: done, now: now() });
    await emitEvent("place.enriched", { placeIds: done });
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
