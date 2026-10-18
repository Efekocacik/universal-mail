import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { places } from "@/lib/db/schema";
import type { PlaceRecord } from "@/lib/domain/types";
import { chunk } from "@/lib/util";

/**
 * Google oturum önbelleği işlemleri. Önbellek, ana veritabanından ayrı ve geçici bir dosyadadır (bkz. cache-schema.ts).
 * Buradaki veri yalnızca uygulama açıkken ekranda göstermek ve anlık kararlar için kullanılır; kalıcı kayıt değildir.
 */
export type CachedPlace = typeof placeCache.$inferSelect;

/** Keşif sonuçlarını önbelleğe yazar. Zenginleştirme alanları (web sitesi, telefon, değerlendirme) keşifte gelmezse korunur. */
export async function upsertCache(db: Db, records: PlaceRecord[], now: number): Promise<void> {
  if (records.length === 0) return;
  for (const part of chunk(records, 100)) {
    await db
      .insert(placeCache)
      .values(
        part.map((r) => ({
          placeId: r.placeId,
          name: r.name,
          formattedAddress: r.formattedAddress ?? null,
          primaryType: r.primaryType ?? null,
          types: r.types,
          businessStatus: r.businessStatus ?? null,
          openingDate: r.openingDate ?? null,
          website: r.website ?? null,
          phone: r.phone ?? null,
          intlPhone: r.intlPhone ?? null,
          userRatingCount: r.userRatingCount ?? null,
          fetchedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: placeCache.placeId,
        set: {
          name: sql`excluded.name`,
          formattedAddress: sql`coalesce(excluded.formatted_address, ${placeCache.formattedAddress})`,
          primaryType: sql`coalesce(excluded.primary_type, ${placeCache.primaryType})`,
          types: sql`excluded.types`,
          businessStatus: sql`excluded.business_status`,
          openingDate: sql`excluded.opening_date`,
          website: sql`coalesce(excluded.website, ${placeCache.website})`,
          phone: sql`coalesce(excluded.phone, ${placeCache.phone})`,
          intlPhone: sql`coalesce(excluded.intl_phone, ${placeCache.intlPhone})`,
          userRatingCount: sql`coalesce(excluded.user_rating_count, ${placeCache.userRatingCount})`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
}

export async function getCacheMap(db: Db, ids: string[]): Promise<Map<string, CachedPlace>> {
  const out = new Map<string, CachedPlace>();
  for (const part of chunk(ids, 500)) {
    const rows = await db.select().from(placeCache).where(inArray(placeCache.placeId, part));
    for (const r of rows) out.set(r.placeId, r);
  }
  return out;
}

/** Google verisinin saklama üst sınırı (gün). Koordinatlar için Google şartlarındaki üst sınır 30 gündür. */
export const MAX_GOOGLE_RETENTION_DAYS = 30;

/**
 * Süresi dolan Google verisini temizler: eski koordinatlar NULL'lanır, eski önbellek satırları silinir.
 * Place ID ve bizim türettiğimiz bayraklar kalır; yeniden gerektiğinde Place Details ile yenilenir.
 */
export async function purgeExpiredGoogleData(
  db: Db,
  retentionDays: number,
  now: number = Date.now(),
): Promise<{ coordinates: number; cacheRows: number }> {
  const days = Math.min(Math.max(retentionDays, 1), MAX_GOOGLE_RETENTION_DAYS);
  const cutoff = now - days * 86_400_000;
  const coords = await db
    .update(places)
    .set({ lat: null, lng: null })
    .where(and(isNotNull(places.lat), lt(places.coordsFetchedAt, cutoff)))
    .returning({ id: places.placeId });
  const cache = await db
    .delete(placeCache)
    .where(lt(placeCache.fetchedAt, cutoff))
    .returning({ id: placeCache.placeId });
  return { coordinates: coords.length, cacheRows: cache.length };
}

/** Tüm Google verisini siler (önbellek + koordinatlar). Kullanıcı "Google verilerini sil" dediğinde çalışır. */
export async function clearGoogleData(db: Db): Promise<{ coordinates: number; cacheRows: number }> {
  const coords = await db
    .update(places)
    .set({ lat: null, lng: null })
    .where(isNotNull(places.lat))
    .returning({ id: places.placeId });
  const cache = await db.delete(placeCache).returning({ id: placeCache.placeId });
  return { coordinates: coords.length, cacheRows: cache.length };
}
