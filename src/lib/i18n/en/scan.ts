import type { scan as TrScan } from "../tr/scan";
import type { EnFragment } from "../types";

/** Paket B anahtarlarının İngilizcesi. */
export const scan = {
  "scans.origin.schedule": "Scheduled",
  "schedules.title": "Recurring scans",
  "help.schedules":
    "Rescans the chosen area automatically at the interval you set. A run can never cost more than the amount you approved; if it would, it pauses and asks you.",
  "schedules.loadError": "Recurring scans could not be loaded.",
  "schedules.empty":
    'No recurring scans yet. Press "Repeat regularly" on a finished scan to have the same area scanned automatically every week, every two weeks or every month.',
  "schedules.whileOpen":
    "Recurring scans only run while the app is open. Runs missed while the app was closed are combined into a single scan when it opens.",
  "schedules.next": "Next run",
  "schedules.next.off": "Paused",
  "schedules.next.due": "Now (starts within a few minutes)",
  "schedules.next.soon": "Soon: {at}",
  "schedules.last": "Last result",
  "schedules.outcome.completed": "Finished",
  "schedules.outcome.started": "Running",
  "schedules.outcome.failed": "Could not finish",
  "schedules.outcome.skipped": "Skipped",
  "schedules.outcome.paused": "Paused",
  "schedules.skip.BUDGET_BLOCKED":
    "Skipped because the monthly Google budget is used up. Raise the budget in Settings or wait for next month; it will be retried tomorrow.",
  "schedules.skip.NEEDS_ACK":
    'Skipped because the estimated cost exceeds the limit you approved for this schedule. Start it with "Run now" and confirm, or raise the limit.',
  "schedules.skip.PLACES_KEY_MISSING":
    "Skipped because there is no Google Places API key. Add the key in Settings.",
  "schedules.skip.SETUP_REQUIRED":
    "Skipped because setup or the usage consent is incomplete. Finish the setup wizard.",
  "schedules.skip.COUNTRY_NOT_TARGETED":
    "Skipped because the area's country is no longer one of your target countries. Add it under Settings > Target markets.",
  "schedules.skip.ACTIVE_SCAN":
    "Skipped because another scan of the same area and categories is running; it will be retried in an hour.",
  "schedules.skip.CATEGORY_SET_MISSING":
    "A category used by this schedule no longer exists. Delete this schedule and set the scan up again.",
  "schedules.skip.PREVIOUS_RUN_ACTIVE":
    "The previous scheduled scan is still running; the next run starts after it finishes.",
  "schedules.skip.SCAN_RETRYING":
    "The last scan was paused because Google could not be reached; it will resume automatically within an hour.",
  "schedules.skip.SCAN_BUDGET_STOPPED":
    "The last scan stopped because the monthly Google budget is used up. It will resume automatically when the budget renews or when you raise it in Settings.",
  "schedules.skip.SCAN_PAUSED":
    "The last scan is paused (you paused it or it reached its safety limit). Resume or cancel it in the scan list below; no new run starts until then.",
  "schedules.skip.other": "It could not run this time; it will be retried tomorrow.",
  "schedules.interval.7": "Every week",
  "schedules.interval.14": "Every two weeks",
  "schedules.interval.30": "Every month",
  "schedules.missed":
    "{n} runs were missed while the app was closed; they were combined into one scan.",
  "schedules.cap.user": "Approved limit per scan: {usd}",
  "schedules.cap.auto": "Approved amount per scan (automatic): up to {usd}",
  "schedules.toggle": "Turn the recurring scan on or off",
  "schedules.on": "On",
  "schedules.off": "Off",
  "schedules.runNow": "Run now",
  "schedules.delete": "Delete schedule",
  "schedules.delete.title": "Delete this recurring scan?",
  "schedules.delete.body":
    "This area will no longer be scanned automatically. Earlier scans and the businesses found are kept.",
  "schedules.deleted": "Recurring scan deleted.",
  "schedules.updated": "Recurring scan updated.",
  "schedules.created": "Recurring scan set up. First run: {at}.",
  "schedules.exists": "There is already a recurring scan for this area and these categories.",
  "schedules.repeat": "Repeat regularly",
  "schedules.repeat.title": "Repeat this scan regularly?",
  "schedules.repeat.body":
    "The same area and categories are scanned automatically at the interval you choose. Each run only reports new and newly opened businesses.",
  "schedules.repeat.confirm": "Repeat regularly",
  "schedules.field.interval": "How often?",
  "schedules.field.cap": "Maximum per scan (USD, optional)",
  "schedules.field.cap.placeholder": "Leave empty for automatic",
  "schedules.field.cap.hint":
    "If the estimated cost exceeds this amount the scan does not run and you are notified. If you leave it empty, today's highest estimate (assuming the free quota is used up) is approved.",
  "schedules.field.cap.invalid": "Enter an amount between 0 and 10,000 or leave it empty.",
  "builder.repeat": "Repeat this scan regularly",
  "builder.repeat.note":
    "After the scan starts, the same area is scanned again automatically at the interval you choose.",

  "retention.title": "Google data retention rules",
  "retention.desc":
    "Under Google's rules each kind of data is kept for its own period. Your own records (notes, statuses, emails) are not affected.",
  "retention.col.data": "Data",
  "retention.col.count": "Records",
  "retention.col.rule": "Rule",
  "retention.row.ids": "Place IDs",
  "retention.row.coords": "Locations (latitude/longitude)",
  "retention.row.session": "Name, address, phone, status (temporary)",
  "retention.row.derived": '"Opening soon / opened / new" markers',
  "retention.rule.ids": "May be kept indefinitely; refreshed every {days} days",
  "retention.rule.days": "At most {days} days",
  "retention.rule.session":
    "Temporary memory only, at most {days} days; removed when the app closes",
  "retention.rule.derived.forever": "Indefinitely (legal review pending)",
  "retention.gone":
    "{n} businesses can no longer be found on Google; your records were not deleted.",
  "retention.derived.label": "How long should markers be kept?",
  "retention.derived.forever": "Indefinitely",
  "retention.derived.days": "{days} days",
  "retention.derived.hint":
    "When the period ends only the markers are cleared; your business records and notes stay.",
  "retention.saved": "Retention period saved.",
  "retention.refresh": "Refresh place IDs now",
  "retention.refresh.due": "{n} IDs are due for a refresh (free).",
  "retention.refresh.queued": "Place IDs are being refreshed in the background.",
  "retention.refresh.already": "A refresh was already started today.",
  "retention.sources": "Sources (last checked: {date})",
  "retention.source.terms": "Google Maps Platform Terms of Service",
  "retention.source.policies": "Places API: caching and storage policies",
  "retention.source.placeId": "Places API: storing place IDs",
  "retention.legal":
    "This summary is not legal advice. Confirm the terms with a lawyer before going live.",

  "rdap.title": "Domain age",
  "rdap.desc":
    "If the business's website domain was registered recently, +20 is added to the novelty score. It hints at a new business; it is not proof.",
  "rdap.toggle": "Turn the domain age check on or off",
  "rdap.privacy":
    "Only the domain name (e.g. firma.de) is sent to the public registration server (RDAP); no business name or email is sent.",
  "rdap.privacy.demo":
    "In demo mode nothing is sent over the internet; registration dates are generated as examples.",
  "rdap.days": 'Up to how many days old counts as a "new" domain?',
  "rdap.days.save": "Save",
  "rdap.days.hint": "Default 183 days (about 6 months).",
  "rdap.days.invalid": "Enter a number of days between {min} and {max}.",
  "rdap.saved": "Domain age setting saved.",
  "rdap.summary":
    "{known} domains with a known registration date · {waiting} waiting · {unknown} without a date · {failed} to be retried",
  "rdap.lastChecked": "Last check: {at}",
  "rdap.check": "Check now",
  "rdap.check.queued": "Domains are being checked in the background.",
  "rdap.check.already": "A check is already running.",

  "detail.gone": "No longer on Google",
  "detail.gone.hint":
    "Google can no longer find this business (it may have closed or its listing was removed). Your record was not deleted.",
  "detail.domainAge": "Domain registration",
  "detail.domainAge.value": "{date} (about {months} months ago)",
  "detail.domainAge.pending": "Not checked yet",
  "detail.domainAge.no_date": "Registration date is not published",
  "detail.domainAge.not_found": "No registration found",
  "detail.domainAge.unsupported_tld": "No registration lookup for this extension",
  "detail.domainAge.rate_limited": "Registration server busy; will retry",
  "detail.domainAge.error": "Could not be checked; will retry",
  "detail.domainAge.disabled": "Check turned off (you can turn it on under Settings > Domain age)",

  "novelty.signal.future_opening":
    'Google lists this business as "opening soon". That does not mean it is looking for suppliers.',
  "novelty.signal.reviews_very_few":
    "It has very few reviews. On its own this does not show it is new.",
  "novelty.signal.reviews_few": "It has a small number of reviews. A low-confidence indicator.",
  "novelty.signal.domain_young":
    "The website's domain was registered about {months} months ago. It may be a new business; this is not proof.",
} as const satisfies EnFragment<typeof TrScan>;
