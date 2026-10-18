import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { leads, placeSnapshots, places, scanUnits, scans } from "@/lib/db/schema";
import type {
  BBox,
  PlaceRecord,
  ScanProgress,
  ScanQuery,
  ScanStatus,
  SearchStrategy,
} from "@/lib/domain/types";
import { deriveLocation } from "@/lib/geo/cities";
import { upsertCache } from "@/lib/places/cache";
import { categoryKeyFor } from "./queries";
import { chunk } from "@/lib/util";

export type ScanRow = typeof scans.$inferSelect;
export type UnitRow = typeof scanUnits.$inferSelect;

export async function loadScan(db: Db, scanId: number): Promise<ScanRow | undefined> {
  const rows = await db.select().from(scans).where(eq(scans.id, scanId)).limit(1);
  return rows[0];
}

export async function setScanStatus(
  db: Db,
  scanId: number,
  status: ScanStatus,
  extra: {
    pauseReason?: string | null;
    error?: string | null;
    finishedAt?: number | null;
    startedAt?: number;
  } = {},
): Promise<void> {
  await db
    .update(scans)
    .set({
      status,
      pauseReason: extra.pauseReason ?? null,
      error: extra.error ?? null,
      ...(extra.finishedAt !== undefined ? { finishedAt: extra.finishedAt } : {}),
      ...(extra.startedAt !== undefined ? { startedAt: extra.startedAt } : {}),
    })
    .where(eq(scans.id, scanId));
}

export async function scanStatusOf(db: Db, scanId: number): Promise<ScanStatus | undefined> {
  const rows = await db
    .select({ status: scans.status })
    .from(scans)
    .where(eq(scans.id, scanId))
    .limit(1);
  return rows[0]?.status;
}

export async function nextQueuedUnit(db: Db, scanId: number): Promise<UnitRow | undefined> {
  const rows = await db
    .select()
    .from(scanUnits)
    .where(and(eq(scanUnits.scanId, scanId), eq(scanUnits.status, "queued")))
    .orderBy(scanUnits.depth, scanUnits.id)
    .limit(1);
  return rows[0];
}

export function unitBBox(u: Pick<UnitRow, "south" | "west" | "north" | "east">): BBox {
  return { south: u.south, west: u.west, north: u.north, east: u.east };
}

export async function insertUnits(
  db: Db,
  scanId: number,
  units: {
    bbox: BBox;
    kind: "text" | "nearby";
    termKind: "type" | "keyword";
    term: string;
    depth: number;
    parentId?: number;
  }[],
  now: number,
): Promise<void> {
  for (const part of chunk(units, 150)) {
    await db.insert(scanUnits).values(
      part.map((u) => ({
        scanId,
        parentId: u.parentId ?? null,
        depth: u.depth,
        south: u.bbox.south,
        west: u.bbox.west,
        north: u.bbox.north,
        east: u.bbox.east,
        kind: u.kind,
        termKind: u.termKind,
        term: u.term,
        status: "queued" as const,
        updatedAt: now,
      })),
    );
  }
}

export interface UpsertResult {
  inserted: number;
  openedIds: string[];
}

export interface PersistContext {
  queries: ScanQuery[];
  unit: { kind: SearchStrategy; termKind: "type" | "keyword"; term: string };
  /** Taranan bölgenin ülkesi (varsa); yakında şehir bulunamazsa yedek olarak kullanılır. */
  regionCountry: string | null;
}

/**
 * Tarama sonucunu kaydeder. Google içeriğinin SAKLANMASI kısıtlı olduğundan veri üçe ayrılır:
 *  1) `gcache.place_cache`: ad, adres, tür, durum, web sitesi, telefon, değerlendirme (GEÇİCİ, oturum önbelleği),
 *  2) `places`: yer kimliği, koordinat (en çok 30 gün) ve bizim türettiğimiz bayraklar,
 *  3) `place_snapshots` ve `leads`: tarama karşılaştırması için yer kimlikleri ve bizim etiketlerimiz.
 * Zenginleştirme alanları keşif maskesinde gelmediğinde önbellekteki mevcut değerler KORUNUR.
 */
export async function persistPlaces(
  db: Db,
  scanId: number,
  records: PlaceRecord[],
  now: number,
  ctx?: PersistContext,
): Promise<UpsertResult> {
  if (records.length === 0) return { inserted: 0, openedIds: [] };
  const unique = [...new Map(records.map((r) => [r.placeId, r])).values()];
  const ids = unique.map((r) => r.placeId);

  await upsertCache(db, unique, now);

  const existing = await db
    .select({ placeId: places.placeId, wasFuture: places.wasFuture })
    .from(places)
    .where(inArray(places.placeId, ids));
  const prevFuture = new Map(existing.map((e) => [e.placeId, e.wasFuture]));
  const flags = (r: PlaceRecord) => ({
    wasFuture: r.businessStatus === "FUTURE_OPENING",
    isClosed: r.businessStatus === "CLOSED_PERMANENTLY",
  });

  await db
    .insert(places)
    .values(
      unique.map((r) => ({
        placeId: r.placeId,
        source: r.source,
        lat: r.lat,
        lng: r.lng,
        coordsFetchedAt: now,
        ...flags(r),
        firstSeenScanId: scanId,
        lastSeenScanId: scanId,
        firstSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: places.placeId,
      set: {
        source: sql`excluded.source`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        coordsFetchedAt: sql`excluded.coords_fetched_at`,
        wasFuture: sql`excluded.was_future`,
        isClosed: sql`excluded.is_closed`,
        lastSeenScanId: sql`excluded.last_seen_scan_id`,
        notFoundInScanId: sql`NULL`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  // FUTURE_OPENING → açıldı geçişi (açılış anı yakalandı).
  const openedIds = unique
    .filter((r) => prevFuture.get(r.placeId) === true && !flags(r).wasFuture && !flags(r).isClosed)
    .map((r) => r.placeId);
  if (openedIds.length > 0) {
    await db
      .update(places)
      .set({ openedDetectedAt: now })
      .where(inArray(places.placeId, openedIds));
  }

  await db
    .insert(placeSnapshots)
    .values(unique.map((r) => ({ scanId, placeId: r.placeId, wasFuture: flags(r).wasFuture })))
    .onConflictDoNothing();

  await db
    .insert(leads)
    .values(
      unique.map((r) => {
        const loc = deriveLocation(r.lat, r.lng, ctx?.regionCountry);
        return {
          placeId: r.placeId,
          source: r.source,
          countryCode: loc.countryCode,
          city: loc.city,
          categoryKey: ctx ? categoryKeyFor(ctx.queries, ctx.unit, r) : null,
          createdAt: now,
          updatedAt: now,
        };
      }),
    )
    .onConflictDoUpdate({
      target: leads.placeId,
      set: {
        categoryKey: sql`coalesce(${leads.categoryKey}, excluded.category_key)`,
        countryCode: sql`coalesce(${leads.countryCode}, excluded.country_code)`,
        city: sql`coalesce(${leads.city}, excluded.city)`,
      },
    });

  return { inserted: unique.filter((r) => !prevFuture.has(r.placeId)).length, openedIds };
}

export async function countSnapshot(
  db: Db,
  scanId: number,
): Promise<{ total: number; future: number }> {
  const rows = await db
    .select({
      total: sql<number>`count(*)`,
      future: sql<number>`coalesce(sum(case when ${placeSnapshots.wasFuture} then 1 else 0 end), 0)`,
    })
    .from(placeSnapshots)
    .where(eq(placeSnapshots.scanId, scanId));
  return { total: Number(rows[0]?.total ?? 0), future: Number(rows[0]?.future ?? 0) };
}

export async function unitCounts(
  db: Db,
  scanId: number,
): Promise<{ total: number; done: number; failed: number }> {
  const rows = await db
    .select({ status: scanUnits.status, n: sql<number>`count(*)` })
    .from(scanUnits)
    .where(eq(scanUnits.scanId, scanId))
    .groupBy(scanUnits.status);
  const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  return { total, done: by.get("done") ?? 0, failed: by.get("failed") ?? 0 };
}

export async function saveProgress(
  db: Db,
  scanId: number,
  patch: ScanProgress & { callsBySku?: Record<string, number>; costUsd?: number },
): Promise<void> {
  const { callsBySku, costUsd, ...progress } = patch;
  await db
    .update(scans)
    .set({
      progress,
      ...(callsBySku ? { callsBySku } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    })
    .where(eq(scans.id, scanId));
}
