import type { backup as TrBackup } from "../tr/backup";
import type { EnFragment } from "../types";

/** Package Y (Faz 6): Settings → Backups (password, automatic backups, list, restore, retention, delete all data). */
export const backup = {
  "settings.nav.backup": "Backups",
  "backup.title": "Backups and data retention",
  "backup.desc":
    "Take encrypted backups of your data, restore them if needed, and choose how long old records are kept.",
  "backup.fileFilter": "Universal Mail backup",
  "apiError.BACKUP_PASSPHRASE_REQUIRED":
    "Set a backup password first. Backups are encrypted with this password.",
  "apiError.BACKUP_PASSPHRASE_WEAK":
    "The password is too short or too simple. Use at least 10 characters, not all the same.",
  "apiError.BACKUP_PASSPHRASE_MISMATCH": "The two passwords do not match. Please type them again.",
  "apiError.BACKUP_IN_PROGRESS":
    "A backup is running right now. Wait for it to finish and try again.",
  "apiError.BACKUP_FOLDER_INVALID":
    "This folder cannot be used. Choose an existing folder (not the app's own folder).",
  "apiError.BACKUP_FOLDER_UNWRITABLE":
    "This folder cannot be written to. Choose another folder or switch back to the default.",
  "apiError.BACKUP_DISK_FULL": "There is not enough disk space. Free up some space and try again.",
  "apiError.BACKUP_FAILED":
    "The backup could not be taken. Try again; if it keeps failing, send the log folder to support.",
  "apiError.BACKUP_FILE_MISSING":
    "The backup file was not found. It may have been moved or deleted; you can remove it from the list.",
  "apiError.BACKUP_BAD_FORMAT": "This file is not a Universal Mail backup or cannot be read.",
  "apiError.BACKUP_WRONG_PASSPHRASE":
    "The password does not match this backup. Type the password that was set when the backup was taken.",
  "apiError.BACKUP_CORRUPT":
    "The backup file is damaged or was changed, so it cannot be restored. Try another backup.",
  "apiError.BACKUP_SCHEMA_NEWER":
    "This backup was taken with a newer version of the app. Update the app first.",
  "apiError.BACKUP_TOO_LARGE":
    "The file is too large to upload. In the desktop app, pick it with “Choose file…”.",
  "apiError.RESTORE_STAGE_NOT_FOUND":
    "The restore preparation expired. Choose the backup again and re-enter the password.",
  "apiError.RESTORE_CONFIRM_REQUIRED": "Tick the confirmation box to start the restore.",
  "apiError.WIPE_CONFIRM_MISMATCH":
    "The confirmation text does not match. Type the phrase exactly as shown.",
  "apiError.LIFECYCLE_PENDING":
    "An action is waiting for a restart. Restart the app first or cancel that action.",
  "apiError.RETENTION_PREVIEW_STALE":
    "The number of records to delete went up while you were looking. Check the new number and confirm again.",
} as const satisfies EnFragment<typeof TrBackup>;
