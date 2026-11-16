import type { backup as TrBackup } from "../tr/backup";
import type { EnFragment } from "../types";

/** Package Y (Faz 6): Settings → Backups (password, automatic backups, list, restore, retention, delete all data). */
export const backup = {
  "settings.nav.backup": "Backups",
  "backup.title": "Backups and data retention",
  "backup.desc":
    "Take encrypted backups of your data, restore them if needed, and choose how long old records are kept.",
  "backup.fileFilter": "Universal Mail backup",
  "backup.loadError": "Backup information could not be loaded.",
  "backup.retry": "Try again",
  "backup.pending.restore.title": "A restore is waiting for a restart",
  "backup.pending.restore.body":
    "When the app restarts, the backup you chose will be restored. Your current data is copied aside first.",
  "backup.pending.wipe.title": "Deleting your data is waiting for a restart",
  "backup.pending.wipe.body":
    "When the app restarts, all Universal Mail data on this computer will be deleted and the setup screen will open.",
  "backup.pending.wipe.backups": "Backup files will be deleted too.",
  "backup.pending.wipe.keepBackups": "Encrypted backup files will be kept.",
  "backup.restart": "Restart now",
  "backup.restart.manual": "Close and reopen the app; the action is applied at start.",
  "backup.pending.cancel": "Cancel this action",
  "backup.pending.cancelled": "The waiting action was cancelled.",
  "backup.result.restore.ok": "The backup was restored.",
  "backup.result.restore.okSecrets": "The backup was restored together with the saved keys.",
  "backup.result.restore.fail":
    "The restore could not be applied; your current data was not changed. Choose the backup again and retry.",
  "backup.result.wipe.ok": "Your data was deleted. The app is as it was on first setup.",
  "backup.result.wipe.partial":
    "Your data was deleted, but some files could not be removed. Details are in the log file.",
  "backup.result.dismiss": "OK",
  "backup.pass.title": "Backup password",
  "backup.pass.desc":
    "Backups are encrypted with this password. Write it down somewhere safe: if you forget it, the backups cannot be opened and nobody can recover them.",
  "backup.pass.set": "Password set",
  "backup.pass.missing": "No password: automatic backups are not taken",
  "backup.pass.new": "New password",
  "backup.pass.confirm": "Type the password again",
  "backup.pass.save": "Save password",
  "backup.pass.saved": "Backup password saved.",
  "backup.pass.changeWarn":
    "If you change the password, older backups still open with the old password. Keep the old one too.",
  "backup.pass.rule": "At least 10 characters, not all the same character.",
  "backup.pass.mismatch": "The two passwords do not match.",
  "backup.pass.strength": "Strength: {level}",
  "backup.pass.strength.weakest": "very weak",
  "backup.pass.strength.weak": "weak",
  "backup.pass.strength.good": "good",
  "backup.pass.strength.strong": "strong",
  "backup.pass.show": "Show password",
  "backup.pass.hide": "Hide password",
  "backup.auto.title": "Automatic backup",
  "backup.auto.desc":
    "The app takes an encrypted backup by itself the first time it opens each day and once a week.",
  "backup.auto.enabled": "Take automatic backups",
  "backup.auto.enabled.hint": "If you turn this off, backups are only taken with “Back up now”.",
  "backup.auto.onStartup": "At start (once a day)",
  "backup.auto.onStartup.hint": "A backup is taken the first time the app opens each day.",
  "backup.auto.weekly": "Weekly",
  "backup.auto.weekly.hint": "A new backup is taken 7 days after the last weekly one.",
  "backup.auto.keepStartup": "Start-up backups to keep",
  "backup.auto.keepWeekly": "Weekly backups to keep",
  "backup.auto.keepHint":
    "Older automatic backups are deleted by themselves. Backups you take yourself are never deleted.",
  "backup.auto.includeSecrets": "Include saved keys in backups",
  "backup.auto.includeSecrets.hint":
    "Google, Gmail and other service keys are added to the backup, encrypted, so you do not have to enter them again when restoring on another computer.",
  "backup.auto.noPass": "Set a backup password first; no automatic backup is taken without one.",
  "backup.auto.saved": "Backup settings saved.",
  "backup.auto.keepInvalid":
    "Enter a number from 1 to 30 for start-up and from 1 to 52 for weekly.",
  "backup.folder.label": "Backup folder",
  "backup.folder.default": "Default folder",
  "backup.folder.choose": "Choose folder…",
  "backup.folder.reset": "Use default",
  "backup.folder.input": "Full path of the folder",
  "backup.folder.hint":
    "An external disk or a cloud-synced folder is recommended, so backups are not lost if the computer breaks.",
  "backup.list.title": "Backups",
  "backup.list.desc":
    "Backups taken so far. You can download a file and copy it somewhere else too.",
  "backup.list.empty": "No backups yet.",
  "backup.list.missing": "File not found",
  "backup.list.secrets": "Keys included",
  "backup.list.preMigrate": "Automatic copies before updates (data folder, not encrypted): {n}",
  "backup.col.date": "Date",
  "backup.col.kind": "Type",
  "backup.col.size": "Size",
  "backup.col.actions": "Actions",
  "backup.now": "Back up now",
  "backup.now.done": "Backup taken.",
  "backup.now.skipped": "Backup taken. Keys left out because they could not be read: {n}",
  "backup.kind.manual": "Manual",
  "backup.kind.startup": "Start-up",
  "backup.kind.weekly": "Weekly",
  "backup.status.running": "Running",
  "backup.status.failed": "Failed",
  "backup.download": "Download",
  "backup.delete.title": "Delete this backup?",
  "backup.delete.body": "The file {name} will be deleted permanently.",
  "backup.deleted": "Backup deleted.",
  "backup.size.kb": "{size} KB",
  "backup.size.mb": "{size} MB",
  "backup.restore.title": "Restore",
  "backup.restore.desc":
    "When you restore a backup, the data in the backup replaces your current data. Your current data is copied aside first.",
  "backup.restore.this": "Restore",
  "backup.restore.chooseFile": "Choose file…",
  "backup.restore.upload": "Upload a backup file",
  "backup.restore.otherHint":
    "Pick a backup in the list with “Restore”, or open a .umbk file stored somewhere else.",
  "backup.restore.dialog.title": "Restore backup",
  "backup.restore.dialog.passphrase": "Password of this backup",
  "backup.restore.dialog.passHint": "The backup password that was set when the backup was taken.",
  "backup.restore.verify": "Check backup",
  "backup.restore.summary":
    "Businesses: {leads} · Campaigns: {campaigns} · Emails: {messages} · Templates: {templates}",
  "backup.restore.summaryMeta": "Taken on {date} ({ago}), version {version}",
  "backup.restore.migration":
    "This backup was taken with an older version; the database will be updated automatically at start.",
  "backup.restore.secrets": "Restore saved keys too",
  "backup.restore.secrets.hint":
    "The Google, Gmail and other service keys in the backup replace the current ones.",
  "backup.restore.confirm":
    "I understand that this backup will replace the current data on this computer.",
  "backup.restore.schedule": "Start restore",
  "backup.restore.scheduled": "The restore is ready. It will be applied when the app restarts.",
  "backup.restore.expires": "This preparation is valid for one hour.",
  "backup.ret.title": "Retention period",
  "backup.ret.desc":
    "Old business records that were never emailed and never added to a campaign are deleted by themselves after this period (12 months at most).",
  "backup.ret.enabled": "Delete old records automatically",
  "backup.ret.enabled.hint": "Checked once a day.",
  "backup.ret.months": "Retention period",
  "backup.ret.monthsValue": "{months} month(s)",
  "backup.ret.kept":
    "Kept: businesses that were emailed or added to a campaign, those marked “do not contact”, the block list and legal records.",
  "backup.ret.preview": "Would be deleted now: {n}",
  "backup.ret.previewHint": "Records added before {date}.",
  "backup.ret.run": "Apply now",
  "backup.ret.run.title": "Delete old records now?",
  "backup.ret.run.body":
    "Business records to delete permanently: {n}. This cannot be undone; your backups are not affected.",
  "backup.ret.done": "Records deleted: {n}",
  "backup.ret.lastRun": "Last run: {date} · deleted: {n}",
  "backup.ret.saved": "Retention period saved.",
  "backup.wipe.title": "Delete all my data",
  "backup.wipe.desc":
    "Deletes all Universal Mail data on this computer (businesses, campaigns, emails, settings, saved keys, logs). When the app restarts, the setup screen opens. Emails in your Gmail account and your Google account are not affected.",
  "backup.wipe.open": "Start deleting my data",
  "backup.wipe.dialog.title": "Delete all data?",
  "backup.wipe.dialog.body": "This cannot be undone. To continue, type {phrase} in the box.",
  "backup.wipe.phrase": "DELETE MY DATA",
  "backup.wipe.input": "Confirmation phrase",
  "backup.wipe.deleteBackups": "Delete backup files too",
  "backup.wipe.deleteBackups.hint":
    "If you leave this unticked, the encrypted backup files stay and you can restore them later.",
  "backup.wipe.confirm": "Schedule deletion",
  "backup.wipe.scheduled": "Deletion scheduled. It will be applied when the app restarts.",
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
