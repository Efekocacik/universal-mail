import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { places } from "@/lib/db/schema";
import {
  effectiveCacheDays,
  MAX_COORD_DAYS,
  PLACE_ID_REFRESH_DAYS,
  policyRows,
  TERMS_REVIEWED_AT,
  type PolicyRow,
} from "@/lib/places/retention";
import { getSettings } from "@/lib/settings";
import { countDueIdRefresh } from "./place-id-refresh";

/** GET /api/google-data yanıtı: eski alanlar (geriye uyum) + politika sınıfına göre sayımlar ve politika tablosu. */
export interface GoogleDataSummary {
  cachedPlaces: number;
  storedCoordinates: number;
  maxRetentionDays: number;
  termsReviewedAt: string;
  byPolicy: {
    indefinite: { placeIds: number; dueRefresh: number; gone: number; refreshAfterDays: number };
    ttl: { coordinates: number; maxDays: number };
    session: { cachedPlaces: number; maxDays: number };
    derived: { flaggedPlaces: number; maxDays: number | null; legalReview: "pending" };
  };
  policy: PolicyRow[];
}

const n = (r: { n: number }[] | undefined) => Number(r?.[0]?.n ?? 0);

export async function googleDataSummary(db: Db, now: number): Promise<GoogleDataSummary> {
  const s = await getSettings(db, ["google.cacheDays", "google.derivedFlagsDays"] as const);
  const cacheDays = effectiveCacheDays(s["google.cacheDays"]);
  const derivedDays = s["google.derivedFlagsDays"];
  const cached = n(await db.select({ n: sql<number>`count(*)` }).from(placeCache));
  const counts = await db
    .select({
      total: sql<number>`count(*)`,
      coords: sql<number>`coalesce(sum(case when ${places.lat} is not null then 1 else 0 end), 0)`,
      gone: sql<number>`coalesce(sum(case when ${places.goneAt} is not null then 1 else 0 end), 0)`,
      flagged: sql<number>`coalesce(sum(case when ${places.wasFuture} = 1 or ${places.isClosed} = 1 or ${places.openedDetectedAt} is not null or ${places.newDetectedAt} is not null then 1 else 0 end), 0)`,
    })
    .from(places);
  const c = counts[0];
  return {
    cachedPlaces: cached,
    storedCoordinates: Number(c?.coords ?? 0),
    maxRetentionDays: MAX_COORD_DAYS,
    termsReviewedAt: TERMS_REVIEWED_AT,
    byPolicy: {
      indefinite: {
        placeIds: Number(c?.total ?? 0),
        dueRefresh: await countDueIdRefresh(db, now),
        gone: Number(c?.gone ?? 0),
        refreshAfterDays: PLACE_ID_REFRESH_DAYS,
      },
      ttl: { coordinates: Number(c?.coords ?? 0), maxDays: cacheDays },
      session: { cachedPlaces: cached, maxDays: cacheDays },
      derived: {
        flaggedPlaces: Number(c?.flagged ?? 0),
        maxDays: derivedDays,
        legalReview: "pending",
      },
    },
    policy: policyRows({ cacheDays, derivedFlagsDays: derivedDays }),
  };
}
