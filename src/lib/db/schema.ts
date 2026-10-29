import { sql } from "drizzle-orm";
import {
  check,
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
    /** Faz 3: son giden kampanya iletisinin zamanı (liste sütunu için türetilmiş; asıl kaynak `messages`). */
    lastContactedAt: integer("last_contacted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("leads_place_uq").on(t.placeId),
    index("leads_last_contacted_idx").on(t.lastContactedAt),
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

/* ---------------------------------------------------------------------------
 * Faz 3: şablonlar, kampanya, gönderim geçmişi, suppression ve ülke politikası.
 * Kurallar:
 *  - Gizli bilgi (OAuth token, SMTP parolası) hiçbir tabloda tutulmaz; `mailboxes.credentials_ref` yalnızca
 *    şifreli depodaki kaydın adıdır.
 *  - Google içeriği (işletme adı, açılış tarihi) kalıcı tutulmaz: iletinin gövdesi saklanmaz, konu satırı
 *    Google kaynaklı değişkenler maskelenmiş olarak (`subject_logged`) saklanır.
 *  - Gönderim geçmişi olan lead, kampanya ve şablon silinemez (ON DELETE RESTRICT); kişisel veri silme talebi
 *    satırı silmek yerine adres alanlarını boşaltıp `redacted_at` doldurur.
 *  - Temas sınırları lead'e değil alıcı adresinin özetine (`peer_hash`) ve alan adına bağlıdır; lead silinse veya
 *    yeniden eklense de korunur.
 * ------------------------------------------------------------------------- */

export type PolicyScope = "live" | "demo";
export type PolicyMode = "blocked" | "generic_only" | "allowed";

/**
 * Ülke bazlı gönderim politikası. `live` (gerçek gönderim) ve `demo` kapsamları ayrıdır; hangisinin
 * uygulanacağını kampanyanın posta kutusu belirler, kullanıcı seçmez.
 * `live` satırları kilitlidir (`locked`) ve kilitliyken `blocked` dışına çıkamaz; kilit yalnızca hukuki onaydan
 * sonra yeni bir yazılım sürümüyle açılır. Kilit açık olsa bile `blocked` dışı mod onay kaydı ister.
 */
export const countryPolicies = sqliteTable(
  "country_policies",
  {
    scope: text("scope").$type<PolicyScope>().notNull(),
    countryCode: text("country_code").notNull(),
    mode: text("mode").$type<PolicyMode>().notNull(),
    locked: integer("locked", { mode: "boolean" }).notNull().default(true),
    /** Hukuki değerlendirme belgesinin referansı (gerçek gönderimi açmak için zorunlu). */
    approvalRef: text("approval_ref"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at"),
    note: text("note"),
    /** Satırı oluşturan/güncelleyen yazılım varsayılanlarının sürümü. */
    seedVersion: integer("seed_version").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.countryCode] }),
    check("country_policies_scope_ck", sql`scope IN ('live', 'demo')`),
    check("country_policies_mode_ck", sql`mode IN ('blocked', 'generic_only', 'allowed')`),
    check("country_policies_code_ck", sql`length(country_code) = 2`),
    check("country_policies_lock_ck", sql`scope = 'demo' OR locked = 0 OR mode = 'blocked'`),
    check(
      "country_policies_approval_ck",
      sql`scope = 'demo' OR mode = 'blocked' OR (approval_ref IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
  ],
);

export type MailboxProvider = "gmail" | "smtp" | "demo";
export type MailboxStatus = "not_configured" | "connected" | "error" | "disabled";

/** Gönderen posta kutusu. Gerçek hesaba bağlı alanlar boş olabilir; `demo` hesap gerektirmez ve ağa çıkmaz. */
export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").$type<MailboxProvider>().notNull(),
    label: text("label").notNull(),
    address: text("address"),
    /** Şifreli gizli bilgi deposundaki kaydın adı; token/parola burada TUTULMAZ. */
    credentialsRef: text("credentials_ref"),
    smtpHost: text("smtp_host"),
    smtpPort: integer("smtp_port"),
    smtpSecure: integer("smtp_secure", { mode: "boolean" }),
    status: text("status").$type<MailboxStatus>().notNull().default("not_configured"),
    /** SRS 4.6: başlangıç 20, üst sınır 80. */
    dailyCap: integer("daily_cap").notNull().default(20),
    /** Isınma: haftalık artış (en çok 10). */
    warmupStep: integer("warmup_step").notNull().default(10),
    warmupStartedAt: integer("warmup_started_at"),
    connectedAt: integer("connected_at"),
    /** Gelen kutusu okuma imleci (ör. Gmail historyId). */
    syncCursor: text("sync_cursor"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("mailboxes_address_uq")
      .on(t.provider, t.address)
      .where(sql`${t.address} IS NOT NULL`),
    check("mailboxes_provider_ck", sql`provider IN ('gmail', 'smtp', 'demo')`),
    check(
      "mailboxes_status_ck",
      sql`status IN ('not_configured', 'connected', 'error', 'disabled')`,
    ),
    check("mailboxes_cap_ck", sql`daily_cap BETWEEN 1 AND 80`),
    check("mailboxes_warmup_ck", sql`warmup_step BETWEEN 0 AND 10`),
    check(
      "mailboxes_connected_ck",
      sql`status <> 'connected' OR (address IS NOT NULL AND (provider = 'demo' OR credentials_ref IS NOT NULL))`,
    ),
  ],
);

export type TemplateKind = "initial" | "followup";

/** E-posta şablonu. Zorunlu footer (unvan, adres, çıkış bağlantısı) burada saklanmaz; gönderimde eklenir. */
export const templates = sqliteTable(
  "templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    /** Boş = tüm kategoriler. */
    categoryKey: text("category_key"),
    kind: text("kind").$type<TemplateKind>().notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text").notNull(),
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    /** Her düzenlemede artar; gönderilen ileti hangi sürümle gittiğini saklar. */
    version: integer("version").notNull().default(1),
    /** Kullanılmış şablon silinmez, arşivlenir. */
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("templates_lookup_idx")
      .on(t.language, t.categoryKey, t.kind)
      .where(sql`${t.archivedAt} IS NULL`),
    check("templates_kind_ck", sql`kind IN ('initial', 'followup')`),
  ],
);

export type CampaignStatus =
  "draft" | "ready" | "running" | "paused" | "completed" | "cancelled" | "stopped";

export interface SendWindow {
  /** ISO hafta günleri (1 = Pazartesi). */
  days: number[];
  /** Alıcının yerel saatiyle "HH:MM". */
  start: string;
  end: string;
}

/** Kampanya. Gönderim yalnızca kullanıcı "Başlat" dediğinde (`start_confirmed_at`) başlar (FR-CMP-04). */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    status: text("status").$type<CampaignStatus>().notNull().default("draft"),
    mailboxId: integer("mailbox_id").references(() => mailboxes.id, { onDelete: "restrict" }),
    /** Hedef seçimi: {leadIds} veya {filters}; eklendiği andaki görüntü. */
    selection: text("selection", { mode: "json" }).$type<unknown>().notNull(),
    sendWindow: text("send_window", { mode: "json" }).$type<SendWindow>().notNull(),
    dailyCap: integer("daily_cap").notNull().default(20),
    minGapS: integer("min_gap_s").notNull().default(90),
    maxGapS: integer("max_gap_s").notNull().default(240),
    pauseReason: text("pause_reason"),
    startConfirmedAt: integer("start_confirmed_at"),
    startedAt: integer("started_at"),
    pausedAt: integer("paused_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("campaigns_status_idx").on(t.status),
    check(
      "campaigns_status_ck",
      sql`status IN ('draft', 'ready', 'running', 'paused', 'completed', 'cancelled', 'stopped')`,
    ),
    check("campaigns_cap_ck", sql`daily_cap BETWEEN 1 AND 80`),
    check("campaigns_gap_ck", sql`min_gap_s >= 90 AND max_gap_s >= min_gap_s`),
    check("campaigns_mailbox_ck", sql`status IN ('draft', 'cancelled') OR mailbox_id IS NOT NULL`),
    check(
      "campaigns_start_ck",
      sql`status NOT IN ('running', 'paused', 'completed', 'stopped') OR start_confirmed_at IS NOT NULL`,
    ),
  ],
);

/** Kampanyanın adımları: ilk e-posta + en çok 2 takip (SRS 5.6.1), dil başına bir şablon. */
export const campaignSteps = sqliteTable(
  "campaign_steps",
  {
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    language: text("language").notNull(),
    templateId: integer("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "restrict" }),
    delayDays: integer("delay_days").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.campaignId, t.stepIndex, t.language] }),
    check("campaign_steps_index_ck", sql`step_index BETWEEN 0 AND 2`),
    check("campaign_steps_delay_ck", sql`step_index = 0 OR delay_days >= 5`),
  ],
);

export type CampaignLeadStatus =
  | "pending"
  | "excluded"
  | "scheduled"
  | "in_flight"
  | "waiting_next"
  | "completed"
  | "replied"
  | "bounced"
  | "unsubscribed"
  | "removed"
  | "cancelled"
  | "failed";

/** Bir lead'in bir kampanyadaki iletişim dizisi (lead başına tek satır). Gönderim kuyruğu `next_send_at`'tir. */
export const campaignLeads = sqliteTable(
  "campaign_leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "restrict" }),
    emailId: integer("email_id").references(() => leadEmails.id, { onDelete: "set null" }),
    /** Eklendiği andaki alıcı (küçük harf, punycode). Silme talebinde boşaltılır. */
    recipientEmail: text("recipient_email"),
    recipientHash: text("recipient_hash"),
    recipientDomain: text("recipient_domain"),
    countryCode: text("country_code"),
    language: text("language"),
    status: text("status").$type<CampaignLeadStatus>().notNull().default("pending"),
    /** Uygunluk kontrolünün hariç tutma gerekçeleri (FR-CMP-02). */
    exclusionReasons: text("exclusion_reasons", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    nextStep: integer("next_step").notNull().default(0),
    nextSendAt: integer("next_send_at"),
    lastSentAt: integer("last_sent_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    redactedAt: integer("redacted_at"),
    addedAt: integer("added_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("campaign_leads_uq").on(t.campaignId, t.leadId),
    index("campaign_leads_queue_idx").on(t.status, t.nextSendAt),
    index("campaign_leads_hash_idx").on(t.recipientHash),
    index("campaign_leads_domain_idx").on(t.recipientDomain),
    index("campaign_leads_lead_idx").on(t.leadId),
    check(
      "campaign_leads_status_ck",
      sql`status IN ('pending', 'excluded', 'scheduled', 'in_flight', 'waiting_next', 'completed', 'replied', 'bounced', 'unsubscribed', 'removed', 'cancelled', 'failed')`,
    ),
    check("campaign_leads_step_ck", sql`next_step BETWEEN 0 AND 3`),
    check(
      "campaign_leads_recipient_ck",
      sql`recipient_email IS NOT NULL OR redacted_at IS NOT NULL OR status IN ('pending', 'excluded')`,
    ),
  ],
);

export type MessageDirection = "out" | "in";
export type MessagePurpose = "campaign" | "test" | "inbound";
/**
 * Giden ileti durumları:
 *  - `queued`  : henüz sağlayıcıya verilmedi.
 *  - `sending` : sağlayıcı çağrısından HEMEN ÖNCE yazılır.
 *  - `sent`    : sağlayıcı kabul etti.
 *  - `failed`  : sağlayıcıya KESİNLİKLE ulaşmadı (ör. bağlantı kurulamadı, yerel doğrulama hatası); güvenle
 *                yeniden denenebilir.
 *  - `unknown` : sonuç belirsiz (çökme, zaman aşımı); OTOMATİK YENİDEN GÖNDERİLMEZ, kullanıcı/uzlaştırma karar verir.
 */
export type OutboundStatus = "queued" | "sending" | "sent" | "failed" | "unknown";
export type InboundStatus = "received" | "matched" | "unmatched" | "ignored";
export type DeliveryStatus = "bounced_soft" | "bounced_hard";
export type MessageClassification =
  "reply" | "bounce" | "auto_reply" | "unsubscribe" | "negative" | "other";

/** Gönderim geçmişi (giden ve gelen). İleti gövdesi saklanmaz; yalnızca özeti (`body_sha256`). */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    direction: text("direction").$type<MessageDirection>().notNull(),
    purpose: text("purpose").$type<MessagePurpose>().notNull(),
    campaignId: integer("campaign_id").references(() => campaigns.id, { onDelete: "restrict" }),
    campaignLeadId: integer("campaign_lead_id").references(() => campaignLeads.id, {
      onDelete: "restrict",
    }),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "restrict" }),
    mailboxId: integer("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "restrict" }),
    templateId: integer("template_id").references(() => templates.id, { onDelete: "restrict" }),
    templateVersion: integer("template_version"),
    stepIndex: integer("step_index"),
    /** Giden kampanya iletisi için "cl:{campaign_lead_id}:s:{step}". */
    idempotencyKey: text("idempotency_key"),
    /** RFC 5322 Message-ID; sağlayıcı çağrısından ÖNCE üretilip yazılır. */
    rfcMessageId: text("rfc_message_id"),
    providerMessageId: text("provider_message_id"),
    threadId: text("thread_id"),
    inReplyTo: text("in_reply_to"),
    references: text("references", { mode: "json" }).$type<string[]>(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    /** Karşı tarafın (giden: alıcı, gelen: gönderen) adres özeti ve alan adı; temas sınırları bunlarla hesaplanır. */
    peerHash: text("peer_hash").notNull(),
    peerDomain: text("peer_domain").notNull(),
    /** Gönderimin UTC günü "YYYY-MM-DD" (alan adı başına günde bir ileti kuralı). */
    sendDay: text("send_day"),
    /** Konu satırı; Google kaynaklı değişkenler maskelenmiş. */
    subjectLogged: text("subject_logged"),
    bodySha256: text("body_sha256"),
    status: text("status").$type<OutboundStatus | InboundStatus>().notNull(),
    deliveryStatus: text("delivery_status").$type<DeliveryStatus>(),
    classification: text("classification").$type<MessageClassification>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
    receivedAt: integer("received_at"),
    redactedAt: integer("redacted_at"),
  },
  (t) => [
    // Aynı adım iki kez gönderilemez. Yalnızca sağlayıcıya kesinlikle ulaşmamış (`failed`) deneme yeniden açılabilir;
    // `unknown` anahtarı tutmaya devam eder.
    uniqueIndex("messages_idempotency_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL AND ${t.status} <> 'failed'`),
    uniqueIndex("messages_rfc_uq")
      .on(t.rfcMessageId, t.direction)
      .where(sql`${t.rfcMessageId} IS NOT NULL`),
    // SRS 5.6.1: aynı alan adına günde en fazla bir kampanya iletisi. Bounce `status`'u değiştirmez, gün dolu kalır.
    uniqueIndex("messages_domain_day_uq")
      .on(t.peerDomain, t.sendDay)
      .where(
        sql`${t.direction} = 'out' AND ${t.purpose} = 'campaign' AND ${t.status} IN ('sending', 'sent', 'unknown')`,
      ),
    index("messages_peer_hash_idx").on(t.peerHash, t.sentAt),
    index("messages_peer_domain_idx").on(t.peerDomain, t.sentAt),
    index("messages_campaign_idx").on(t.campaignId, t.status),
    index("messages_lead_idx").on(t.leadId),
    index("messages_thread_idx").on(t.threadId),
    index("messages_in_reply_to_idx").on(t.inReplyTo),
    check("messages_direction_ck", sql`direction IN ('out', 'in')`),
    check("messages_purpose_ck", sql`purpose IN ('campaign', 'test', 'inbound')`),
    check(
      "messages_status_ck",
      sql`(direction = 'out' AND status IN ('queued', 'sending', 'sent', 'failed', 'unknown')) OR (direction = 'in' AND status IN ('received', 'matched', 'unmatched', 'ignored'))`,
    ),
    check(
      "messages_delivery_ck",
      sql`delivery_status IS NULL OR (direction = 'out' AND delivery_status IN ('bounced_soft', 'bounced_hard'))`,
    ),
    check(
      "messages_classification_ck",
      sql`classification IS NULL OR classification IN ('reply', 'bounce', 'auto_reply', 'unsubscribe', 'negative', 'other')`,
    ),
    check(
      "messages_campaign_ck",
      sql`direction <> 'out' OR purpose <> 'campaign' OR (campaign_id IS NOT NULL AND campaign_lead_id IS NOT NULL AND send_day IS NOT NULL AND idempotency_key IS NOT NULL)`,
    ),
    check(
      "messages_recipient_ck",
      sql`direction <> 'out' OR to_address IS NOT NULL OR redacted_at IS NOT NULL`,
    ),
  ],
);

export type SuppressionScope = "email" | "domain";
export type SuppressionReason =
  "unsubscribe" | "bounce_hard" | "complaint" | "manual" | "negative_reply" | "erasure";
export type SuppressionSource = "manual" | "csv" | "link" | "inbox" | "bounce" | "system";

/**
 * Gönderim engelleri. Açık metin e-posta adresi TUTULMAZ: eşleştirme özetle (`email_hash`), gösterim maskeli
 * adresle yapılır. Kayıt silinmez; geçerli kaldırma talebinde `lifted_at` doldurulur.
 */
export const suppressions = sqliteTable(
  "suppressions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").$type<SuppressionScope>().notNull(),
    emailHash: text("email_hash"),
    /** Özet yöntemi (ör. "sha256-v1"); normalleştirme değişirse eski kayıtlar ayırt edilir. */
    hashAlg: text("hash_alg"),
    emailMasked: text("email_masked"),
    domain: text("domain").notNull(),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    source: text("source").$type<SuppressionSource>().notNull(),
    messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
    note: text("note"),
    addedAt: integer("added_at").notNull(),
    liftedAt: integer("lifted_at"),
    liftedReason: text("lifted_reason"),
  },
  (t) => [
    uniqueIndex("suppressions_email_uq")
      .on(t.emailHash)
      .where(sql`${t.scope} = 'email' AND ${t.liftedAt} IS NULL`),
    uniqueIndex("suppressions_domain_uq")
      .on(t.domain)
      .where(sql`${t.scope} = 'domain' AND ${t.liftedAt} IS NULL`),
    index("suppressions_domain_idx").on(t.domain),
    check("suppressions_scope_ck", sql`scope IN ('email', 'domain')`),
    check(
      "suppressions_reason_ck",
      sql`reason IN ('unsubscribe', 'bounce_hard', 'complaint', 'manual', 'negative_reply', 'erasure')`,
    ),
    check(
      "suppressions_source_ck",
      sql`source IN ('manual', 'csv', 'link', 'inbox', 'bounce', 'system')`,
    ),
    check(
      "suppressions_key_ck",
      sql`scope = 'domain' OR (email_hash IS NOT NULL AND hash_alg IS NOT NULL)`,
    ),
    check("suppressions_lift_ck", sql`lifted_at IS NULL OR lifted_reason IS NOT NULL`),
  ],
);
