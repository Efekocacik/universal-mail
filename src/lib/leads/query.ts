import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { leadEmails, leadEnrichment, leads, placeSnapshots, places } from "@/lib/db/schema";
import type { LeadStatus } from "@/lib/db/schema";
import type { BBox, NoveltyLabel } from "@/lib/domain/types";

export interface LeadFilters {
  q?: string;
  countries?: string[];
  city?: string;
  categories?: string[];
  novelty?: NoveltyLabel[];
  leadStatus?: LeadStatus[];
  businessStatus?: string[];
  source?: ("google" | "demo")[];
  bbox?: BBox;
  hasWebsite?: boolean;
  ratingMin?: number;
  ratingMax?: number;
  scanId?: number;
  /**
   * E-posta durumu (Faz 2): found_verified, found_unverified, generic, not_found, invalid (SRS email_status) ve
   * işlem durumları unchecked, queued, running, no_website, needs_google, blocked, failed.
   */
  emailStatus?: string[];
  /** "Son taramada bulunamadı" işaretlileri göster (true) veya gizle (false). */
  notFound?: boolean;
}

export type LeadSort = "novelty" | "name" | "recent";

/**
 * Liste satırı. Ad, adres, web sitesi, telefon gibi Google alanları yalnızca oturum önbelleğinde (`place_cache`) bulunur;
 * uygulama yeniden açıldıktan sonra boştur ve `cached=false` olur (Yenile ile geri yüklenir). Konum (lat/lng) en çok 30 gün saklanır.
 */
export interface LeadRow {
  leadId: number;
  placeId: string | null;
  source: string;
  /** Önbellekteki Google adı; yoksa kullanıcının/sitenin verdiği görünen ad; ikisi de yoksa null. */
  name: string | null;
  /** Kendi kaydımız: kullanıcı veya işletmenin kendi sitesi. */
  displayName: string | null;
  address: string | null;
  city: string | null;
  countryCode: string | null;
  categoryKey: string | null;
  lat: number | null;
  lng: number | null;
  primaryType: string | null;
  /** Önbellekteki durum; yoksa türetilmiş bayraklardan (FUTURE_OPENING / CLOSED_PERMANENTLY / OPERATIONAL). */
  businessStatus: string;
  openingDate: string | null;
  noveltyScore: number;
  noveltyLabel: NoveltyLabel;
  leadStatus: LeadStatus;
  website: string | null;
  phone: string | null;
  userRatingCount: number | null;
  firstSeenAt: number | null;
  newDetectedAt: number | null;
  openedDetectedAt: number | null;
  notFound: boolean;
  enriched: boolean;
  /** Google verisi (ad, adres...) şu an önbellekte mi? */
  cached: boolean;
  /** E-posta durumu özeti (bkz. LeadFilters.emailStatus). */
  emailState: string;
  /** Birincil e-posta adresi (işletmenin kendi sitesinden bulunan; bizim verimiz). */
  primaryEmail: string | null;
  primaryEmailKind: string | null;
}

/** Kalıcı bayraklardan türetilen iş durumu (önbellek boşken bile süzgeç ve sayımlar çalışsın diye). */
const DERIVED_STATUS = sql<string>`CASE WHEN ${places.isClosed} THEN 'CLOSED_PERMANENTLY' WHEN ${places.wasFuture} THEN 'FUTURE_OPENING' ELSE 'OPERATIONAL' END`;
/**
 * Lead'in e-posta durumu: işlem sürüyorsa o, sonuç varsa SRS durumu, aksi halde işlem durumu; hiç denenmemişse "unchecked".
 */
const EMAIL_STATE = sql<string>`CASE
  WHEN ${leadEnrichment.leadId} IS NULL THEN 'unchecked'
  WHEN ${leadEnrichment.status} IN ('queued','running') THEN ${leadEnrichment.status}
  WHEN ${leadEnrichment.emailStatus} IS NOT NULL THEN ${leadEnrichment.emailStatus}
  ELSE ${leadEnrichment.status}
END`;
const DISPLAY_NAME = sql<string | null>`coalesce(${placeCache.name}, ${leads.displayName})`;

const LIST_COLUMNS = {
  leadId: leads.id,
  placeId: leads.placeId,
  source: leads.source,
  cacheName: placeCache.name,
  displayName: leads.displayName,
  address: placeCache.formattedAddress,
  city: leads.city,
  countryCode: leads.countryCode,
  categoryKey: leads.categoryKey,
  lat: places.lat,
  lng: places.lng,
  primaryType: placeCache.primaryType,
  cacheStatus: placeCache.businessStatus,
  derivedStatus: DERIVED_STATUS,
  openingDate: placeCache.openingDate,
  noveltyScore: leads.noveltyScore,
  noveltyLabel: leads.noveltyLabel,
  leadStatus: leads.status,
  website: placeCache.website,
  phone: placeCache.phone,
  userRatingCount: placeCache.userRatingCount,
  firstSeenAt: places.firstSeenAt,
  newDetectedAt: places.newDetectedAt,
  openedDetectedAt: places.openedDetectedAt,
  notFoundScan: places.notFoundInScanId,
  enrichedAt: placeCache.enrichedAt,
  fetchedAt: placeCache.fetchedAt,
  emailState: EMAIL_STATE,
  primaryEmail: leadEmails.email,
  primaryEmailKind: leadEmails.kind,
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Süzgeçleri SQL koşuluna çevirir. Tüm değerler parametrelidir.
 * Ad/adres/web sitesi/değerlendirme süzgeçleri yalnızca önbellekteki (yüklü) satırlara uygulanabilir;
 * ülke, şehir, kategori, durum ve yenilik süzgeçleri kalıcı kayıtlara dayanır ve her zaman çalışır.
 */
export async function buildWhere(_db: Db, f: LeadFilters): Promise<SQL | undefined> {
  const conds: (SQL | undefined)[] = [];
  if (f.q?.trim()) {
    const pattern = `%${escapeLike(f.q.trim())}%`;
    conds.push(
      or(
        sql`${placeCache.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${placeCache.formattedAddress} LIKE ${pattern} ESCAPE '\\'`,
        sql`${leads.displayName} LIKE ${pattern} ESCAPE '\\'`,
        sql`${leads.city} LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  if (f.countries?.length) conds.push(inArray(leads.countryCode, f.countries));
  if (f.city) conds.push(eq(leads.city, f.city));
  if (f.categories?.length) conds.push(inArray(leads.categoryKey, f.categories));
  if (f.novelty?.length) conds.push(inArray(leads.noveltyLabel, f.novelty));
  if (f.leadStatus?.length) conds.push(inArray(leads.status, f.leadStatus));
  if (f.businessStatus?.length) conds.push(inArray(DERIVED_STATUS, f.businessStatus));
  if (f.source?.length) conds.push(inArray(leads.source, f.source));
  if (f.bbox) {
    conds.push(
      gte(places.lat, f.bbox.south),
      lte(places.lat, f.bbox.north),
      gte(places.lng, f.bbox.west),
      lte(places.lng, f.bbox.east),
    );
  }
  if (f.hasWebsite === true) conds.push(sql`${placeCache.website} IS NOT NULL`);
  if (f.hasWebsite === false) conds.push(sql`${placeCache.website} IS NULL`);
  if (f.ratingMin !== undefined) conds.push(gte(placeCache.userRatingCount, f.ratingMin));
  if (f.ratingMax !== undefined) conds.push(lte(placeCache.userRatingCount, f.ratingMax));
  if (f.scanId !== undefined) {
    conds.push(
      sql`${places.placeId} IN (SELECT place_id FROM ${placeSnapshots} WHERE scan_id = ${f.scanId})`,
    );
  }
  if (f.notFound === true) conds.push(sql`${places.notFoundInScanId} IS NOT NULL`);
  if (f.notFound === false) conds.push(sql`${places.notFoundInScanId} IS NULL`);
  if (f.emailStatus?.length) conds.push(inArray(EMAIL_STATE, f.emailStatus));
  const real = conds.filter((c): c is SQL => c !== undefined);
  return real.length ? and(...real) : undefined;
}

function toRow(r: Record<string, unknown>): LeadRow {
  const x = r as {
    cacheName: string | null;
    cacheStatus: string | null;
    derivedStatus: string;
    notFoundScan: number | null;
    enrichedAt: number | null;
    fetchedAt: number | null;
  } & Omit<LeadRow, "name" | "businessStatus" | "notFound" | "enriched" | "cached">;
  const { cacheName, cacheStatus, derivedStatus, notFoundScan, enrichedAt, fetchedAt, ...rest } = x;
  return {
    ...rest,
    name: cacheName ?? rest.displayName ?? null,
    businessStatus: cacheStatus ?? derivedStatus,
    notFound: notFoundScan !== null,
    enriched: enrichedAt !== null,
    cached: fetchedAt !== null,
  };
}

export async function queryLeads(
  db: Db,
  filters: LeadFilters,
  opts: { sort?: LeadSort; limit?: number; offset?: number } = {},
): Promise<{ rows: LeadRow[]; total: number }> {
  const where = await buildWhere(db, filters);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Adı olmayanlar (önbellek boş ve görünen ad yok) sona gider.
  const order =
    opts.sort === "name"
      ? [asc(sql`${DISPLAY_NAME} IS NULL`), asc(sql`lower(${DISPLAY_NAME})`), asc(leads.id)]
      : opts.sort === "recent"
        ? [desc(places.firstSeenAt), desc(leads.id)]
        : [desc(leads.noveltyScore), desc(places.firstSeenAt), asc(leads.id)];

  const base = db
    .select(LIST_COLUMNS)
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .leftJoin(leadEmails, and(eq(leadEmails.leadId, leads.id), eq(leadEmails.isPrimary, true)));
  const rows = await (where ? base.where(where) : base)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  const countBase = db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const total = Number((await (where ? countBase.where(where) : countBase))[0]?.n ?? 0);
  return { rows: rows.map(toRow), total };
}

export const LABEL_CODE: Record<NoveltyLabel, number> = {
  future_opening: 0,
  high: 1,
  likely: 2,
  low: 3,
};

/**
 * Harita için hafif nokta listesi: [leadId, lat, lng, etiketKodu, durumKodu]. En fazla `max` nokta.
 * Konumu olmayan (30 günü aşan veya silinen) kayıtlar haritada gösterilmez.
 */
export async function queryPoints(
  db: Db,
  filters: LeadFilters,
  max = 20_000,
): Promise<{ points: number[][]; total: number; truncated: boolean }> {
  const where = await buildWhere(db, filters);
  const withCoords = where
    ? and(where, sql`${places.lat} IS NOT NULL`, sql`${places.lng} IS NOT NULL`)
    : and(sql`${places.lat} IS NOT NULL`, sql`${places.lng} IS NOT NULL`);
  const rows = await db
    .select({
      id: leads.id,
      lat: places.lat,
      lng: places.lng,
      label: leads.noveltyLabel,
      status: leads.status,
    })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .where(withCoords)
    .orderBy(desc(leads.noveltyScore), asc(leads.id))
    .limit(max + 1);
  const truncated = rows.length > max;
  const used = truncated ? rows.slice(0, max) : rows;
  // Durum kodu: 0 temas yok, 1 gönderildi/kuyrukta, 2 yanıt/müşteri, 3 ilgilenmiyor/engelli
  const statusCode = (s: string) =>
    s === "new" || s === "enriched"
      ? 0
      : s === "sent" || s === "queued"
        ? 1
        : s === "replied" || s === "customer"
          ? 2
          : 3;
  return {
    points: used.map((r) => [
      r.id,
      r.lat as number,
      r.lng as number,
      LABEL_CODE[r.label],
      statusCode(r.status),
    ]),
    total: used.length,
    truncated,
  };
}

export async function getLeadDetail(db: Db, leadId: number) {
  const rows = await db
    .select({ lead: leads, place: places, cache: placeCache })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(leads.placeId, placeCache.placeId))
    .where(eq(leads.id, leadId))
    .limit(1);
  return rows[0];
}

export interface Facets {
  countries: { code: string; count: number }[];
  cities: { name: string; count: number }[];
  categories: { key: string; count: number }[];
  novelty: Record<string, number>;
  leadStatus: Record<string, number>;
  businessStatus: Record<string, number>;
  /** E-posta durumu → lead sayısı (Faz 2). */
  emailStatus: Record<string, number>;
  total: number;
  /** Listedeki Google verisi yüklü olmayan (önbelleği boş) lead sayısı. */
  uncached: number;
}

/** Süzgeç seçenekleri ve sayıları. Ülke/şehir listeleri tüm veriden, diğerleri verilen süzgeçlerden hesaplanır. */
export async function queryFacets(db: Db, filters: LeadFilters): Promise<Facets> {
  const countries = await db
    .select({ code: leads.countryCode, n: sql<number>`count(*)` })
    .from(leads)
    .where(sql`${leads.countryCode} IS NOT NULL`)
    .groupBy(leads.countryCode)
    .orderBy(desc(sql`count(*)`));

  const cityConds: SQL[] = [sql`${leads.city} IS NOT NULL`];
  if (filters.countries?.length) cityConds.push(inArray(leads.countryCode, filters.countries));
  const cities = await db
    .select({ name: leads.city, n: sql<number>`count(*)` })
    .from(leads)
    .where(and(...cityConds))
    .groupBy(leads.city)
    .orderBy(desc(sql`count(*)`))
    .limit(200);

  const categories = await db
    .select({ key: leads.categoryKey, n: sql<number>`count(*)` })
    .from(leads)
    .where(sql`${leads.categoryKey} IS NOT NULL`)
    .groupBy(leads.categoryKey)
    .orderBy(desc(sql`count(*)`));

  const where = await buildWhere(db, {
    ...filters,
    novelty: undefined,
    leadStatus: undefined,
    businessStatus: undefined,
    emailStatus: undefined,
  });
  const group = async (
    col:
      typeof leads.noveltyLabel | typeof leads.status | typeof DERIVED_STATUS | typeof EMAIL_STATE,
  ) => {
    const base = db
      .select({ k: col, n: sql<number>`count(*)` })
      .from(leads)
      .innerJoin(places, eq(leads.placeId, places.placeId))
      .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
      .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
    const rows = await (where ? base.where(where) : base).groupBy(col);
    return Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k as string, Number(r.n)]));
  };
  // E-posta durumu sayımı kendi süzgecini hariç tutar (seçenekler ve sayıları birlikte görünsün).
  const [novelty, leadStatus, businessStatus, emailStatus] = await Promise.all([
    group(leads.noveltyLabel),
    group(leads.status),
    group(DERIVED_STATUS),
    group(EMAIL_STATE),
  ]);
  const totalBase = db
    .select({
      n: sql<number>`count(*)`,
      uncached: sql<number>`coalesce(sum(case when ${placeCache.placeId} IS NULL then 1 else 0 end), 0)`,
    })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const totals = (await (where ? totalBase.where(where) : totalBase))[0];

  return {
    countries: countries.map((c) => ({ code: c.code as string, count: Number(c.n) })),
    cities: cities.map((c) => ({ name: c.name as string, count: Number(c.n) })),
    categories: categories.map((c) => ({ key: c.key as string, count: Number(c.n) })),
    novelty,
    leadStatus,
    businessStatus,
    emailStatus,
    total: Number(totals?.n ?? 0),
    uncached: Number(totals?.uncached ?? 0),
  };
}

/** Süzgece uyan ve Google verisi (önbellek) yüklü OLMAYAN işletmelerin yer kimlikleri. */
export async function queryUncachedPlaceIds(
  db: Db,
  filters: LeadFilters,
  limit = 2000,
): Promise<string[]> {
  const where = await buildWhere(db, filters);
  const missing = sql`${placeCache.placeId} IS NULL`;
  const rows = await db
    .select({ placeId: places.placeId })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .where(where ? and(where, missing) : missing)
    .orderBy(desc(leads.noveltyScore), asc(leads.id))
    .limit(limit);
  return rows.map((r) => r.placeId);
}

/** Süzgece uyan lead kimlikleri (toplu işlemler için; en fazla `limit`). */
export async function queryLeadIds(db: Db, filters: LeadFilters, limit = 2000): Promise<number[]> {
  const where = await buildWhere(db, filters);
  const base = db
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const rows = await (where ? base.where(where) : base)
    .orderBy(desc(leads.noveltyScore), asc(leads.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
