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

export const places = sqliteTable(
  "places",
  {
    placeId: text("place_id").primaryKey(),
    source: text("source").$type<"google" | "demo">().notNull(),
    name: text("name").notNull(),
    formattedAddress: text("formatted_address"),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    countryCode: text("country_code"),
    city: text("city"),
    primaryType: text("primary_type"),
    types: text("types", { mode: "json" }).$type<string[]>().notNull(),
    businessStatus: text("business_status"),
    openingDate: text("opening_date"),
    website: text("website"),
    phone: text("phone"),
    intlPhone: text("intl_phone"),
    userRatingCount: integer("user_rating_count"),
    googleMapsUri: text("google_maps_uri"),
    googleFetchedAt: integer("google_fetched_at").notNull(),
    enrichedAt: integer("enriched_at"),
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
  (t) => [
    index("places_latlng_idx").on(t.lat, t.lng),
    index("places_country_idx").on(t.countryCode, t.city),
    index("places_status_idx").on(t.businessStatus),
    index("places_source_idx").on(t.source),
  ],
);

export const placeSnapshots = sqliteTable(
  "place_snapshots",
  {
    scanId: integer("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    placeId: text("place_id").notNull(),
    businessStatus: text("business_status"),
    userRatingCount: integer("user_rating_count"),
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
