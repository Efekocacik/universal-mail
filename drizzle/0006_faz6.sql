-- Faz 6 (P0 temel): TEK, ELLE düzenlenmiş, YALNIZCA EKLEYEN migrasyon (0003–0005 emsali). Yeni tablo ve indeksler
-- `IF NOT EXISTS` ile kurulur; mevcut hiçbir tablo yeniden kurulmaz, hiçbir satır yazılmaz, silinmez veya taşınmaz.
-- Geri alma: scripts/rollback-0006.ts (src/lib/db/rollback-0006.ts). Şema sözleşmesi: src/lib/db/schema.ts.
-- `backups`: şifreli yedek dosyalarının (.umbk) kaydı; kişisel veri yok. `backups_running_uq` (kısmi tekil) aynı anda en çok
-- bir yedeğin sürmesini süreçler arasında garanti eder. Dosya adı yol ayırıcı içeremez (indirme yolu satırdan kurulur).
-- `leads_retention_idx`: hiç temas edilmemiş lead'lerin oluşturulma anı (12 aylık saklama önizlemesi ve silmesi).
-- Performans (NFR-03): 100k lead ile ölçüldü; liste/sayı/harita sorguları için ek indeks bir kazanç SAĞLAMADI (sıralama
-- `places.first_seen_at`'e de dayandığından tek tablolu indeks kullanılmıyor). Ölçümler P0 iş kaydında.
CREATE TABLE IF NOT EXISTS `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`file_name` text NOT NULL,
	`folder` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`app_version` text NOT NULL,
	`schema_migrations` integer NOT NULL,
	`includes_secrets` integer DEFAULT false NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT "backups_kind_ck" CHECK(kind IN ('manual', 'startup', 'weekly')),
	CONSTRAINT "backups_status_ck" CHECK(status IN ('running', 'ok', 'failed')),
	CONSTRAINT "backups_file_name_ck" CHECK(length(file_name) BETWEEN 10 AND 120 AND file_name NOT GLOB '*[/\]*'),
	CONSTRAINT "backups_folder_ck" CHECK(length(folder) BETWEEN 1 AND 1024),
	CONSTRAINT "backups_sha_ck" CHECK(sha256 IS NULL OR length(sha256) = 64),
	CONSTRAINT "backups_size_ck" CHECK(size_bytes IS NULL OR size_bytes >= 0),
	CONSTRAINT "backups_version_ck" CHECK(length(app_version) BETWEEN 1 AND 40),
	CONSTRAINT "backups_schema_ck" CHECK(schema_migrations >= 0),
	CONSTRAINT "backups_secrets_ck" CHECK(includes_secrets IN (0, 1)),
	CONSTRAINT "backups_error_ck" CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 40 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
	CONSTRAINT "backups_ok_ck" CHECK(status <> 'ok' OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL AND finished_at IS NOT NULL)),
	CONSTRAINT "backups_failed_ck" CHECK(status <> 'failed' OR error_code IS NOT NULL)
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `backups_file_name_uq` ON `backups` (`file_name`)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `backups_running_uq` ON `backups` (`status`) WHERE "backups"."status" = 'running'
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `backups_kind_created_idx` ON `backups` (`kind`,`created_at`)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `leads_retention_idx` ON `leads` (`created_at`) WHERE "leads"."last_contacted_at" IS NULL
