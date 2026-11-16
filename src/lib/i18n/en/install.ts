import type { install as TrInstall } from "../tr/install";
import type { EnFragment } from "../types";

/** Package K (Faz 6): "Finish setting up" card, migration-recovery dialogs used by Electron, menu additions. */
export const install = {
  "onboarding.title": "Finish setting up",
  "onboarding.progress": "{done}/{total} done",
  "onboarding.desc":
    "The steps left before Universal Mail is ready for real use. The link on each row opens the right screen.",
  "onboarding.progressLabel": "Setup progress",
  "onboarding.allDone.title": "Setup complete",
  "onboarding.allDone.desc": "Every step is done. You can hide this card now.",
  "onboarding.hide": "Hide",
  "onboarding.hideLabel": "Hide the setup checklist",
  "onboarding.hidden": "Setup checklist hidden.",
  "onboarding.undo": "Undo",
  "onboarding.show": "Show the setup checklist ({done}/{total})",
  "onboarding.statusDone": "Done",
  "onboarding.statusTodo": "To do",
  "onboarding.demo": "Demo",
  "onboarding.demoHint": "Done in demo mode; do this step again for real use.",
  "onboarding.open": "Open",
  "onboarding.loadError": "The setup checklist could not be loaded.",
  "onboarding.item.setup.title": "Finish the setup wizard",
  "onboarding.item.setup.desc":
    "Usage consent, sender company, target markets, data source and budget.",
  "onboarding.item.dataSource.title": "Connect the data source",
  "onboarding.item.dataSource.desc":
    "Enter your Google Places API key. Demo mode is only for trying things out.",
  "onboarding.item.firstScan.title": "Run your first scan",
  "onboarding.item.firstScan.desc": "Pick a city or an area and find newly opened businesses.",
  "onboarding.item.mailbox.title": "Connect your Gmail mailbox",
  "onboarding.item.mailbox.desc": "A connected Gmail mailbox with send permission is required.",
  "onboarding.item.testEmail.title": "Send yourself a test email",
  "onboarding.item.testEmail.desc":
    "Check in your own inbox that the message and its footer look right to a recipient.",
  "onboarding.item.unsubscribe.title": "Verify the unsubscribe link",
  "onboarding.item.unsubscribe.desc":
    "Tests end to end that recipients can opt out with one click.",
  "onboarding.item.backup.title": "Set a backup password and take the first backup",
  "onboarding.item.backup.desc":
    "Only you know the password; if it is forgotten the backup cannot be opened. Also copy the backup to an external disk.",

  "electron.migrate.title": "The database could not be updated",
  "electron.migrate.body.BLOCKED":
    "Another Universal Mail window or process is using the database right now. Close the other Universal Mail windows and press “Try again”. Nothing in your data was changed.",
  "electron.migrate.body.DISK_FULL":
    "There is not enough free disk space. Free up some space (for example delete large files or empty the Trash) and press “Try again”.",
  "electron.migrate.body.CORRUPT":
    "The database file appears to be damaged. You can go back to the pre-update backup or ask for support and share the log folder.",
  "electron.migrate.body.VERIFY_FAILED":
    "The update was applied but the integrity check after it failed. Going back to the pre-update backup is recommended.",
  "electron.migrate.body.FAILED":
    "An unexpected error occurred while updating your data for this version. You can try again, go back to the pre-update backup or ask for support.",
  "electron.migrate.backupAvailable":
    "An automatic backup was taken right before the update; you can return your data to that state.",
  "electron.migrate.noBackup":
    "There is no pre-update backup (none is taken on a first install or when nothing was changed).",
  "electron.migrate.retryExhausted":
    "This was tried several times and the problem persists. Close the app and ask for support.",
  "electron.migrate.dataDir": "Data folder: {dir}",
  "electron.migrate.btn.retry": "Try again",
  "electron.migrate.btn.restore": "Go back to the pre-update backup",
  "electron.migrate.btn.logs": "Open the log folder",
  "electron.migrate.btn.quit": "Quit",
  "electron.migrate.btn.ok": "OK",
  "electron.migrate.confirm.title": "Go back to the pre-update backup?",
  "electron.migrate.confirm.body":
    "The current database is not deleted; it is moved to the backup folder as “{file}” and the pre-update copy is put in its place. The update runs at startup, so no changes are lost in between.",
  "electron.migrate.confirm.yes": "Go back to the backup",
  "electron.migrate.confirm.no": "Cancel",
  "electron.migrate.restored.title": "Your data is back to its pre-update state",
  "electron.migrate.restored.body":
    "This version could not update the database. Reinstall the previous Universal Mail version or ask for support and share the log folder. The app will now close.",
  "electron.migrate.restoreFailed.title": "Could not go back to the backup",
  "electron.migrate.restoreFailed.body":
    "Going back to the backup could not be completed. No file was deleted and your database is unchanged. Share the log folder when you ask for support.",
  "electron.migrate.restoreFailed.partial":
    "Going back to the backup stopped halfway and some files could not be moved back. No file was deleted: your previous database is in the backup folder as “failed-migrate-…”. Ask for support before opening the app.",
} as const satisfies EnFragment<typeof TrInstall>;
