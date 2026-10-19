CREATE TABLE `lead_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`found_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_contacts_uq` ON `lead_contacts` (`lead_id`,`type`,`url`);--> statement-breakpoint
CREATE TABLE `lead_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`email` text NOT NULL,
	`domain` text NOT NULL,
	`kind` text NOT NULL,
	`source_url` text,
	`source_type` text NOT NULL,
	`site_match` integer DEFAULT true NOT NULL,
	`verify_status` text DEFAULT 'unverified' NOT NULL,
	`verify_reason` text,
	`verified_at` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`primary_pinned` integer DEFAULT false NOT NULL,
	`found_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lead_emails_lead_email_uq` ON `lead_emails` (`lead_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `lead_emails_primary_uq` ON `lead_emails` (`lead_id`) WHERE "lead_emails"."is_primary" = 1;--> statement-breakpoint
CREATE INDEX `lead_emails_email_idx` ON `lead_emails` (`email`);--> statement-breakpoint
CREATE INDEX `lead_emails_domain_idx` ON `lead_emails` (`domain`);--> statement-breakpoint
CREATE TABLE `lead_enrichment` (
	`lead_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`email_status` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`next_retry_at` integer,
	`last_error` text,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`external_used` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lead_enrichment_status_idx` ON `lead_enrichment` (`status`);--> statement-breakpoint
CREATE INDEX `lead_enrichment_email_idx` ON `lead_enrichment` (`email_status`);