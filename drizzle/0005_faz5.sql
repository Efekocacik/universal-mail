-- Faz 5 (P0 temel): TEK, ELLE düzenlenmiş, YALNIZCA EKLEYEN migrasyon (0003/0004 emsali). `drizzle-kit generate`in ürettiği
-- `__new_leads` / `__new_templates` / `__new_messages` yeniden oluşturmaları KULLANILMAZ: mevcut tablolar yalnızca
-- `ALTER TABLE … ADD` ile sütun alır (CHECK sütun tanımında, satır içi), yeni tablo ve indeksler `IF NOT EXISTS` ile
-- kurulur. Hiçbir satır yeniden yazılmaz, silinmez veya taşınmaz; eski sürüm yeni sütunları okumaz.
-- Geri alma: scripts/rollback-0005.ts (src/lib/db/rollback-0005.ts). Şema sözleşmesi: src/lib/db/schema.ts.
-- Kısıt notları: kaynak başına tek etkin sicil çalışması (`registry_runs_active_uq`, kısmi tekil); lead ve dil başına
-- tek onaylı giriş (`lead_intros_approved_uq`); kategori şablonu adımıyla birlikte silinir (bileşik FK, CASCADE).
-- `registry_companies_place_ck` TEK YÖNLÜDÜR: yer silinince (ON DELETE SET NULL) CHECK bozulmaz, uygulama yeniden eşleştirir.
-- İçe aktarılan lead'ler ayrı bağlantı tablosuyla (`import_batch_leads`) izlenir: geri alma `leads`'i yeniden kurmaz.
-- Google içeriği (ad, adres, site, telefon) bu tablolara YAZILMAZ; sicil eşleşmesi yalnızca `place_id` saklar.
CREATE TABLE IF NOT EXISTS `registry_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`activity_scheme` text NOT NULL,
	`activity_codes` text NOT NULL,
	`window_from` text NOT NULL,
	`window_to` text NOT NULL,
	`locality` text,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`matched_count` integer DEFAULT 0 NOT NULL,
	`unmatched_count` integer DEFAULT 0 NOT NULL,
	`pending_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "registry_runs_source_ck" CHECK(source IN ('companies_house', 'insee')),
	CONSTRAINT "registry_runs_demo_ck" CHECK(is_demo IN (0, 1)),
	CONSTRAINT "registry_runs_status_ck" CHECK(status IN ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "registry_runs_scheme_ck" CHECK(activity_scheme IN ('SIC2007', 'NAFRev2', 'NAF2025')),
	CONSTRAINT "registry_runs_codes_ck" CHECK(json_valid(activity_codes) AND json_type(activity_codes) = 'array' AND json_array_length(activity_codes) BETWEEN 1 AND 20),
	CONSTRAINT "registry_runs_window_ck" CHECK(date(window_from) IS window_from AND date(window_to) IS window_to AND window_from <= window_to),
	CONSTRAINT "registry_runs_locality_ck" CHECK(locality IS NULL OR length(locality) BETWEEN 1 AND 80),
	CONSTRAINT "registry_runs_counts_ck" CHECK(fetched_count >= 0 AND new_count >= 0 AND matched_count >= 0 AND unmatched_count >= 0 AND pending_count >= 0),
	CONSTRAINT "registry_runs_error_ck" CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
	CONSTRAINT "registry_runs_failed_ck" CHECK(status <> 'failed' OR error_code IS NOT NULL),
	CONSTRAINT "registry_runs_finished_ck" CHECK((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `registry_runs_active_uq` ON `registry_runs` (`source`) WHERE "registry_runs"."status" IN ('queued', 'running')
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_runs_created_idx` ON `registry_runs` (`created_at`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `registry_companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`trading_name` text,
	`name_norm` text NOT NULL,
	`country_code` text NOT NULL,
	`activity_scheme` text NOT NULL,
	`activity_codes` text NOT NULL,
	`category_key` text,
	`incorporated_on` text NOT NULL,
	`postcode` text,
	`locality` text,
	`locality_norm` text,
	`address_line` text,
	`registry_status` text,
	`last_run_id` integer,
	`match_status` text DEFAULT 'pending' NOT NULL,
	`match_reason` text,
	`match_score` real,
	`matched_place_id` text,
	`matched_at` integer,
	`lead_id` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`last_run_id`) REFERENCES `registry_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`matched_place_id`) REFERENCES `places`(`place_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "registry_companies_source_ck" CHECK(source IN ('companies_house', 'insee')),
	CONSTRAINT "registry_companies_demo_ck" CHECK(is_demo IN (0, 1)),
	CONSTRAINT "registry_companies_country_ck" CHECK(country_code IN ('GB', 'FR')),
	CONSTRAINT "registry_companies_scheme_ck" CHECK(activity_scheme IN ('SIC2007', 'NAFRev2', 'NAF2025')),
	CONSTRAINT "registry_companies_codes_ck" CHECK(json_valid(activity_codes) AND json_type(activity_codes) = 'array'),
	CONSTRAINT "registry_companies_name_ck" CHECK(length(name) BETWEEN 1 AND 300 AND length(name_norm) BETWEEN 1 AND 300 AND (trading_name IS NULL OR length(trading_name) BETWEEN 1 AND 300)),
	CONSTRAINT "registry_companies_text_ck" CHECK((postcode IS NULL OR length(postcode) <= 16) AND (locality IS NULL OR length(locality) <= 120) AND (locality_norm IS NULL OR length(locality_norm) <= 120) AND (address_line IS NULL OR length(address_line) <= 200) AND (registry_status IS NULL OR length(registry_status) <= 40) AND (category_key IS NULL OR length(category_key) BETWEEN 1 AND 64)),
	CONSTRAINT "registry_companies_date_ck" CHECK(date(incorporated_on) IS incorporated_on),
	CONSTRAINT "registry_companies_match_ck" CHECK(match_status IN ('pending', 'matched', 'unmatched', 'manual', 'rejected')),
	CONSTRAINT "registry_companies_score_ck" CHECK(match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
	CONSTRAINT "registry_companies_place_ck" CHECK(matched_place_id IS NULL OR match_status IN ('matched', 'manual')),
	CONSTRAINT "registry_companies_reason_ck" CHECK(match_reason IS NULL OR (length(match_reason) BETWEEN 1 AND 40 AND match_reason NOT GLOB '*[^a-z_]*'))
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `registry_companies_ext_uq` ON `registry_companies` (`source`,`external_id`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_companies_country_inc_idx` ON `registry_companies` (`country_code`,`incorporated_on`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_companies_match_idx` ON `registry_companies` (`match_status`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_companies_place_idx` ON `registry_companies` (`matched_place_id`) WHERE "registry_companies"."matched_place_id" IS NOT NULL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_companies_lead_idx` ON `registry_companies` (`lead_id`) WHERE "registry_companies"."lead_id" IS NOT NULL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `registry_companies_run_idx` ON `registry_companies` (`last_run_id`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`format` text NOT NULL,
	`source_note` text NOT NULL,
	`usage_ack_at` integer NOT NULL,
	`mapping` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_count` integer NOT NULL,
	`duplicate_count` integer NOT NULL,
	`invalid_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "import_batches_format_ck" CHECK(format IN ('csv', 'xlsx')),
	CONSTRAINT "import_batches_name_ck" CHECK(length(filename) BETWEEN 1 AND 200 AND length(source_note) BETWEEN 3 AND 200),
	CONSTRAINT "import_batches_mapping_ck" CHECK(json_valid(mapping) AND json_type(mapping) = 'object'),
	CONSTRAINT "import_batches_counts_ck" CHECK(row_count >= 0 AND created_count >= 0 AND duplicate_count >= 0 AND invalid_count >= 0 AND created_count + duplicate_count + invalid_count <= row_count)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_batches_created_idx` ON `import_batches` (`created_at`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `import_batch_leads` (
	`batch_id` integer NOT NULL,
	`lead_id` integer NOT NULL,
	`row_number` integer NOT NULL,
	PRIMARY KEY(`batch_id`, `lead_id`),
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "import_batch_leads_row_ck" CHECK(row_number >= 1)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_batch_leads_lead_idx` ON `import_batch_leads` (`lead_id`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `lead_intros` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`language` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`model` text NOT NULL,
	`source_domain` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lead_intros_lang_ck" CHECK(language IN ('tr', 'en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl')),
	CONSTRAINT "lead_intros_text_ck" CHECK(length(text) BETWEEN 1 AND 400),
	CONSTRAINT "lead_intros_status_ck" CHECK(status IN ('draft', 'approved', 'rejected')),
	CONSTRAINT "lead_intros_approved_ck" CHECK((status = 'approved') = (approved_at IS NOT NULL)),
	CONSTRAINT "lead_intros_model_ck" CHECK(length(model) BETWEEN 1 AND 64 AND model NOT GLOB '*[^a-z0-9.-]*'),
	CONSTRAINT "lead_intros_domain_ck" CHECK(source_domain IS NULL OR (length(source_domain) BETWEEN 3 AND 253 AND source_domain = lower(source_domain))),
	CONSTRAINT "lead_intros_usage_ck" CHECK(input_tokens >= 0 AND output_tokens >= 0 AND est_cost_usd >= 0)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `lead_intros_lead_idx` ON `lead_intros` (`lead_id`,`language`)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `lead_intros_approved_uq` ON `lead_intros` (`lead_id`,`language`) WHERE "lead_intros"."status" = 'approved'
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `lead_intros_created_idx` ON `lead_intros` (`created_at`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `campaign_step_templates` (
	`campaign_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`language` text NOT NULL,
	`category_key` text NOT NULL,
	`template_id` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `step_index`, `language`, `category_key`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`campaign_id`,`step_index`,`language`) REFERENCES `campaign_steps`(`campaign_id`,`step_index`,`language`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "campaign_step_templates_cat_ck" CHECK(length(category_key) BETWEEN 1 AND 64)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `campaign_step_templates_tpl_idx` ON `campaign_step_templates` (`template_id`)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_opens` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`campaign_id` integer NOT NULL,
	`first_opened_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`open_count` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_opens_source_ck" CHECK(source IN ('pixel', 'relay', 'demo_simulated')),
	CONSTRAINT "message_opens_count_ck" CHECK(open_count >= 1 AND last_opened_at >= first_opened_at)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `message_opens_campaign_idx` ON `message_opens` (`campaign_id`)
--> statement-breakpoint
ALTER TABLE `leads` ADD `website` text CONSTRAINT "leads_website_ck" CHECK(website IS NULL OR length(website) BETWEEN 4 AND 300)
--> statement-breakpoint
ALTER TABLE `templates` ADD `subject_b` text CONSTRAINT "templates_subject_b_ck" CHECK(subject_b IS NULL OR length(subject_b) BETWEEN 1 AND 500)
--> statement-breakpoint
ALTER TABLE `templates` ADD `info_only` integer DEFAULT false NOT NULL CONSTRAINT "templates_info_only_ck" CHECK(info_only IN (0, 1))
--> statement-breakpoint
ALTER TABLE `messages` ADD `subject_variant` text CONSTRAINT "messages_subject_variant_ck" CHECK(subject_variant IS NULL OR subject_variant IN ('a', 'b'))
