-- Aşama 15.10-1 (D1-B, D2-A). `drizzle-kit generate`in ürettiği campaign_leads yeniden oluşturması KULLANILMAZ:
-- campaign_leads yalnızca ek sütun alır; messages güvenli kalıpla yeniden oluşturulur (id'ler, sqlite_sequence,
-- indeksler ve suppressions.message_id bağlantıları korunur). Migrasyon `client.migrate()` ile çalışır: işlem
-- başlamadan önce `PRAGMA foreign_keys=off` verilir (DROP TABLE, suppressions.message_id'yi SET NULL yapmasın).
-- Geri alma: scripts/rollback-0003.ts. Tüm bekçiler hata verirse işlemin tamamı geri alınır.
CREATE TEMP TABLE `__um_0003` (`k` text PRIMARY KEY, `v` integer)
--> statement-breakpoint
INSERT INTO `__um_0003` VALUES ('messages', (SELECT COUNT(*) FROM `messages`)), ('campaign_leads', (SELECT COUNT(*) FROM `campaign_leads`)), ('sup_linked', (SELECT COUNT(`message_id`) FROM `suppressions`)), ('sup_sum', (SELECT COALESCE(SUM(`message_id`), 0) FROM `suppressions`)), ('msg_idsum', (SELECT COALESCE(SUM(`id`), 0) FROM `messages`)), ('seq', COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'), 0))
--> statement-breakpoint
ALTER TABLE `campaign_leads` ADD `stop_reason` text CONSTRAINT "campaign_leads_stop_reason_ck" CHECK(stop_reason IS NULL OR stop_reason IN ('unsubscribe', 'complaint'))
--> statement-breakpoint
CREATE TABLE `__new_messages` (
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
	CONSTRAINT "messages_classification_ck" CHECK(classification IS NULL OR classification IN ('reply', 'bounce', 'auto_reply', 'unsubscribe', 'negative', 'complaint', 'other')),
	CONSTRAINT "messages_campaign_ck" CHECK(direction <> 'out' OR purpose <> 'campaign' OR (campaign_id IS NOT NULL AND campaign_lead_id IS NOT NULL AND send_day IS NOT NULL AND idempotency_key IS NOT NULL)),
	CONSTRAINT "messages_recipient_ck" CHECK(direction <> 'out' OR to_address IS NOT NULL OR redacted_at IS NOT NULL)
)
--> statement-breakpoint
INSERT INTO `__new_messages` (`id`, `direction`, `purpose`, `campaign_id`, `campaign_lead_id`, `lead_id`, `mailbox_id`, `template_id`, `template_version`, `step_index`, `idempotency_key`, `rfc_message_id`, `provider_message_id`, `thread_id`, `in_reply_to`, `references`, `from_address`, `to_address`, `peer_hash`, `peer_domain`, `send_day`, `subject_logged`, `status`, `delivery_status`, `classification`, `error_code`, `error_message`, `created_at`, `sent_at`, `received_at`, `redacted_at`) SELECT `id`, `direction`, `purpose`, `campaign_id`, `campaign_lead_id`, `lead_id`, `mailbox_id`, `template_id`, `template_version`, `step_index`, `idempotency_key`, `rfc_message_id`, `provider_message_id`, `thread_id`, `in_reply_to`, `references`, `from_address`, `to_address`, `peer_hash`, `peer_domain`, `send_day`, `subject_logged`, `status`, `delivery_status`, `classification`, `error_code`, `error_message`, `created_at`, `sent_at`, `received_at`, `redacted_at` FROM `messages`
--> statement-breakpoint
SELECT CASE WHEN (SELECT COUNT(*) FROM `messages`) <> (SELECT COUNT(*) FROM `__new_messages`) THEN abs(-9223372036854775808) END
--> statement-breakpoint
DELETE FROM `sqlite_sequence` WHERE `name` = '__new_messages'
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT '__new_messages', `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'
--> statement-breakpoint
DROP TABLE `messages`
--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idempotency_uq` ON `messages` (`idempotency_key`) WHERE "messages"."idempotency_key" IS NOT NULL AND "messages"."status" <> 'failed'
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_rfc_uq` ON `messages` (`rfc_message_id`,`direction`) WHERE "messages"."rfc_message_id" IS NOT NULL
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_domain_day_uq` ON `messages` (`peer_domain`,`send_day`) WHERE "messages"."direction" = 'out' AND "messages"."purpose" = 'campaign' AND "messages"."status" IN ('sending', 'sent', 'unknown')
--> statement-breakpoint
CREATE INDEX `messages_peer_hash_idx` ON `messages` (`peer_hash`,`sent_at`)
--> statement-breakpoint
CREATE INDEX `messages_peer_domain_idx` ON `messages` (`peer_domain`,`sent_at`)
--> statement-breakpoint
CREATE INDEX `messages_campaign_idx` ON `messages` (`campaign_id`,`status`)
--> statement-breakpoint
CREATE INDEX `messages_lead_idx` ON `messages` (`lead_id`)
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`)
--> statement-breakpoint
CREATE INDEX `messages_in_reply_to_idx` ON `messages` (`in_reply_to`)
--> statement-breakpoint
UPDATE `messages` SET `classification` = 'complaint' WHERE `classification` = 'other' AND (`error_code` = 'arf_complaint' OR `error_code` LIKE 'arf_complaint:%')
--> statement-breakpoint
UPDATE `campaign_leads` SET `stop_reason` = CASE WHEN `exclusion_reasons` LIKE '%"arf_complaint"%' THEN 'complaint' ELSE 'unsubscribe' END WHERE `status` = 'unsubscribed'
--> statement-breakpoint
SELECT CASE WHEN (SELECT COUNT(*) FROM `messages`) <> (SELECT `v` FROM `__um_0003` WHERE `k` = 'messages') OR (SELECT COUNT(*) FROM `campaign_leads`) <> (SELECT `v` FROM `__um_0003` WHERE `k` = 'campaign_leads') THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN (SELECT COALESCE(SUM(`id`), 0) FROM `messages`) <> (SELECT `v` FROM `__um_0003` WHERE `k` = 'msg_idsum') THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN (SELECT COUNT(`message_id`) FROM `suppressions`) <> (SELECT `v` FROM `__um_0003` WHERE `k` = 'sup_linked') OR (SELECT COALESCE(SUM(`message_id`), 0) FROM `suppressions`) <> (SELECT `v` FROM `__um_0003` WHERE `k` = 'sup_sum') THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'), 0) < (SELECT `v` FROM `__um_0003` WHERE `k` = 'seq') OR COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'messages'), 0) < (SELECT COALESCE(MAX(`id`), 0) FROM `messages`) THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN (SELECT COUNT(*) FROM `sqlite_master` WHERE `type` = 'index' AND `tbl_name` = 'messages' AND `name` LIKE 'messages\_%' ESCAPE '\') <> 9 OR (SELECT COUNT(*) FROM `sqlite_master` WHERE `name` = '__new_messages') <> 0 THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN abs(-9223372036854775808) END
--> statement-breakpoint
SELECT CASE WHEN EXISTS (SELECT 1 FROM `campaign_leads` WHERE `stop_reason` IS NOT NULL AND `status` <> 'unsubscribed') THEN abs(-9223372036854775808) END
--> statement-breakpoint
DROP TABLE `__um_0003`
