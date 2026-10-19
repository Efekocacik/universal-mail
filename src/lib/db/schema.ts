import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  BBox,
  FieldProfile,
  JobStatus,
  NoveltyLabel,
  NoveltySignal,
  ScanProgress,
  ScanQuery,
  ScanStatus,
  SearchStrategy,
} from "@/lib/domain/types";

/* ---------------------------------------------------------------------------
 * Faz 1 şeması. Sonraki fazlar (e-posta, kampanya, suppression...) yeni tablolarla
 * EKLENİR; buradaki tabloların sütunlarını silmek/yeniden adlandırmak gerekmez.
 * Google kaynaklı alanlar `places` tablosunda toplanır; kullanıcıya ait alanlar
 * (durum, not, etiket) `leads` tablosundadır. Böylece saklama ve dışa aktarma kuralları
 * veri kaynağına göre ayrı uygulanabilir (SRS 8.1).
 * ------------------------------------------------------------------------- */

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export interface RegionGeometry {
  bbox: BBox;
  circle?: { lat: number; lng: number; radiusM: number };
  cityId?: number;
}

export const regions = sqliteTable("regions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").$type<"city" | "bbox" | "circle">().notNull(),
  countryCode: text("country_code"),
  geometry: text("geometry", { mode: "json" }).$type<RegionGeometry>().notNull(),
  gridSizeM: integer("grid_size_m"),
  scheduleDays: integer("schedule_days"),
  lastScanAt: integer("last_scan_at"),
  createdAt: integer("created_at").notNull(),
});

export const categorySets = sqliteTable(
  "category_sets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    placeTypes: text("place_types", { mode: "json" }).$type<string[]>().notNull(),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    priority: integer("priority").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("category_sets_key_uq").on(t.key)],
);

export const scans = sqliteTable(
  "scans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    regionId: integer("region_id")
      .notNull()
      .references(() => regions.id),
    scanKey: text("scan_key").notNull(),
    categorySetIds: text("category_set_ids", { mode: "json" }).$type<number[]>().notNull(),
    queries: text("queries", { mode: "json" }).$type<ScanQuery[]>().notNull(),
    strategy: text("strategy").$type<SearchStrategy>().notNull(),
    fieldProfile: text("field_profile").$type<FieldProfile>().notNull(),
    provider: text("provider").$type<"google" | "mock">().notNull(),
    status: text("status").$type<ScanStatus>().notNull(),
    pauseReason: text("pause_reason"),
    error: text("error"),
    estimate: text("estimate", { mode: "json" }).$type<unknown>(),
    callsBySku: text("calls_by_sku", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'`),
    costUsd: real("cost_usd").notNull().default(0),
    progress: text("progress", { mode: "json" })
      .$type<ScanProgress>()
      .notNull()
      .default(sql`'{}'`),
    isBaseline: integer("is_baseline", { mode: "boolean" }).notNull().default(false),
    comparedToScanId: integer("compared_to_scan_id"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("scans_key_idx").on(t.scanKey, t.status), index("scans_status_idx").on(t.status)],
);

export const scanUnits = sqliteTable(
  "scan_units",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scanId: integer("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    parentId: integer("parent_id"),
    depth: integer("depth").notNull().default(0),
    south: real("south").notNull(),
    west: real("west").notNull(),
    north: real("north").notNull(),
    east: real("east").notNull(),
    kind: text("kind").$type<SearchStrategy>().notNull(),
    termKind: text("term_kind").$type<"type" | "keyword">().notNull(),
    term: text("term").notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
    callsMade: integer("calls_made").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    saturated: integer("saturated", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("scan_units_scan_status_idx").on(t.scanId, t.status, t.depth, t.id)],
);

/**
 * Yerler: Google'ın SAKLANMASINA İZİN VERDİĞİ veya bizim türettiğimiz alanlar.
 *  - place_id süresiz saklanabilir.
 *  - lat/lng en fazla 30 gün saklanabilir; süre dolunca NULL'lanır (bkz. purgeExpiredGoogleData).
 *  - was_future / is_closed / *_detected_at bizim türettiğimiz analiz bayraklarıdır.
 * Ad, adres, telefon, web sitesi, tür, değerlendirme sayısı gibi Google içeriği BURADA TUTULMAZ; yalnızca uygulama
 * açıkken geçici "oturum önbelleği"nde (gcache.place_cache, bkz. cache-schema.ts) bulunur ve kapanışta silinir.
 */
export const places = sqliteTable(
  "places",
  {
    placeId: text("place_id").primaryKey(),
    source: text("source").$type<"google" | "demo">().notNull(),
    lat: real("lat"),
    lng: real("lng"),
    coordsFetchedAt: integer("coords_fetched_at").notNull(),
    /** Son görülmede Google "yakında açılacak" (FUTURE_OPENING) bildirdi. Türetilmiş bayrak. */
    wasFuture: integer("was_future", { mode: "boolean" }).notNull().default(false),
    /** Google "kalıcı olarak kapalı" bildirdi. Türetilmiş bayrak. */
    isClosed: integer("is_closed", { mode: "boolean" }).notNull().default(false),
    firstSeenScanId: integer("first_seen_scan_id"),
    lastSeenScanId: integer("last_seen_scan_id"),
    firstSeenAt: integer("first_seen_at").notNull(),
    /** Önceki karşılaştırılabilir taramada vardı, son taramada bulunamadı (kapandı anlamına GELMEZ). */
    notFoundInScanId: integer("not_found_in_scan_id"),
    /** Snapshot karşılaştırmasıyla "yeni tespit edildi" olarak işaretlendiği an. */
    newDetectedAt: integer("new_detected_at"),
    /** FUTURE_OPENING → OPERATIONAL geçişinin gözlendiği an. */
    openedDetectedAt: integer("opened_detected_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("places_latlng_idx").on(t.lat, t.lng), index("places_source_idx").on(t.source)],
);

/** Tarama karşılaştırması için yalnızca yer kimlikleri ve türetilmiş bir bayrak saklanır (Google içeriği değil). */
export const placeSnapshots = sqliteTable(
  "place_snapshots",
  {
    scanId: integer("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    placeId: text("place_id").notNull(),
    wasFuture: integer("was_future", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.scanId, t.placeId] }),
    index("snapshots_place_idx").on(t.placeId),
  ],
);

export type LeadStatus =
  | "new"
  | "enriched"
  | "queued"
  | "sent"
  | "replied"
  | "not_interested"
  | "customer"
  | "do_not_contact";

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    placeId: text("place_id").references(() => places.placeId, { onDelete: "set null" }),
    source: text("source").$type<"google" | "registry" | "import" | "demo">().notNull(),
    /**
     * KENDİ kaydımız: işletmenin görünen adı. Kullanıcı girer veya (Faz 2) işletmenin kendi web sitesinden okunur.
     * Google'dan gelen ad buraya KOPYALANMAZ.
     */
    displayName: text("display_name"),
    /** Bizim veri setimizden (GeoNames) türetilen yaklaşık ülke/şehir; Google adres verisi değildir. */
    countryCode: text("country_code"),
    city: text("city"),
    /** Bulan aramanın kategori anahtarı (kendi etiketimiz). */
    categoryKey: text("category_key"),
    noveltyScore: integer("novelty_score").notNull().default(0),
    noveltyLabel: text("novelty_label").$type<NoveltyLabel>().notNull().default("low"),
    noveltySignals: text("novelty_signals", { mode: "json" })
      .$type<NoveltySignal[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status").$type<LeadStatus>().notNull().default("new"),
    language: text("language"),
    notes: text("notes"),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("leads_place_uq").on(t.placeId),
    index("leads_novelty_idx").on(t.noveltyScore),
    index("leads_status_idx").on(t.status),
    index("leads_source_idx").on(t.source),
    index("leads_country_city_idx").on(t.countryCode, t.city),
    index("leads_category_idx").on(t.categoryKey),
  ],
);

/* ---------------------------------------------------------------------------
 * Faz 2: e-posta bulma. Bu tablolardaki her şey BİZİM verimizdir: işletmenin kendi web sitesinden okunan
 * e-posta adresleri, sosyal bağlantılar ve doğrulama sonuçları. Google'ın web sitesi adresi (websiteUri)
 * burada SAKLANMAZ; yalnızca taramada bulunan sayfanın adresi (`source_url`) kaynak olarak tutulur.
 * ------------------------------------------------------------------------- */

export type EmailKind = "generic" | "personal" | "consumer";
export type EmailSourceType =
  "mailto" | "jsonld" | "cfemail" | "text" | "obfuscated" | "manual" | "external";
export type VerifyStatus = "verified" | "unverified" | "invalid";
/** SRS 4.5 `email_status`: bir lead'in e-posta durumunun özeti. */
export type EmailStatus =
  "found_verified" | "found_unverified" | "generic" | "not_found" | "invalid";
export type EnrichmentStatus =
  "queued" | "running" | "done" | "no_website" | "needs_google" | "blocked" | "failed";
export type ContactType =
  "instagram" | "facebook" | "linkedin" | "twitter" | "tiktok" | "youtube" | "contact_form";

export const leadEmails = sqliteTable(
  "lead_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** Küçük harf; alan adı ASCII (punycode). */
    email: text("email").notNull(),
    domain: text("domain").notNull(),
    kind: text("kind").$type<EmailKind>().notNull(),
    /** E-postanın bulunduğu sayfa (işletmenin kendi sitesi). Elle eklenenlerde boştur. */
    sourceUrl: text("source_url"),
    sourceType: text("source_type").$type<EmailSourceType>().notNull(),
    /** Adresin alan adı, taranan sitenin alan adıyla aynı mı? Farklıysa (ajans, grup adresi) sıralamada geriye düşer. */
    siteMatch: integer("site_match", { mode: "boolean" }).notNull().default(true),
    verifyStatus: text("verify_status").$type<VerifyStatus>().notNull().default("unverified"),
    /** Doğrulama sonucunun kısa nedeni: ok, syntax, no_mx, null_mx, disposable, consumer_domain, dns_timeout... */
    verifyReason: text("verify_reason"),
    verifiedAt: integer("verified_at"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** Kullanıcı birincil adresi elle seçtiyse otomatik seçim onu değiştirmez. */
    primaryPinned: integer("primary_pinned", { mode: "boolean" }).notNull().default(false),
    foundAt: integer("found_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("lead_emails_lead_email_uq").on(t.leadId, t.email),
    // Bir lead'in en fazla bir birincil adresi olabilir (liste sorguları buna güvenir).
    uniqueIndex("lead_emails_primary_uq")
      .on(t.leadId)
      .where(sql`${t.isPrimary} = 1`),
    index("lead_emails_email_idx").on(t.email),
    index("lead_emails_domain_idx").on(t.domain),
  ],
);

export const leadContacts = sqliteTable(
  "lead_contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    type: text("type").$type<ContactType>().notNull(),
    url: text("url").notNull(),
    foundAt: integer("found_at").notNull(),
  },
  (t) => [uniqueIndex("lead_contacts_uq").on(t.leadId, t.type, t.url)],
);

/** Bir lead için e-posta bulma işleminin durumu (lead başına tek satır). */
export const leadEnrichment = sqliteTable(
  "lead_enrichment",
  {
    leadId: integer("lead_id")
      .primaryKey()
      .references(() => leads.id, { onDelete: "cascade" }),
    status: text("status").$type<EnrichmentStatus>().notNull(),
    emailStatus: text("email_status").$type<EmailStatus>(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: integer("last_attempt_at"),
    /** Yeniden deneme zamanı (yalnızca geçici hatalarda, en çok bir kez; FR-ENR-05). */
    nextRetryAt: integer("next_retry_at"),
    lastError: text("last_error"),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /** Yerel taramada bulunamayınca harici servis (Hunter) kullanıldı mı? */
    externalUsed: integer("external_used", { mode: "boolean" }).notNull().default(false),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("lead_enrichment_status_idx").on(t.status),
    index("lead_enrichment_email_idx").on(t.emailStatus),
  ],
);

export const apiUsage = sqliteTable(
  "api_usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    sku: text("sku").notNull(),
    day: text("day").notNull(),
    calls: integer("calls").notNull().default(0),
    estCostUsd: real("est_cost_usd").notNull().default(0),
  },
  (t) => [
    uniqueIndex("api_usage_uq").on(t.provider, t.sku, t.day),
    index("api_usage_day_idx").on(t.day),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: integer("run_at").notNull(),
    lockedBy: text("locked_by"),
    lockedAt: integer("locked_at"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt, t.priority),
    uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    detail: text("detail", { mode: "json" }).$type<unknown>(),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);
