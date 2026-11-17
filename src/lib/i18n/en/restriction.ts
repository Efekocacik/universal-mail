/**
 * Test recipient limit ("test mode") texts: the Settings card, the test-mode banner, the campaign resume confirmation
 * and error codes. Turkish counterpart: `tr/restriction.ts`.
 */
export const restriction = {
  "restriction.title": "Test mode (allowed recipients)",
  "restriction.desc":
    "When you try things with a real (Gmail) mailbox, campaign emails are sent only to the exact email addresses you list here. While it is off there is no limit.",
  "restriction.status.on": "Test mode is ON: campaign emails go only to {n} allowed addresses.",
  "restriction.status.off": "Test mode is off: no recipient limit.",
  "restriction.toggle": "Turn on test mode",
  "restriction.addresses.label": "Allowed addresses (one full email address per line)",
  "restriction.addresses.hint":
    "No domains or wildcards (*). Only list addresses that are yours or that you have explicitly been allowed to use for tests. The existing eligibility rules still apply to these addresses: personal mail providers (e.g. gmail.com) and personal-name addresses are already not eligible for campaigns; use generic business addresses such as info@ or sales@.",
  "restriction.note.consumer": "{address}: a personal mail provider; not eligible for campaigns.",
  "restriction.note.personal":
    "{address}: not a generic business address (e.g. info@, sales@); not eligible for campaigns.",
  "restriction.save": "Save",
  "restriction.saved": "Test mode setting saved.",
  "restriction.paused":
    "{n} running live campaigns were paused for safety; they can only be restarted with an explicit confirmation.",
  "restriction.running": "There are {n} running live campaigns right now.",
  "restriction.corrupt":
    "The test mode setting could not be read; live sending is blocked for safety. Save the list again.",
  "restriction.loosen.title": "You are about to loosen the limit",
  "restriction.loosen.body":
    "This change allows sending to more addresses. {n} running live campaigns will be paused for safety; you can restart them only with an explicit confirmation. Deferred recipients will not start receiving emails by themselves.",
  "restriction.loosen.confirm": "Loosen and pause campaigns",
  "restriction.banner":
    "Test mode is on: campaign emails go only to {n} allowed addresses. Turn it off in Settings for normal sending.",
  "restriction.banner.link": "Settings",
  "restriction.resume.title": "There are waiting recipients",
  "restriction.resume.body":
    "{waiting} recipients in this campaign are queued, and some of them may be held because of the test recipient limit. If you continue and the limit was lifted or the list widened, these recipients will start receiving emails.",
  "restriction.resume.stillOn":
    "Test mode is still on: emails go only to {allowed} allowed addresses.",
  "restriction.resume.off": "Test mode is off: all waiting recipients can be sent to.",
  "restriction.resume.confirm": "I confirm, resume",
  "preflight.held":
    "{n} recipients will be held because of test mode; they are not excluded and continue only after the limit is lifted, with an explicit confirmation.",
  "campaign.pause.restriction":
    "The campaign was paused because the test recipient limit changed. Review the waiting recipients and resume with an explicit confirmation.",
  "reason.recipient_not_allowed": "Test mode: address not on the allowed list (held)",
  "apiError.LIST_REQUIRED": "Enter at least one allowed address to turn on test mode.",
  "apiError.TOO_MANY_ADDRESSES": "Too many addresses; you can enter at most 50.",
  "apiError.INVALID_ADDRESS":
    "Only valid full email addresses can be entered (no domains, wildcards or display names).",
  "apiError.LOOSENING_ACK_REQUIRED":
    "Loosening the limit needs confirmation; running live campaigns are paused.",
  "apiError.RESTRICTION_ACK_REQUIRED":
    "Recipients are waiting because of the test recipient limit; resuming the campaign needs an explicit confirmation.",
} as const;
