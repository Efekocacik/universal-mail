import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import {
  campaignLeads,
  leadEmails,
  leadEnrichment,
  leads,
  placeSnapshots,
  places,
  registryCompanies,
} from "@/lib/db/schema";
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
  source?: LeadSource[];
  /**
   * Faz 5 (paket R): resmî sicil eşleşmesi. `true`: lead'in yeri bir sicil kaydıyla eşleşmiş (otomatik/elle) VEYA lead
   * bir sicil kaydından oluşturulmuş; `false`: hiçbiri.
   */
  registryMatch?: boolean;
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
  /**
   * Faz 4: arşiv görünümü. Varsayılan (undefined/false) arşivlenmiş lead'leri GİZLER (`LEAD_NOT_ARCHIVED`); `true`
   * YALNIZCA arşivlenmişleri gösterir. Arşiv yumuşak silmedir; bkz. schema.ts `leads.archivedAt`. `"any"` (yalnızca
   * sunucu içi, açık `ids` ile): arşiv durumuna bakılmaz; kullanıcının ekranda seçtiği satırlar neyse o işlenir.
   */
  archived?: boolean | "any";
  /**
   * Faz 4 (paket C): açık lead kimlikleri (toplu işlemler, seçimle dışa aktarma). Tek bir JSON parametresiyle
   * `json_each` üzerinden uygulanır; böylece 2000 kimlik SQLite değişken sınırına takılmaz. Diğer süzgeçlerle VE'lenir.
   */
  ids?: number[];
  /**
   * Faz 4: yaşam döngüsü süzgeci (birden çoğu VEYA'lanır). `opened`: yakında açılacakken açıldığı tespit edilenler,
   * `future`: hâlâ açılışı beklenenler, `new`: yeni tespit edilenler. Gösterge paneli ve bildirim bağlantıları kullanır.
   */
  lifecycle?: LeadLifecycle[];
  /**
   * Faz 4: tespit zamanı alt sınırı (epoch ms, dahil). `lifecycle` ile birlikte her değerin kendi tespit zamanına
   * uygulanır (`opened` → açılış tespiti, `new` → yeni tespiti, `future` → ilk görülme); tek başına "yeni veya açıldı
   * olarak bu tarihten beri tespit edilenler" demektir.
   */
  detectedSince?: number;
}

/** Süzgeçlerin denetim kaydına yazılacak özeti (kimlik listesi ve arama metni yazılmaz). */
export function auditFilterSummary(filters: LeadFilters): Record<string, unknown> {
  const { ids, q, ...rest } = filters;
  return {
    ...rest,
    ...(ids ? { ids: ids.length } : {}),
    ...(q ? { q: true } : {}),
  };
}

export const LEAD_LIFECYCLES = ["opened", "future", "new"] as const;
/** Lead kaynakları (Faz 5: `registry` sicilden, `import` CSV/XLSX'ten; ikisinin de yer kimliği olmayabilir). */
export const LEAD_SOURCES = ["google", "demo", "registry", "import"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Sicil eşleşmesi koşulu (iki ayrı EXISTS: her biri kendi kısmi indeksini kullanır). */
export const REGISTRY_MATCHED = sql`(EXISTS (SELECT 1 FROM ${registryCompanies} rc WHERE rc.matched_place_id = ${leads.placeId} AND rc.match_status IN ('matched', 'manual')) OR EXISTS (SELECT 1 FROM ${registryCompanies} rc WHERE rc.lead_id = ${leads.id}))`;
export type LeadLifecycle = (typeof LEAD_LIFECYCLES)[number];

/** `lifecycle`/`detectedSince` koşulu (ikisi de yoksa undefined). Tüm değerler parametrelidir. */
export function lifecycleCondition(
  lifecycle: readonly LeadLifecycle[] | undefined,
  since: number | undefined,
): SQL | undefined {
  const after = (col: typeof places.openedDetectedAt | typeof places.newDetectedAt) =>
    since === undefined ? sql`${col} IS NOT NULL` : sql`${col} >= ${since}`;
  const one = (l: LeadLifecycle): SQL => {
    if (l === "opened") return after(places.openedDetectedAt);
    if (l === "new") return after(places.newDetectedAt);
    const base = sql`(${places.wasFuture} = 1 AND ${places.isClosed} = 0)`;
    return since === undefined ? base : sql`(${base} AND ${places.firstSeenAt} >= ${since})`;
  };
  if (lifecycle?.length) return or(...[...new Set(lifecycle)].map(one));
  if (since !== undefined) return or(after(places.newDetectedAt), after(places.openedDetectedAt));
  return undefined;
}

/**
 * Arşivlenmemiş lead koşulu. `buildWhere` bunu varsayılan olarak ekler; lead listesini/sayısını/dışa aktarımını
 * `buildWhere` DIŞINDA kendi sorgusuyla okuyan kod bu koşulu açıkça eklemelidir (arşiv yumuşak silmedir).
 */
export const LEAD_NOT_ARCHIVED = sql`${leads.archivedAt} IS NULL`;

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

/**
 * Kalıcı bayraklardan türetilen iş durumu (önbellek boşken bile süzgeç ve sayımlar çalışsın diye). Faz 4: gösterge paneli
 * gibi başka okuma modelleri aynı tanımı kullansın diye dışa açıktır (`places` birleştirmesi gerekir).
 */
export const DERIVED_STATUS = sql<string>`CASE WHEN ${places.isClosed} THEN 'CLOSED_PERMANENTLY' WHEN ${places.wasFuture} THEN 'FUTURE_OPENING' ELSE 'OPERATIONAL' END`;
/**
 * Lead'in e-posta durumu: işlem sürüyorsa o, sonuç varsa SRS durumu, aksi halde işlem durumu; hiç denenmemişse "unchecked".
 * Faz 4: dışa açıktır (`lead_enrichment` LEFT JOIN gerekir).
 */
export const EMAIL_STATE = sql<string>`CASE
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
  // Faz 5: Google sitesi yoksa kullanıcının verdiği site (içe aktarma/sicil `leads.website`; Google lead'lerinde boş).
  website: sql<string | null>`coalesce(${placeCache.website}, ${leads.website})`,
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
  const conds: (SQL | undefined)[] = [
    f.archived === "any"
      ? undefined
      : f.archived === true
        ? sql`${leads.archivedAt} IS NOT NULL`
        : LEAD_NOT_ARCHIVED,
  ];
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
  if (f.registryMatch === true) conds.push(REGISTRY_MATCHED);
  if (f.registryMatch === false) conds.push(sql`NOT ${REGISTRY_MATCHED}`);
  if (f.bbox) {
    conds.push(
      gte(places.lat, f.bbox.south),
      lte(places.lat, f.bbox.north),
      gte(places.lng, f.bbox.west),
      lte(places.lng, f.bbox.east),
    );
  }
  if (f.hasWebsite === true)
    conds.push(sql`coalesce(${placeCache.website}, ${leads.website}) IS NOT NULL`);
  if (f.hasWebsite === false)
    conds.push(sql`coalesce(${placeCache.website}, ${leads.website}) IS NULL`);
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
  if (f.ids) {
    // Boş kimlik listesi "hiçbiri" demektir (tümü değil).
    conds.push(
      f.ids.length
        ? sql`${leads.id} IN (SELECT value FROM json_each(${JSON.stringify(f.ids)}))`
        : sql`0`,
    );
  }
  conds.push(lifecycleCondition(f.lifecycle, f.detectedSince));
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

/*
 * Faz 5: liste/sayı/yüz/kimlik sorguları `places`'a LEFT JOIN yapar; böylece yer kimliği olmayan lead'ler (sicilden veya
 * içe aktarmadan, `place_id` NULL) da listelenir. Yer alanları (konum, tespit zamanları, türetilmiş durum) bu satırlarda
 * NULL'dur; `DERIVED_STATUS` NULL bayraklarda 'OPERATIONAL' döner, bbox/tarama/yaşam döngüsü süzgeçleri onları doğal
 * olarak dışarıda bırakır. Harita noktaları (`queryPoints`) ve önbelleksiz yer listesi yer gerektirdiği için INNER kalır.
 */
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

  // Faz 6 (NFR-03): geç satır okuma. Sayfanın kimlikleri önce yalnızca sıralama anahtarlarıyla seçilir; geniş liste
  // sütunları (önbellek, zenginleştirme, birincil e-posta) yalnızca o ≤ 500 satır için okunur. Önceden sıralayıcı tüm
  // eşleşen satırları bütün sütunlarıyla taşıyordu (100k'da derin sayfa ~230 ms). Sıralar `leads.id` ile biter, bu
  // yüzden iç ve dış sıra aynıdır.
  const pageIdsBase = db
    .select({ id: leads.id })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const pageIds = (where ? pageIdsBase.where(where) : pageIdsBase)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  const rows = await db
    .select(LIST_COLUMNS)
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id))
    .leftJoin(leadEmails, and(eq(leadEmails.leadId, leads.id), eq(leadEmails.isPrimary, true)))
    .where(inArray(leads.id, pageIds))
    .orderBy(...order);
  const countBase = db
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
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
  // Faz 6 (NFR-03): dört sayım ve toplam TEK geçişte hesaplanır. Dört süzgeç de bu `where`'den çıkarıldığı için her
  // boyutun sayımı aynı satır kümesindendir; çapraz tablo (en çok 4×9×3×12 grup) JS'te boyutlara toplanır. Önceden beş
  // ayrı tam tarama yapılıyordu (100k'da tek bağlantıda sıralı ~270–390 ms; tek geçiş bunun yaklaşık beşte biri).
  const crossBase = db
    .select({
      novelty: leads.noveltyLabel,
      status: leads.status,
      business: DERIVED_STATUS,
      email: EMAIL_STATE,
      n: sql<number>`count(*)`,
      // Yer kimliği olmayan (sicil/içe aktarma) lead'lerin yüklenecek Google verisi yoktur; sayılmaz.
      uncached: sql<number>`coalesce(sum(case when ${leads.placeId} IS NOT NULL AND ${placeCache.placeId} IS NULL then 1 else 0 end), 0)`,
    })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const cross = await (where ? crossBase.where(where) : crossBase).groupBy(
    sql`1`,
    sql`2`,
    sql`3`,
    sql`4`,
  );
  const novelty: Record<string, number> = {};
  const leadStatus: Record<string, number> = {};
  const businessStatus: Record<string, number> = {};
  const emailStatus: Record<string, number> = {};
  const add = (into: Record<string, number>, k: string | null, n: number) => {
    if (k) into[k] = (into[k] ?? 0) + n;
  };
  let total = 0;
  let uncached = 0;
  for (const r of cross) {
    const n = Number(r.n);
    add(novelty, r.novelty, n);
    add(leadStatus, r.status, n);
    add(businessStatus, r.business, n);
    add(emailStatus, r.email, n);
    total += n;
    uncached += Number(r.uncached);
  }

  return {
    countries: countries.map((c) => ({ code: c.code as string, count: Number(c.n) })),
    cities: cities.map((c) => ({ name: c.name as string, count: Number(c.n) })),
    categories: categories.map((c) => ({ key: c.key as string, count: Number(c.n) })),
    novelty,
    leadStatus,
    businessStatus,
    emailStatus,
    total,
    uncached,
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

export interface LeadIdQueryOptions {
  /**
   * Kampanyaya süzgeçle sayfa sayfa ekleme: bu kampanyada `excluded` DIŞINDAKİ bir durumda bulunan lead'ler atlanır.
   * `excluded` satırlar seçilebilir kalır (ekleme onları yeniden değerlendirir), ama hiç eklenmemiş lead'lerden SONRA
   * ve en uzun süredir değerlendirilmemişten başlayarak gelir; böylece art arda tıklamalar hep ilerler.
   */
  notInCampaignId?: number;
  /** `false`: `excluded` satırı olan lead'ler de atlanır (yalnızca kampanyaya hiç eklenmemiş olanlar). */
  includeExcluded?: boolean;
  /**
   * Ek koşul (süzgeçle VE'lenir; `LIMIT`'ten ÖNCE uygulanır). Sınırlı (2000) toplu işlemler bununla yalnızca HÂLÂ
   * işlenmesi gereken lead'leri seçer; böylece aynı süzgeçle yeniden çalıştırma hep sıradakilere ilerler.
   * `leads`, `places`, `place_cache` ve `lead_enrichment` (LEFT JOIN) sütunlarına başvurabilir.
   */
  where?: SQL;
}

function campaignMembership(opts: LeadIdQueryOptions): SQL | undefined {
  if (opts.notInCampaignId === undefined) return undefined;
  const status = opts.includeExcluded === false ? sql`` : sql` AND cl.status <> 'excluded'`;
  return sql`NOT EXISTS (SELECT 1 FROM ${campaignLeads} cl WHERE cl.campaign_id = ${opts.notInCampaignId} AND cl.lead_id = ${leads.id}${status})`;
}

/** Süzgece uyan lead kimlikleri (toplu işlemler için; en fazla `limit`). */
export async function queryLeadIds(
  db: Db,
  filters: LeadFilters,
  limit = 2000,
  opts: LeadIdQueryOptions = {},
): Promise<number[]> {
  const where = and(await buildWhere(db, filters), campaignMembership(opts), opts.where);
  const base = db
    .select({ id: leads.id })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  // Kampanyada hiç olmayanlar önce (NULL), sonra en eski değerlendirilmiş `excluded` satırlar.
  const order: SQL[] =
    opts.notInCampaignId === undefined
      ? []
      : [
          sql`(SELECT cl.updated_at FROM ${campaignLeads} cl WHERE cl.campaign_id = ${opts.notInCampaignId} AND cl.lead_id = ${leads.id}) ASC NULLS FIRST`,
        ];
  const rows = await (where ? base.where(where) : base)
    .orderBy(...order, desc(leads.noveltyScore), asc(leads.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** `queryLeadIds` ile aynı süzgeç ve kampanya koşuluna uyan lead sayısı (sınırsız). */
export async function countLeadIds(
  db: Db,
  filters: LeadFilters,
  opts: LeadIdQueryOptions = {},
): Promise<number> {
  const where = and(await buildWhere(db, filters), campaignMembership(opts), opts.where);
  const base = db
    .select({ n: sql<number>`count(DISTINCT ${leads.id})` })
    .from(leads)
    .leftJoin(places, eq(leads.placeId, places.placeId))
    .leftJoin(placeCache, eq(places.placeId, placeCache.placeId))
    .leftJoin(leadEnrichment, eq(leadEnrichment.leadId, leads.id));
  const [r] = await (where ? base.where(where) : base);
  return Number(r?.n ?? 0);
}
