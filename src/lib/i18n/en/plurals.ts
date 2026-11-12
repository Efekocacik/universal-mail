import type { TrKey } from "../tr";

/**
 * İngilizce tekil biçimler. Türkçede sayıdan sonra isim tekil kalır ("1 işletme", "5 işletme"); İngilizcede kalmaz
 * ("1 businesses" yanlıştır). `t()` İngilizcede `{n}` parametresi `Intl.PluralRules("en")` ile "one" olduğunda buradaki
 * metni kullanır; diğer sayılarda (0 dahil) sözlükteki çoğul metin geçerlidir. Yalnızca sayıyı taşıyan isim veya fiil
 * değişen anahtarlar buradadır ("Step {n}" gibi sıra bildirenler değil). Yer tutucular çoğul metinle aynı olmalıdır
 * (`tests/i18n-plurals.test.ts`).
 */
export const enOne: Partial<Record<TrKey, string>> = {
  "filters.activeCount": "Clear: {n} filter active",
  "list.count": "{n} business",
  "list.uncached":
    "Google data (name, address) is not loaded for {n} business. This data is deleted when the app closes.",
  "map.cluster": "{n} business (click to zoom in)",
  "scans.saturated": "{n} dense area was scanned in more detail",
  "settings.markets.count": "{n} country selected",
  "settings.categories.queries": "{n} query",
  "settings.demo.purged": "{n} demo business deleted.",
  "setup.err.min": "Enter at least {n} character.",
  "campaign.inFlight":
    "The sending result of {n} sequence is not final. This message is not resent automatically.",
  "wizard.steps.followupN": "{n} follow-up",
  "wizard.delay.after": "after {n} day",
  "wizard.summary.capValue": "{n} email",
  "addToCampaign.remaining":
    "{n} more business matching the filter has not been added to this campaign. Add it to continue.",
  "addToCampaign.next": "Add the next {n} business",
  "addToCampaign.reevaluated": "{n} previously excluded business was checked again.",
  "queue.reevaluate.help":
    "{n} recipient was excluded. If the reason has been resolved (mailbox, sender profile, email verification…), check it again; if eligible, it is queued.",
  "queue.reevaluate.closed":
    "{n} recipient was excluded. The send list was fixed when the campaign started, so it cannot be re-checked here. If the reason is fixed, add it to a new campaign.",
  "preflight.previews": "Preview of the first {n} email",
  "preflight.check.recipients": "Emails will be sent to {n} recipient.",
  "preflight.check.excluded": "{n} recipient will be excluded; the reason is below.",
  "preflight.dialog.body":
    "Emails will be sent to {n} recipient between {from} and {to}, at most {cap} per day. Eligibility is checked again right before each send. You can stop it any time with Pause.",
  "tpl.locked": "Used in {n} campaign",
  "sup.summary.active": "{n} active block",
  "sup.lift.justification.hint": "At least {n} character. Written to the audit log.",
  "sup.lift.justification.error": "Please write a justification of at least {n} character.",
  "preflight.advisory.tr_identifiers_missing":
    "The campaign has {n} recipient in Turkey, but the company profile has no MERSIS or trade registry number. These fields are optional (owner decision); sending is not blocked.",
  "unsubInfra.arf.count": "{n} domain saved",
  "bell.unreadCount": "{n} unread notification",
  "schedules.missed": "{n} run was missed while the app was closed; it was combined into one scan.",
  "retention.gone": "{n} business can no longer be found on Google; your records were not deleted.",
  "retention.refresh.due": "{n} ID is due for a refresh (free).",
  "notif.summary.title": "{n} new notification",
  "notif.scanDone.title": "{n} new business found",
  "notif.scanPaused.body":
    "{n} scan was paused while the app restarted. You can resume it on the Scans page.",
  "notif.opened.title": "{n} business has opened!",
  "selection.count": "{n} business selected",
  "selection.hidden": "{n} of them is not in this list",
  "selection.allMatching": "The {n} business matching the filters is selected",
  "selection.view": "{n} business in the map area is selected",
  "selection.cap":
    "You can pick at most {n} business one by one. To select more, use “Select all matching”.",
  "bulk.archive.title": "Archive {n} business?",
  "bulk.unarchive.title": "Restore {n} business from the archive?",
  "bulk.dnc.title": "Mark {n} business as “Do not contact”?",
  "bulk.done.archive": "{n} business archived.",
  "bulk.done.unarchive": "{n} business restored from the archive.",
  "bulk.done.do_not_contact": "{n} business marked as “Do not contact”.",
  "bulk.done.skipped":
    "{n} business skipped (already in this state, campaign still running, or no longer exists).",
  "bulk.export.title": "Export the {n} selected business as CSV",
  "filters.detected.days": "Last {n} day",
  "addToCampaign.bodySelected":
    "The {n} selected business is added to the campaign. It is checked for eligibility; if it is not eligible, it is excluded with a reason.",
  "addToCampaign.partial":
    "Adding stopped partway: {n} business was not added ({error}). Try again; businesses already added are not added twice.",
  "campaign.progress.repliedBeforeSend": "{n} not emailed because it had already replied",
  "preflight.advisory.followup_missing_variables":
    "{n} previewed recipient has missing details in their follow-up email. Their follow-ups will stop when sending; complete the template or business details.",
  "preflight.advisory.followup_compose_error":
    "The follow-up email could not be prepared for {n} previewed recipient. Open the follow-up template and fix the problem, otherwise no follow-up is sent.",
  "wizard.capAboveMailbox":
    "The selected mailbox can send at most {n} email today (warm-up). This grows as the mailbox warms up; the lower limit always applies.",
  "wizard.capAboveMailboxMax":
    "The selected mailbox can send at most {n} email per day, so the campaign limit cannot be reached. You can see the mailbox limit under Settings → Mailboxes.",
  "dash.queue.waiting": "{n} person in the queue",
  "dash.queue.state.due":
    "{n} person is due; the email is sent while the sending window is open and the rules allow it.",
  "dash.new.more": "and {n} more business",
  "dash.scans.active": "{n} scan is running now.",
  "sup.import.preview.irreversible":
    "{n} record will be added or strengthened because of unsubscribe or complaint ({domains} of them block an entire domain). These records cannot be removed later.",
  "sup.import.confirm.body":
    "{n} record will be added or strengthened because of unsubscribe or complaint; {domains} of them block an entire domain. These blocks cannot be removed later by an ordinary action. If you are not sure, set the reason of these rows to “manual” in the file.",
};
