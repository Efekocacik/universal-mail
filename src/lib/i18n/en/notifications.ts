import type { notifications as TrNotifications } from "../tr/notifications";
import type { EnFragment } from "../types";

/** Bildirim metinlerinin İngilizcesi. */
export const notifications = {
  "notif.bell.label": "Notifications",
  "notif.empty": "No notifications yet",
  "notif.markAllRead": "Mark all as read",
  "notif.summary.title": "{n} new notifications",
  "notif.summary.body": "Open the notifications in the app for details.",
  "notif.scanDone.title": "{n} new businesses found",
  "notif.scanDone.body": "The scan has finished.",
  "notif.scanDone.bodyRegion": "The {region} scan has finished.",
  "notif.scanFailed.title": "Scan could not finish",
  "notif.scanFailed.body": "See the Scans page for details.",
  "notif.scanFailed.bodyRegion":
    "The {region} scan could not finish. See the Scans page for details.",
  "notif.scanPaused.title": "Scan paused",
  "notif.scanPaused.body":
    "{n} scans were paused while the app restarted. You can resume them on the Scans page.",
  "notif.opened.title": "{n} businesses have opened!",
  "notif.opened.body": "Businesses you were watching as opening soon are now operational.",
  "notif.opened.bodyRegion":
    "{region}: businesses you were watching as opening soon are now operational.",
  "notif.scheduleSkipped.title": "Scheduled scan skipped",
  "notif.scheduleSkipped.body.BUDGET_BLOCKED":
    "The monthly Google budget is used up; the scan will be retried when the budget renews.",
  "notif.scheduleSkipped.body.NEEDS_ACK":
    "The estimated cost exceeds the limit you approved. Run the scan from the Scans page and confirm it.",
  "notif.scheduleSkipped.body.PLACES_KEY_MISSING":
    "There is no Google Places API key; add one in Settings.",
  "notif.scheduleSkipped.body.SETUP_REQUIRED":
    "The scan could not start because setup is not complete.",
  "notif.scheduleSkipped.body.COUNTRY_NOT_TARGETED":
    "The region's country is no longer one of your target countries.",
  "notif.scheduleSkipped.body.ACTIVE_SCAN":
    "Another scan for the same region and categories is running; it will be retried in an hour.",
  "notif.scheduleSkipped.body.CATEGORY_SET_MISSING":
    "A category this schedule uses no longer exists. Edit the schedule on the Scans page.",
  "notif.scheduleSkipped.body.other": "The scan could not run this time; it will be retried.",
  "notif.backgroundSkipped.title": "Background check skipped",
  "notif.backgroundSkipped.body.PLACES_KEY_MISSING":
    "Business statuses could not be checked because there is no Google Places API key.",
  "notif.backgroundSkipped.body.BUDGET_BLOCKED":
    "The monthly Google budget is used up; business statuses will be checked when it renews.",
  "notif.backgroundSkipped.body.CONSENT_REQUIRED":
    "The background check did not run because the terms of use have not been accepted.",
  "notif.backgroundSkipped.body.other":
    "The background check could not run this time; it will be retried.",
} as const satisfies EnFragment<typeof TrNotifications>;
