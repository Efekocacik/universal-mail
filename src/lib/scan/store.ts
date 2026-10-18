import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { leads, placeSnapshots, places, scanUnits, scans } from "@/lib/db/schema";
import type { BBox, PlaceRecord, ScanProgress, ScanStatus } from "@/lib/domain/types";
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
  extra: { pauseReason?: string | null; error?: string | null; finishedAt?: number | null; startedAt?: number } = {},
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
  const rows = await db.select({ status: scans.status }).from(scans).where(eq(scans.id, scanId)).limit(1);
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
  units: { bbox: BBox; kind: "text" | "nearby"; termKind: "type" | "keyword"; term: string; depth: number; parentId?: number }[],
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

/**
 * Tarama sonucunu kaydeder: `places` (Google kaynaklı alanlar), `place_snapshots` (tarama karşılaştırması)
 * ve `leads` (kullanıcıya ait alanlar). Zenginleştirme alanları (web sitesi, telefon, yorum sayısı) keşif
 * maskesinde gelmediğinde mevcut değerler KORUNUR.
 */
export async function persistPlaces(db: Db, scanId: number, records: PlaceRecord[], now: number): Promise<UpsertResult> {
  if (records.length === 0) return { inserted: 0, openedIds: [] };
  const unique = [...new Map(records.map((r) => [r.placeId, r])).values()];
  const ids = unique.map((r) => r.placeId);

  const existing = await db
    .select({ placeId: places.placeId, businessStatus: places.businessStatus })
    .from(places)
    .where(inArray(places.placeId, ids));
  const prevStatus = new Map(existing.map((e) => [e.placeId, e.businessStatus]));

  await db
    .insert(places)
    .values(
      unique.map((r) => ({
        placeId: r.placeId,
        source: r.source,
        name: r.name,
        formattedAddress: r.formattedAddress ?? null,
        lat: r.lat,
        lng: r.lng,
        countryCode: r.countryCode ?? null,
        city: r.city ?? null,
        primaryType: r.primaryType ?? null,
        types: r.types,
        businessStatus: r.businessStatus ?? null,
        openingDate: r.openingDate ?? null,
        website: r.website ?? null,
        phone: r.phone ?? null,
        intlPhone: r.intlPhone ?? null,
        userRatingCount: r.userRatingCount ?? null,
        googleMapsUri: r.googleMapsUri ?? null,
        googleFetchedAt: now,
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
        name: sql`excluded.name`,
        formattedAddress: sql`coalesce(excluded.formatted_address, ${places.formattedAddress})`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        countryCode: sql`coalesce(excluded.country_code, ${places.countryCode})`,
        city: sql`coalesce(excluded.city, ${places.city})`,
        primaryType: sql`coalesce(excluded.primary_type, ${places.primaryType})`,
        types: sql`excluded.types`,
        businessStatus: sql`excluded.business_status`,
        openingDate: sql`excluded.opening_date`,
        website: sql`coalesce(excluded.website, ${places.website})`,
        phone: sql`coalesce(excluded.phone, ${places.phone})`,
        intlPhone: sql`coalesce(excluded.intl_phone, ${places.intlPhone})`,
        userRatingCount: sql`coalesce(excluded.user_rating_count, ${places.userRatingCount})`,
        googleMapsUri: sql`coalesce(excluded.google_maps_uri, ${places.googleMapsUri})`,
        googleFetchedAt: sql`excluded.google_fetched_at`,
        lastSeenScanId: sql`excluded.last_seen_scan_id`,
        notFoundInScanId: sql`NULL`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  // FUTURE_OPENING → OPERATIONAL geçişi (açılış anı yakalandı).
  const openedIds = unique
    .filter((r) => prevStatus.get(r.placeId) === "FUTURE_OPENING" && r.businessStatus === "OPERATIONAL")
    .map((r) => r.placeId);
  if (openedIds.length > 0) {
    await db.update(places).set({ openedDetectedAt: now }).where(inArray(places.placeId, openedIds));
  }

  await db
    .insert(placeSnapshots)
    .values(
      unique.map((r) => ({
        scanId,
        placeId: r.placeId,
        businessStatus: r.businessStatus ?? null,
        userRatingCount: r.userRatingCount ?? null,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(leads)
    .values(unique.map((r) => ({ placeId: r.placeId, source: r.source, createdAt: now, updatedAt: now })))
    .onConflictDoNothing({ target: leads.placeId });

  return { inserted: unique.filter((r) => !prevStatus.has(r.placeId)).length, openedIds };
}

export async function countSnapshot(db: Db, scanId: number): Promise<{ total: number; future: number }> {
  const rows = await db
    .select({
      total: sql<number>`count(*)`,
      future: sql<number>`coalesce(sum(case when ${placeSnapshots.businessStatus} = 'FUTURE_OPENING' then 1 else 0 end), 0)`,
    })
    .from(placeSnapshots)
    .where(eq(placeSnapshots.scanId, scanId));
  return { total: Number(rows[0]?.total ?? 0), future: Number(rows[0]?.future ?? 0) };
}

export async function unitCounts(db: Db, scanId: number): Promise<{ total: number; done: number; failed: number }> {
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
