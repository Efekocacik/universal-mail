CREATE TABLE `campaign_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`lead_id` integer NOT NULL,
	`email_id` integer,
	`recipient_email` text,
	`recipient_hash` text,
	`recipient_domain` text,
	`country_code` text,
	`language` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`exclusion_reasons` text DEFAULT '[]' NOT NULL,
	`next_step` integer DEFAULT 0 NOT NULL,
	`next_send_at` integer,
	`last_sent_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`redacted_at` integer,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`email_id`) REFERENCES `lead_emails`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "campaign_leads_status_ck" CHECK(status IN ('pending', 'excluded', 'scheduled', 'in_flight', 'waiting_next', 'completed', 'replied', 'bounced', 'unsubscribed', 'removed', 'cancelled', 'failed')),
	CONSTRAINT "campaign_leads_step_ck" CHECK(next_step BETWEEN 0 AND 3),
	CONSTRAINT "campaign_leads_recipient_ck" CHECK(recipient_email IS NOT NULL OR redacted_at IS NOT NULL OR status IN ('pending', 'excluded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_leads_uq` ON `campaign_leads` (`campaign_id`,`lead_id`);--> statement-breakpoint
CREATE INDEX `campaign_leads_queue_idx` ON `campaign_leads` (`status`,`next_send_at`);--> statement-breakpoint
CREATE INDEX `campaign_leads_hash_idx` ON `campaign_leads` (`recipient_hash`);--> statement-breakpoint
CREATE INDEX `campaign_leads_domain_idx` ON `campaign_leads` (`recipient_domain`);--> statement-breakpoint
CREATE INDEX `campaign_leads_lead_idx` ON `campaign_leads` (`lead_id`);--> statement-breakpoint
CREATE TABLE `campaign_steps` (
	`campaign_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`language` text NOT NULL,
	`template_id` integer NOT NULL,
	`delay_days` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`campaign_id`, `step_index`, `language`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "campaign_steps_index_ck" CHECK(step_index BETWEEN 0 AND 2),
	CONSTRAINT "campaign_steps_delay_ck" CHECK(step_index = 0 OR delay_days >= 5)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`mailbox_id` integer,
	`selection` text NOT NULL,
	`send_window` text NOT NULL,
	`daily_cap` integer DEFAULT 20 NOT NULL,
	`min_gap_s` integer DEFAULT 90 NOT NULL,
	`max_gap_s` integer DEFAULT 240 NOT NULL,
	`pause_reason` text,
	`start_confirmed_at` integer,
	`started_at` integer,
	`paused_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "campaigns_status_ck" CHECK(status IN ('draft', 'ready', 'running', 'paused', 'completed', 'cancelled', 'stopped')),
	CONSTRAINT "campaigns_cap_ck" CHECK(daily_cap BETWEEN 1 AND 80),
	CONSTRAINT "campaigns_gap_ck" CHECK(min_gap_s >= 90 AND max_gap_s >= min_gap_s),
	CONSTRAINT "campaigns_mailbox_ck" CHECK(status IN ('draft', 'cancelled') OR mailbox_id IS NOT NULL),
	CONSTRAINT "campaigns_start_ck" CHECK(status NOT IN ('running', 'paused', 'completed', 'stopped') OR start_confirmed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`);--> statement-breakpoint
CREATE TABLE `country_policies` (
	`scope` text NOT NULL,
	`country_code` text NOT NULL,
	`mode` text NOT NULL,
	`locked` integer DEFAULT true NOT NULL,
	`approval_ref` text,
	`approved_by` text,
	`approved_at` integer,
	`note` text,
	`seed_version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `country_code`),
	CONSTRAINT "country_policies_scope_ck" CHECK(scope IN ('live', 'demo')),
	CONSTRAINT "country_policies_mode_ck" CHECK(mode IN ('blocked', 'generic_only', 'allowed')),
	CONSTRAINT "country_policies_code_ck" CHECK(length(country_code) = 2),
	CONSTRAINT "country_policies_lock_ck" CHECK(scope = 'demo' OR locked = 0 OR mode = 'blocked'),
	CONSTRAINT "country_policies_approval_ck" CHECK(scope = 'demo' OR mode = 'blocked' OR (approval_ref IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`address` text,
	`credentials_ref` text,
	`smtp_host` text,
	`smtp_port` integer,
	`smtp_secure` integer,
	`status` text DEFAULT 'not_configured' NOT NULL,
	`daily_cap` integer DEFAULT 20 NOT NULL,
	`warmup_step` integer DEFAULT 10 NOT NULL,
	`warmup_started_at` integer,
	`connected_at` integer,
	`sync_cursor` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mailboxes_provider_ck" CHECK(provider IN ('gmail', 'smtp', 'demo')),
	CONSTRAINT "mailboxes_status_ck" CHECK(status IN ('not_configured', 'connected', 'error', 'disabled')),
	CONSTRAINT "mailboxes_cap_ck" CHECK(daily_cap BETWEEN 1 AND 80),
	CONSTRAINT "mailboxes_warmup_ck" CHECK(warmup_step BETWEEN 0 AND 10),
	CONSTRAINT "mailboxes_connected_ck" CHECK(status <> 'connected' OR (address IS NOT NULL AND (provider = 'demo' OR credentials_ref IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_uq` ON `mailboxes` (`provider`,`address`) WHERE "mailboxes"."address" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`direction` text NOT NULL,
	`purpose` text NOT NULL,
	`campaign_id` integer,
	`campaign_lead_id` integer,
	`lead_id` integer,
	`mailbox_id` integer NOT NULL,
	`template_id` integer,
	`template_version` integer,
	`step_index` integer,
	`idempotency_key` text,
	`rfc_message_id` text,
	`provider_message_id` text,
	`thread_id` text,
	`in_reply_to` text,
	`references` text,
	`from_address` text,
	`to_address` text,
	`peer_hash` text NOT NULL,
	`peer_domain` text NOT NULL,
	`send_day` text,
	`subject_logged` text,
	`body_sha256` text,
	`status` text NOT NULL,
	`delivery_status` text,
	`classification` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`received_at` integer,
	`redacted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`campaign_lead_id`) REFERENCES `campaign_leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "messages_direction_ck" CHECK(direction IN ('out', 'in')),
	CONSTRAINT "messages_purpose_ck" CHECK(purpose IN ('campaign', 'test', 'inbound')),
	CONSTRAINT "messages_status_ck" CHECK((direction = 'out' AND status IN ('queued', 'sending', 'sent', 'failed', 'unknown')) OR (direction = 'in' AND status IN ('received', 'matched', 'unmatched', 'ignored'))),
	CONSTRAINT "messages_delivery_ck" CHECK(delivery_status IS NULL OR (direction = 'out' AND delivery_status IN ('bounced_soft', 'bounced_hard'))),
	CONSTRAINT "messages_classification_ck" CHECK(classification IS NULL OR classification IN ('reply', 'bounce', 'auto_reply', 'unsubscribe', 'negative', 'other')),
	CONSTRAINT "messages_campaign_ck" CHECK(direction <> 'out' OR purpose <> 'campaign' OR (campaign_id IS NOT NULL AND campaign_lead_id IS NOT NULL AND send_day IS NOT NULL AND idempotency_key IS NOT NULL)),
	CONSTRAINT "messages_recipient_ck" CHECK(direction <> 'out' OR to_address IS NOT NULL OR redacted_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idempotency_uq` ON `messages` (`idempotency_key`) WHERE "messages"."idempotency_key" IS NOT NULL AND "messages"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX `messages_rfc_uq` ON `messages` (`rfc_message_id`,`direction`) WHERE "messages"."rfc_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_domain_day_uq` ON `messages` (`peer_domain`,`send_day`) WHERE "messages"."direction" = 'out' AND "messages"."purpose" = 'campaign' AND "messages"."status" IN ('sending', 'sent', 'unknown');--> statement-breakpoint
CREATE INDEX `messages_peer_hash_idx` ON `messages` (`peer_hash`,`sent_at`);--> statement-breakpoint
CREATE INDEX `messages_peer_domain_idx` ON `messages` (`peer_domain`,`sent_at`);--> statement-breakpoint
CREATE INDEX `messages_campaign_idx` ON `messages` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `messages` (`lead_id`);--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_in_reply_to_idx` ON `messages` (`in_reply_to`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`email_hash` text,
	`hash_alg` text,
	`email_masked` text,
	`domain` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`message_id` integer,
	`note` text,
	`added_at` integer NOT NULL,
	`lifted_at` integer,
	`lifted_reason` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "suppressions_scope_ck" CHECK(scope IN ('email', 'domain')),
	CONSTRAINT "suppressions_reason_ck" CHECK(reason IN ('unsubscribe', 'bounce_hard', 'complaint', 'manual', 'negative_reply', 'erasure')),
	CONSTRAINT "suppressions_source_ck" CHECK(source IN ('manual', 'csv', 'link', 'inbox', 'bounce', 'system')),
	CONSTRAINT "suppressions_key_ck" CHECK(scope = 'domain' OR (email_hash IS NOT NULL AND hash_alg IS NOT NULL)),
	CONSTRAINT "suppressions_lift_ck" CHECK(lifted_at IS NULL OR lifted_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_uq` ON `suppressions` (`email_hash`) WHERE "suppressions"."scope" = 'email' AND "suppressions"."lifted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_domain_uq` ON `suppressions` (`domain`) WHERE "suppressions"."scope" = 'domain' AND "suppressions"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `suppressions_domain_idx` ON `suppressions` (`domain`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`language` text NOT NULL,
	`category_key` text,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`body_html` text NOT NULL,
	`body_text` text NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "templates_kind_ck" CHECK(kind IN ('initial', 'followup'))
);
--> statement-breakpoint
CREATE INDEX `templates_lookup_idx` ON `templates` (`language`,`category_key`,`kind`) WHERE "templates"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE `leads` ADD `last_contacted_at` integer;--> statement-breakpoint
CREATE INDEX `leads_last_contacted_idx` ON `leads` (`last_contacted_at`);