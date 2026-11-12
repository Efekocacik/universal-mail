-- Faz 4 (P0 temel): TEK, ELLE düzenlenmiş, YALNIZCA EKLEYEN migrasyon. `drizzle-kit generate`in ürettiği
-- `__new_scans` / `__new_templates` / `__new_lead_enrichment` yeniden oluşturmaları KULLANILMAZ (0003 emsali): mevcut
-- tablolar yalnızca `ALTER TABLE … ADD` ile sütun alır (CHECK sütun tanımında, satır içi), yeni tablo ve indeksler
-- `IF NOT EXISTS` ile kurulur. Hiçbir satır yeniden yazılmaz, silinmez veya taşınmaz; eski sürüm yeni sütunları okumaz.
-- Geri alma: scripts/rollback-0004.ts (src/lib/db/rollback-0004.ts). Şema sözleşmesi: src/lib/db/schema.ts.
-- Kısıt notları (ayrıntı schema.ts'te): `notifications.kind` yalnızca BİÇİM denetler (küçük harf `alan.olay`); izinli
-- türlerin listesi kodda (NOTIFICATION_KINDS + zod), çünkü SQLite CHECK'i değiştirmek tablo yeniden kurmayı gerektirir.
-- `scans_schedule_slot_ck`: manual ⇔ zamanlama alanları boş; schedule ⇒ schedule_slot dolu. Zamanlama silinince
-- (ON DELETE SET NULL) `origin='schedule', schedule_id=NULL, schedule_slot=dolu` kalır: BİLİNÇLİ geçmiş durumu; satır
-- kısmi tekil indeksin dışına çıkar (yeniden çalıştırılacak zamanlama yoktur). `leads.archived_at` geri alınabilir
-- arşivdir (kampanya/ileti RESTRICT FK'leri korunur); indeks kısmidir çünkü satırların neredeyse hepsi NULL'dır.
CREATE TABLE IF NOT EXISTS `scan_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_id` integer NOT NULL,
	`scan_key` text NOT NULL,
	`category_set_ids` text NOT NULL,
	`custom_keywords` text DEFAULT '[]' NOT NULL,
	`strategy` text NOT NULL,
	`field_profile` text NOT NULL,
	`interval_days` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`max_cost_usd` real,
	`ack_max_usd` real,
	`ack_at` integer,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_scan_id` integer,
	`last_outcome` text,
	`last_skip_code` text,
	`missed_runs` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "scan_schedules_interval_ck" CHECK(interval_days IN (7, 14, 30)),
	CONSTRAINT "scan_schedules_enabled_ck" CHECK(enabled IN (0, 1)),
	CONSTRAINT "scan_schedules_strategy_ck" CHECK(strategy IN ('text', 'nearby')),
	CONSTRAINT "scan_schedules_profile_ck" CHECK(field_profile IN ('discovery', 'enrich')),
	CONSTRAINT "scan_schedules_json_ck" CHECK(json_valid(category_set_ids) AND json_type(category_set_ids) = 'array' AND json_valid(custom_keywords) AND json_type(custom_keywords) = 'array'),
	CONSTRAINT "scan_schedules_cost_ck" CHECK(max_cost_usd IS NULL OR max_cost_usd >= 0),
	CONSTRAINT "scan_schedules_ack_ck" CHECK((ack_max_usd IS NULL AND ack_at IS NULL) OR (ack_max_usd >= 0 AND ack_at IS NOT NULL)),
	CONSTRAINT "scan_schedules_outcome_ck" CHECK(last_outcome IS NULL OR last_outcome IN ('started', 'skipped', 'completed', 'failed')),
	CONSTRAINT "scan_schedules_skip_code_ck" CHECK(last_skip_code IS NULL OR (length(last_skip_code) BETWEEN 1 AND 40 AND last_skip_code NOT GLOB '*[^A-Z0-9_]*')),
	CONSTRAINT "scan_schedules_missed_ck" CHECK(missed_runs >= 0)
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `scan_schedules_key_uq` ON `scan_schedules` (`scan_key`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scan_schedules_due_idx` ON `scan_schedules` (`enabled`,`next_run_at`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scan_schedules_region_idx` ON `scan_schedules` (`region_id`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `scan_schedules_last_scan_idx` ON `scan_schedules` (`last_scan_id`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`url` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`os_claimed_at` integer,
	CONSTRAINT "notifications_kind_ck" CHECK(length(kind) BETWEEN 3 AND 40 AND kind GLOB '[a-z]*.[a-z]*' AND kind NOT GLOB '*[^a-z._]*'),
	CONSTRAINT "notifications_dedupe_ck" CHECK(length(dedupe_key) BETWEEN 1 AND 200),
	CONSTRAINT "notifications_params_ck" CHECK(json_valid(params) AND json_type(params) = 'object' AND length(params) <= 2000),
	CONSTRAINT "notifications_url_ck" CHECK(length(url) BETWEEN 1 AND 500 AND substr(url, 1, 1) = '/' AND substr(url, 1, 2) <> '//')
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `notifications_dedupe_uq` ON `notifications` (`dedupe_key`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notifications_read_idx` ON `notifications` (`read_at`,`created_at`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notifications_os_pending_idx` ON `notifications` (`id`) WHERE "notifications"."os_claimed_at" IS NULL
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `domain_registrations` (
	`domain` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`registered_at` integer,
	`rdap_host` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`checked_at` integer,
	`next_check_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "domain_registrations_status_ck" CHECK(status IN ('pending', 'ok', 'no_date', 'not_found', 'unsupported_tld', 'rate_limited', 'error')),
	CONSTRAINT "domain_registrations_domain_ck" CHECK(length(domain) BETWEEN 3 AND 253 AND domain = lower(domain)),
	CONSTRAINT "domain_registrations_ok_ck" CHECK(status <> 'ok' OR registered_at IS NOT NULL),
	CONSTRAINT "domain_registrations_attempts_ck" CHECK(attempts >= 0),
	CONSTRAINT "domain_registrations_error_ck" CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 64)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `domain_registrations_due_idx` ON `domain_registrations` (`status`,`next_check_at`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `saved_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`payload` text NOT NULL,
	`sort` text DEFAULT 'novelty' NOT NULL,
	`include_area` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT "saved_filters_name_ck" CHECK(length(trim(name)) BETWEEN 1 AND 60),
	CONSTRAINT "saved_filters_name_key_ck" CHECK(length(name_key) BETWEEN 1 AND 120),
	CONSTRAINT "saved_filters_payload_ck" CHECK(json_valid(payload) AND json_type(payload) = 'object' AND length(payload) <= 16000),
	CONSTRAINT "saved_filters_sort_ck" CHECK(sort IN ('novelty', 'name', 'recent')),
	CONSTRAINT "saved_filters_area_ck" CHECK(include_area IN (0, 1))
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `saved_filters_name_uq` ON `saved_filters` (`name_key`)
--> statement-breakpoint
ALTER TABLE `scans` ADD `origin` text DEFAULT 'manual' NOT NULL CONSTRAINT "scans_origin_ck" CHECK(origin IN ('manual', 'schedule'))
--> statement-breakpoint
ALTER TABLE `scans` ADD `schedule_id` integer REFERENCES `scan_schedules`(`id`) ON UPDATE no action ON DELETE set null
--> statement-breakpoint
ALTER TABLE `scans` ADD `schedule_slot` integer CONSTRAINT "scans_schedule_slot_ck" CHECK((origin = 'manual' AND schedule_id IS NULL AND schedule_slot IS NULL) OR (origin = 'schedule' AND schedule_slot IS NOT NULL))
--> statement-breakpoint
ALTER TABLE `scans` ADD `pause_code` text CONSTRAINT "scans_pause_code_ck" CHECK(pause_code IS NULL OR (length(pause_code) BETWEEN 1 AND 40 AND pause_code NOT GLOB '*[^A-Z0-9_]*'))
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `scans_schedule_slot_uq` ON `scans` (`schedule_id`,`schedule_slot`) WHERE "scans"."schedule_id" IS NOT NULL
--> statement-breakpoint
ALTER TABLE `places` ADD `place_id_checked_at` integer
--> statement-breakpoint
ALTER TABLE `places` ADD `gone_at` integer
--> statement-breakpoint
ALTER TABLE `places` ADD `status_checked_at` integer
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `places_opened_detected_idx` ON `places` (`opened_detected_at`) WHERE "places"."opened_detected_at" IS NOT NULL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `places_new_detected_idx` ON `places` (`new_detected_at`) WHERE "places"."new_detected_at" IS NOT NULL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `places_first_seen_idx` ON `places` (`first_seen_at`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `places_future_watch_idx` ON `places` (`status_checked_at`) WHERE "places"."was_future" = 1
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `places_id_checked_idx` ON `places` (`place_id_checked_at`)
--> statement-breakpoint
ALTER TABLE `leads` ADD `archived_at` integer
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `leads_archived_idx` ON `leads` (`archived_at`) WHERE "leads"."archived_at" IS NOT NULL
--> statement-breakpoint
ALTER TABLE `lead_enrichment` ADD `site_domain` text CONSTRAINT "lead_enrichment_site_domain_ck" CHECK(site_domain IS NULL OR (length(site_domain) BETWEEN 3 AND 253 AND site_domain = lower(site_domain)))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `lead_enrichment_site_domain_idx` ON `lead_enrichment` (`site_domain`)
--> statement-breakpoint
ALTER TABLE `templates` ADD `followup_reuse_subject` integer DEFAULT true NOT NULL CONSTRAINT "templates_followup_reuse_subject_ck" CHECK(followup_reuse_subject IN (0, 1))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_out_day_idx` ON `messages` (`send_day`,`mailbox_id`) WHERE "messages"."direction" = 'out' AND "messages"."purpose" = 'campaign'
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_in_received_idx` ON `messages` (`received_at`) WHERE "messages"."direction" = 'in'
