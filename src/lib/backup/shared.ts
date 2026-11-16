import { desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { backups, type BackupKind, type BackupStatus } from "@/lib/db/schema";
import { BACKUP_PASSPHRASE_SECRET, secretExists } from "@/lib/secrets/store";

/**
 * Faz 6 (P0.6): yedekle ilgili SALT OKUNUR yardımcılar ve paylaşılan türler. Paket K'nin kurulum listesi ve paket Y'nin
 * uçları/arayüzü bunları kullanır. Y bu dosyayı GENİŞLETEBİLİR ama mevcut imzaları bozamaz.
 */

/** `GET /api/backups` listesindeki satır (yol değil, yalnızca ad; klasör ayrı alanda). */
export interface BackupRow {
  id: number;
  kind: BackupKind;
  status: BackupStatus;
  fileName: string;
  /** Dosyanın yazıldığı klasör; varsayılan klasörse arayüz "Varsayılan" gösterir. */
  folder: string;
  sizeBytes: number | null;
  sha256: string | null;
  appVersion: string;
  schemaMigrations: number;
  includesSecrets: boolean;
  errorCode: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Dosya diskte hâlâ var mı (liste okunurken denetlenir). */
  fileExists: boolean;
}

/** Geri yükleme doğrulamasının (`POST /api/backups/restore/verify`) kullanıcıya gösterdiği özet. Kişisel veri yok. */
export interface BackupSummary {
  createdAt: number;
  appVersion: string;
  kind: BackupKind;
  schemaMigrations: number;
  includesSecrets: boolean;
  counts: {
    leads: number;
    campaigns: number;
    messages: number;
    templates: number;
    mailboxes: number;
    suppressions: number;
  };
}

/**
 * Yeniden başlatmada uygulanacak bekleyen yaşam döngüsü işlemi (`<dataDir>/lifecycle-pending.json`). Aynı anda en çok
 * bir tane olur; varken yenisi `LIFECYCLE_PENDING` ile reddedilir.
 */
export type LifecyclePending =
  | { v: 1; kind: "restore"; stageId: string; restoreSecrets: boolean; at: number; nonce: string }
  | {
      v: 1;
      kind: "wipe";
      deleteBackups: boolean;
      at: number;
      nonce: string;
      /**
       * Paket Y eki: özel yedek klasörü (ayar). Veritabanı açılmadan önce uygulandığı için işarette taşınır; yalnızca
       * `deleteBackups` iken ve yalnızca `universal-mail-*.umbk` dosyaları silinir (klasörün kendisi asla).
       */
      customBackupFolder?: string;
    };

/** Bekleyen işlem dosyasının adı (veri klasöründe). */
export const LIFECYCLE_PENDING_FILENAME = "lifecycle-pending.json";
/** Son uygulanan işlemin sonucu (veri klasöründe; arayüzde bir kez gösterilir). */
export const LIFECYCLE_RESULT_FILENAME = "lifecycle-result.json";
/** Şifreli yedek dosyası uzantısı. */
export const BACKUP_EXTENSION = ".umbk";

/** Yedek parolası ayarlı ve geçerli ana anahtarla çözülebiliyor mu? (Değer asla döndürülmez.) */
export async function hasBackupPassphrase(): Promise<boolean> {
  try {
    return await secretExists(BACKUP_PASSPHRASE_SECRET);
  } catch {
    // Ana anahtar yok (ör. UM_REQUIRE_MASTER_KEY ile anahtarsız) veya depo okunamıyor: parola "yok" sayılır.
    return false;
  }
}

/** En son BAŞARILI yedek (tür fark etmeksizin); hiç yoksa null. */
export async function lastSuccessfulBackup(
  db: DbExecutor,
): Promise<{ at: number; kind: BackupKind } | null> {
  const rows = await db
    .select({ at: backups.finishedAt, kind: backups.kind })
    .from(backups)
    .where(eq(backups.status, "ok"))
    .orderBy(desc(backups.finishedAt), desc(backups.id))
    .limit(1);
  const r = rows[0];
  return r && r.at !== null ? { at: r.at, kind: r.kind } : null;
}
