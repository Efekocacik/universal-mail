/**
 * Faz 6 (P0): yedek, geri yükleme, verileri silme ve saklama süresi hata kodları ile HTTP durumları. Sahibi: paket Y.
 * Kodlar `API_ERROR_CODES`'tadır; TR+EN `apiError.<KOD>` metinleri `src/lib/i18n/{tr,en}/backup.ts`'tedir. Uçlar
 * `new HttpError(LIFECYCLE_ERROR_STATUS[e.code], e.message, { code: e.code })` biçiminde döndürür.
 */
export const LIFECYCLE_ERROR_CODES = [
  "BACKUP_PASSPHRASE_REQUIRED",
  "BACKUP_PASSPHRASE_WEAK",
  "BACKUP_PASSPHRASE_MISMATCH",
  "BACKUP_IN_PROGRESS",
  "BACKUP_FOLDER_INVALID",
  "BACKUP_FOLDER_UNWRITABLE",
  "BACKUP_DISK_FULL",
  "BACKUP_FAILED",
  "BACKUP_FILE_MISSING",
  "BACKUP_BAD_FORMAT",
  "BACKUP_WRONG_PASSPHRASE",
  "BACKUP_CORRUPT",
  "BACKUP_SCHEMA_NEWER",
  "BACKUP_TOO_LARGE",
  "RESTORE_STAGE_NOT_FOUND",
  "RESTORE_CONFIRM_REQUIRED",
  "WIPE_CONFIRM_MISMATCH",
  "LIFECYCLE_PENDING",
  "RETENTION_PREVIEW_STALE",
] as const;
export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number];

export const LIFECYCLE_ERROR_STATUS: Record<LifecycleErrorCode, number> = {
  BACKUP_PASSPHRASE_REQUIRED: 400,
  BACKUP_PASSPHRASE_WEAK: 400,
  BACKUP_PASSPHRASE_MISMATCH: 400,
  BACKUP_IN_PROGRESS: 409,
  BACKUP_FOLDER_INVALID: 400,
  BACKUP_FOLDER_UNWRITABLE: 400,
  BACKUP_DISK_FULL: 507,
  BACKUP_FAILED: 500,
  BACKUP_FILE_MISSING: 410,
  BACKUP_BAD_FORMAT: 422,
  BACKUP_WRONG_PASSPHRASE: 422,
  BACKUP_CORRUPT: 422,
  BACKUP_SCHEMA_NEWER: 409,
  BACKUP_TOO_LARGE: 413,
  RESTORE_STAGE_NOT_FOUND: 410,
  RESTORE_CONFIRM_REQUIRED: 400,
  WIPE_CONFIRM_MISMATCH: 400,
  LIFECYCLE_PENDING: 409,
  RETENTION_PREVIEW_STALE: 409,
};

/** Servis katmanı hatası: kararlı kod + kullanıcıya gösterilebilir Türkçe ileti (yol, parola veya kişisel veri içermez). */
export class LifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }

  get status(): number {
    return LIFECYCLE_ERROR_STATUS[this.code];
  }
}
