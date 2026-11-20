/**
 * Live country activation texts: the Settings card, the Electron local confirmation window, the resume confirmation and
 * error codes. Turkish counterpart: `tr/countryActivation.ts`.
 */
export const countryActivation = {
  "nativeConfirm.cancel": "Cancel",
  "nativeConfirm.checkbox": "I have read the information above and started this action myself.",
  "nativeConfirm.mode.generic_only": "generic business addresses only (generic_only)",
  "nativeConfirm.mode.allowed": "all eligible business addresses (allowed)",
  "nativeConfirm.country.title": "Confirm live country activation",
  "nativeConfirm.country.message": "The country lock for live sending will be opened.",
  "nativeConfirm.country.line.countries": "Countries: {countries}",
  "nativeConfirm.country.line.mode": "Mode: {mode}",
  "nativeConfirm.country.line.rep": "Authorised representative (declared): {name}, {title}",
  "nativeConfirm.country.line.doc": "Approval document (declared): {ref}, dated {date}",
  "nativeConfirm.country.line.sha": "Document digest (first 16): {sha}",
  "nativeConfirm.country.line.operator": "Performed by: {name}",
  "nativeConfirm.country.line.testMode": "Test mode is ON: sending only to {n} allowed addresses",
  "nativeConfirm.country.line.running": "Live campaigns running now: {n}",
  "nativeConfirm.country.disclaimer":
    "This record does not mean legal authority has been verified; the app cannot verify the document or the person's authority. It only records who opened the country and on which document.",
  "nativeConfirm.country.confirm": "Confirm and open the country",

  "countryActivation.title": "Live country activation",
  "countryActivation.desc":
    "A country's lock for real sending can only be opened here, with a legal authorisation record and the local confirmation window on this computer. All countries are locked by default.",
  "countryActivation.disclaimer":
    "The record entered here does not mean legal authority has been verified. The app cannot verify the document's validity or the person's authority; it only writes who opened the country, on which document, to the audit log. Legal approval must be obtained outside the app.",
  "countryActivation.noChannel":
    "Local confirmation only works in the installed desktop app. Activation is not possible in this environment.",
  "countryActivation.checks.title": "Activation prerequisites",
  "countryActivation.check.live_flag": "Live sending gate (software)",
  "countryActivation.check.consent": "Usage consent given",
  "countryActivation.check.company_profile": "Company profile complete",
  "countryActivation.check.real_mailbox": "Connected real (Gmail) mailbox",
  "countryActivation.check.dns_auth": "DNS/sender verification",
  "countryActivation.check.https_unsubscribe": "Verified HTTPS unsubscribe endpoint",
  "countryActivation.check.event_delivery": "Unsubscribe request pulling is healthy",
  "countryActivation.check.legal_live_countries": "Live country policy legal flag (software)",
  "countryActivation.check.test_mode": "Test mode on and allowed address list filled in",
  "countryActivation.check.self_test":
    "Successful “send test to myself” on every real mailbox, after its last connection and within 30 days",
  "countryActivation.check.ok": "Done",
  "countryActivation.check.missing": "Missing",
  "countryActivation.active.title": "Open countries",
  "countryActivation.active.none": "No country is open: real campaign emails cannot be sent.",
  "countryActivation.active.row": "{code}: {mode}; approved by: {by}; reference: {ref}",
  "countryActivation.revoke": "Revoke (lock)",
  "countryActivation.revoke.title": "Lock the country again",
  "countryActivation.revoke.body":
    "{code} will be blocked and locked again. Running live campaigns are paused; resuming needs an explicit confirmation and that country's recipients are permanently excluded when resuming.",
  "countryActivation.revoke.confirm": "Lock and pause campaigns",
  "countryActivation.revoked": "The country was locked again.",
  "countryActivation.revoked.paused": "{n} running live campaigns were paused.",
  "countryActivation.form.title": "Open a new country",
  "countryActivation.form.countries": "Countries to open",
  "countryActivation.form.mode": "Mode",
  "countryActivation.form.mode.generic_only": "Generic business addresses only (recommended)",
  "countryActivation.form.mode.allowed": "All eligible business addresses",
  "countryActivation.form.rep": "Authorised representative's full name",
  "countryActivation.form.repTitle": "Authorised representative's title",
  "countryActivation.form.operator": "Person performing this (user of this computer)",
  "countryActivation.form.docRef": "Approval document reference",
  "countryActivation.form.docDate": "Approval document date (YYYY-MM-DD)",
  "countryActivation.form.docSha": "Document SHA-256 digest (optional)",
  "countryActivation.form.attest":
    "The countries and mode in the approval document are the same as those selected here.",
  "countryActivation.form.check": "Check",
  "countryActivation.form.activate": "Activate (a local confirmation window opens)",
  "countryActivation.form.waiting":
    "The local confirmation window is open: confirm or cancel it in this app's window (up to 2 minutes).",
  "countryActivation.form.activated": "Countries opened.",
  "countryActivation.plan.ready": "Prerequisites and country state are fine; it can be activated.",
  "countryActivation.plan.notReady": "Activation is not possible: complete the missing conditions.",
  "countryActivation.warn.operator_differs_from_consent":
    "Warning: the person performing this differs from the person who gave the setup consent. This will be recorded.",
  "countryActivation.resume.revoked":
    "This campaign was paused because a country was locked again. If you resume it, that country's recipients are permanently excluded.",
  "campaign.pause.country_revoked":
    "The campaign was paused because a live country was locked again. Resuming needs an explicit confirmation.",
  "apiError.ACTIVATION_INVALID": "Invalid country, mode or confirmation.",
  "apiError.ACTIVATION_LEGAL":
    "The legal authorisation record is missing or invalid (representative, document reference, date and scope statement are required).",
  "apiError.ACTIVATION_PREREQUISITES": "The sending prerequisites are not complete.",
  "apiError.ACTIVATION_TEST_MODE":
    "For the first activation test mode must be on and the allowed address list filled in.",
  "apiError.ACTIVATION_REFUSED": "The country cannot be opened or revoked.",
  "apiError.CONFIRM_UNAVAILABLE":
    "Local confirmation is only available in the installed desktop app.",
  "apiError.CONFIRM_DECLINED": "Local confirmation was not given.",
  "apiError.CONFIRM_TIMEOUT": "Local confirmation timed out.",
} as const;
