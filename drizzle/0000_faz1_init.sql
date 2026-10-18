CREATE TABLE `api_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`sku` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`est_cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_usage_uq` ON `api_usage` (`provider`,`sku`,`day`);--> statement-breakpoint
CREATE INDEX `api_usage_day_idx` ON `api_usage` (`day`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `category_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`place_types` text NOT NULL,
	`keywords` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_sets_key_uq` ON `category_sets` (`key`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_by` text,
	`locked_at` integer,
	`last_error` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`run_at`,`priority`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_uq` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`place_id` text,
	`source` text NOT NULL,
	`display_name` text,
	`country_code` text,
	`city` text,
	`category_key` text,
	`novelty_score` integer DEFAULT 0 NOT NULL,
	`novelty_label` text DEFAULT 'low' NOT NULL,
	`novelty_signals` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`language` text,
	`notes` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`place_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leads_place_uq` ON `leads` (`place_id`);--> statement-breakpoint
CREATE INDEX `leads_novelty_idx` ON `leads` (`novelty_score`);--> statement-breakpoint
CREATE INDEX `leads_status_idx` ON `leads` (`status`);--> statement-breakpoint
CREATE INDEX `leads_source_idx` ON `leads` (`source`);--> statement-breakpoint
CREATE INDEX `leads_country_city_idx` ON `leads` (`country_code`,`city`);--> statement-breakpoint
CREATE INDEX `leads_category_idx` ON `leads` (`category_key`);--> statement-breakpoint
CREATE TABLE `place_snapshots` (
	`scan_id` integer NOT NULL,
	`place_id` text NOT NULL,
	`was_future` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`scan_id`, `place_id`),
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_place_idx` ON `place_snapshots` (`place_id`);--> statement-breakpoint
CREATE TABLE `places` (
	`place_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`lat` real,
	`lng` real,
	`coords_fetched_at` integer NOT NULL,
	`was_future` integer DEFAULT false NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`first_seen_scan_id` integer,
	`last_seen_scan_id` integer,
	`first_seen_at` integer NOT NULL,
	`not_found_in_scan_id` integer,
	`new_detected_at` integer,
	`opened_detected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `places_latlng_idx` ON `places` (`lat`,`lng`);--> statement-breakpoint
CREATE INDEX `places_source_idx` ON `places` (`source`);--> statement-breakpoint
CREATE TABLE `regions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`country_code` text,
	`geometry` text NOT NULL,
	`grid_size_m` integer,
	`schedule_days` integer,
	`last_scan_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scan_units` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` integer NOT NULL,
	`parent_id` integer,
	`depth` integer DEFAULT 0 NOT NULL,
	`south` real NOT NULL,
	`west` real NOT NULL,
	`north` real NOT NULL,
	`east` real NOT NULL,
	`kind` text NOT NULL,
	`term_kind` text NOT NULL,
	`term` text NOT NULL,
	`status` text NOT NULL,
	`calls_made` integer DEFAULT 0 NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`saturated` integer DEFAULT false NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_units_scan_status_idx` ON `scan_units` (`scan_id`,`status`,`depth`,`id`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`region_id` integer NOT NULL,
	`scan_key` text NOT NULL,
	`category_set_ids` text NOT NULL,
	`queries` text NOT NULL,
	`strategy` text NOT NULL,
	`field_profile` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`pause_reason` text,
	`error` text,
	`estimate` text,
	`calls_by_sku` text DEFAULT '{}' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`progress` text DEFAULT '{}' NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`compared_to_scan_id` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`region_id`) REFERENCES `regions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scans_key_idx` ON `scans` (`scan_key`,`status`);--> statement-breakpoint
CREATE INDEX `scans_status_idx` ON `scans` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
