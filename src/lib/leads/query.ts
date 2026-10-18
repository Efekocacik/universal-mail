import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { categorySets, leads, placeSnapshots, places } from "@/lib/db/schema";
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
  /** "Son taramada bulunamadı" işaretlileri göster (true) veya gizle (false). */
  notFound?: boolean;
}

export type LeadSort = "novelty" | "name" | "recent";

export interface LeadRow {
  leadId: number;
  placeId: string | null;
  source: string;
  name: string;
  address: string | null;
  city: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
  primaryType: string | null;
  businessStatus: string | null;
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
}

const LIST_COLUMNS = {
  leadId: leads.id,
  placeId: leads.placeId,
  source: leads.source,
  name: places.name,
  address: places.formattedAddress,
  city: places.city,
  countryCode: places.countryCode,
  lat: places.lat,
  lng: places.lng,
  primaryType: places.primaryType,
  businessStatus: places.businessStatus,
  openingDate: places.openingDate,
  noveltyScore: leads.noveltyScore,
  noveltyLabel: leads.noveltyLabel,
  leadStatus: leads.status,
  website: places.website,
  phone: places.phone,
  userRatingCount: places.userRatingCount,
  firstSeenAt: places.firstSeenAt,
  newDetectedAt: places.newDetectedAt,
  openedDetectedAt: places.openedDetectedAt,
  notFoundScan: places.notFoundInScanId,
  enrichedAt: places.enrichedAt,
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Süzgeçleri SQL koşuluna çevirir. Tüm değerler parametrelidir. */
export async function buildWhere(db: Db, f: LeadFilters): Promise<SQL | undefined> {
  const conds: (SQL | undefined)[] = [];
  if (f.q?.trim()) {
    const pattern = `%${escapeLike(f.q.trim())}%`;
    conds.push(
      or(
        sql`${places.name} LIKE ${pattern} ESCAPE '\\'`,
        sql`${places.formattedAddress} LIKE ${pattern} ESCAPE '\\'`,
        sql`${places.city} LIKE ${pattern} ESCAPE '\\'`,
      ),
    );
  }
  if (f.countries?.length) conds.push(inArray(places.countryCode, f.countries));
  if (f.city) conds.push(eq(places.city, f.city));
  if (f.categories?.length) {
    const rows = await db
      .select({ types: categorySets.placeTypes })
      .from(categorySets)
      .where(inArray(categorySets.key, f.categories));
    const types = [...new Set(rows.flatMap((r) => r.types))];
    conds.push(types.length ? inArray(places.primaryType, types) : sql`0`);
  }
  if (f.novelty?.length) conds.push(inArray(leads.noveltyLabel, f.novelty));
  if (f.leadStatus?.length) conds.push(inArray(leads.status, f.leadStatus));
  if (f.businessStatus?.length) conds.push(inArray(places.businessStatus, f.businessStatus));
  if (f.source?.length) conds.push(inArray(leads.source, f.source));
  if (f.bbox) {
    conds.push(
      gte(places.lat, f.bbox.south),
      lte(places.lat, f.bbox.north),
      gte(places.lng, f.bbox.west),
      lte(places.lng, f.bbox.east),
    );
  }
  if (f.hasWebsite === true) conds.push(sql`${places.website} IS NOT NULL`);
  if (f.hasWebsite === false) conds.push(sql`${places.website} IS NULL`);
  if (f.ratingMin !== undefined) conds.push(gte(places.userRatingCount, f.ratingMin));
  if (f.ratingMax !== undefined) conds.push(lte(places.userRatingCount, f.ratingMax));
  if (f.scanId !== undefined) {
    conds.push(
      sql`${places.placeId} IN (SELECT place_id FROM ${placeSnapshots} WHERE scan_id = ${f.scanId})`,
    );
  }
  if (f.notFound === true) conds.push(sql`${places.notFoundInScanId} IS NOT NULL`);
  if (f.notFound === false) conds.push(sql`${places.notFoundInScanId} IS NULL`);
  const real = conds.filter((c): c is SQL => c !== undefined);
  return real.length ? and(...real) : undefined;
}

function toRow(r: Record<string, unknown>): LeadRow {
  const x = r as { notFoundScan: number | null; enrichedAt: number | null } & Omit<
    LeadRow,
    "notFound" | "enriched"
  >;
  const { notFoundScan, enrichedAt, ...rest } = x;
  return { ...rest, notFound: notFoundScan !== null, enriched: enrichedAt !== null };
}

export async function queryLeads(
  db: Db,
  filters: LeadFilters,
  opts: { sort?: LeadSort; limit?: number; offset?: number } = {},
): Promise<{ rows: LeadRow[]; total: number }> {
  const where = await buildWhere(db, filters);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const order =
    opts.sort === "name"
      ? [asc(sql`lower(${places.name})`), asc(leads.id)]
      : opts.sort === "recent"
        ? [desc(places.firstSeenAt), desc(leads.id)]
        : [desc(leads.noveltyScore), desc(places.firstSeenAt), asc(leads.id)];

  const base = db
    .select(LIST_COLUMNS)
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId));
  const rows = await (where ? base.where(where) : base)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  const countBase = db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId));
  const total = Number((await (where ? countBase.where(where) : countBase))[0]?.n ?? 0);
  return { rows: rows.map(toRow), total };
}

export const LABEL_CODE: Record<NoveltyLabel, number> = {
  future_opening: 0,
  high: 1,
  likely: 2,
  low: 3,
};

/** Harita için hafif nokta listesi: [leadId, lat, lng, etiketKodu, durumKodu]. En fazla `max` nokta. */
export async function queryPoints(
  db: Db,
  filters: LeadFilters,
  max = 20_000,
): Promise<{ points: number[][]; total: number; truncated: boolean }> {
  const where = await buildWhere(db, filters);
  const base = db
    .select({
      id: leads.id,
      lat: places.lat,
      lng: places.lng,
      label: leads.noveltyLabel,
      status: leads.status,
    })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId));
  const rows = await (where ? base.where(where) : base)
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
    points: used.map((r) => [r.id, r.lat, r.lng, LABEL_CODE[r.label], statusCode(r.status)]),
    total: used.length,
    truncated,
  };
}

export async function getLeadDetail(db: Db, leadId: number) {
  const rows = await db
    .select({ lead: leads, place: places })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .where(eq(leads.id, leadId))
    .limit(1);
  return rows[0];
}

export interface Facets {
  countries: { code: string; count: number }[];
  cities: { name: string; count: number }[];
  novelty: Record<string, number>;
  leadStatus: Record<string, number>;
  businessStatus: Record<string, number>;
  total: number;
}

/** Süzgeç seçenekleri ve sayıları. Ülke/şehir listeleri tüm veriden, diğerleri verilen süzgeçlerden hesaplanır. */
export async function queryFacets(db: Db, filters: LeadFilters): Promise<Facets> {
  const countries = await db
    .select({ code: places.countryCode, n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .where(sql`${places.countryCode} IS NOT NULL`)
    .groupBy(places.countryCode)
    .orderBy(desc(sql`count(*)`));

  const cityConds: SQL[] = [sql`${places.city} IS NOT NULL`];
  if (filters.countries?.length) cityConds.push(inArray(places.countryCode, filters.countries));
  const cities = await db
    .select({ name: places.city, n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId))
    .where(and(...cityConds))
    .groupBy(places.city)
    .orderBy(desc(sql`count(*)`))
    .limit(200);

  const where = await buildWhere(db, {
    ...filters,
    novelty: undefined,
    leadStatus: undefined,
    businessStatus: undefined,
  });
  const group = async (
    col: typeof leads.noveltyLabel | typeof leads.status | typeof places.businessStatus,
  ) => {
    const base = db
      .select({ k: col, n: sql<number>`count(*)` })
      .from(leads)
      .innerJoin(places, eq(leads.placeId, places.placeId));
    const rows = await (where ? base.where(where) : base).groupBy(col);
    return Object.fromEntries(rows.filter((r) => r.k).map((r) => [r.k as string, Number(r.n)]));
  };
  const [novelty, leadStatus, businessStatus] = await Promise.all([
    group(leads.noveltyLabel),
    group(leads.status),
    group(places.businessStatus),
  ]);
  const totalBase = db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .innerJoin(places, eq(leads.placeId, places.placeId));
  const total = Number((await (where ? totalBase.where(where) : totalBase))[0]?.n ?? 0);

  return {
    countries: countries.map((c) => ({ code: c.code as string, count: Number(c.n) })),
    cities: cities.map((c) => ({ name: c.name as string, count: Number(c.n) })),
    novelty,
    leadStatus,
    businessStatus,
    total,
  };
}
