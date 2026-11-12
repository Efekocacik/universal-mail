import type { outreach as TrOutreach } from "../tr/outreach";
import type { EnFragment } from "../types";

/** Paket E (gönderim/kampanya) anahtarlarının İngilizcesi. */
export const outreach = {
  "mbx.empty": "No mailboxes yet. Add your Gmail address below.",
  "mbx.limits.edit": "Daily limit",
  "mbx.limits.title": "{label}: daily sending limit",
  "mbx.limits.desc":
    "Set the most emails this mailbox may send per day and how much a new mailbox grows each week.",
  "mbx.limits.dailyCap": "Maximum emails per day",
  "mbx.limits.dailyCap.hint": "A number between 1 and {max}.",
  "mbx.limits.dailyCap.hintConsumer":
    "For personal Gmail, a number between 1 and {max}. Google applies lower limits to personal accounts.",
  "mbx.limits.warmupStep": "Weekly increase (warm-up)",
  "mbx.limits.warmupStep.hint":
    "A new mailbox starts at {base} emails per day in its first week and grows by this much every week (0 to {max}). Enter 0 for no increase.",
  "mbx.limits.preview":
    "Today at most {today} · in a week {week} · reaches {target} emails per day in about {weeks} weeks.",
  "mbx.limits.preview.reached": "At most {today} emails today; the mailbox has reached its limit.",
  "mbx.limits.preview.flat":
    "At most {today} emails today. With a weekly increase of 0 this number stays the same.",
  "mbx.limits.consumerWarning":
    "On personal Gmail, sending more than {risk} per day raises the risk of Google restricting the account. The maximum is {max}.",
  "mbx.limits.rules":
    "Limits are checked again before every email: at least 90 seconds pass between two emails and this mailbox never sends more than {max} per day. Days reset on UTC (03:00 Turkey time).",
  "mbx.limits.rampContinues":
    "This mailbox can send at most {today} emails today. It does not jump straight to the new limit: the increase starts from here and is added every week, so the warm-up is kept.",
  "mbx.limits.save": "Save",
  "mbx.limits.saved": "Daily limit saved.",
  "mbx.limits.conflict":
    "This mailbox was changed elsewhere. The current values are loaded; check them and save again.",
  "mbx.limits.error.integer": "Enter a whole number.",
  "mbx.limits.error.min": "Must be at least {min}.",
  "mbx.limits.error.aboveMax": "At most {max} for this mailbox.",
  "wizard.capAboveMailbox":
    "The selected mailbox can send at most {n} emails today (warm-up). This grows as the mailbox warms up; the lower limit always applies.",
  "wizard.capAboveMailboxMax":
    "The selected mailbox can send at most {n} emails per day, so the campaign limit cannot be reached. You can see the mailbox limit under Settings → Mailboxes.",
  "wizard.draft.offer":
    "Unsaved changes were found for this campaign ({at}). Do you want to restore them?",
  "wizard.draft.restore": "Restore",
  "wizard.draft.discard": "Discard draft",
  "wizard.draft.restored": "Unsaved changes restored. Press “Save” to keep them.",
  "wizard.steps.noFollowupV2":
    "There are no follow-up templates yet, so the campaign sends a single email. You can add a follow-up template on the Templates page.",
  "queue.reevaluate.closed":
    "{n} recipients were excluded. The send list was fixed when the campaign started, so they cannot be re-checked here. If the reason is fixed, add them to a new campaign.",
  "reason.inbound_review_pending":
    "A reply from this contact is waiting for review; no follow-up is sent until you decide",
  "queue.reviewHold.go": "Go to review",
  "tplEditor.reuseSubject": "Use the first email’s subject (Re: …)",
  "tplEditor.reuseSubject.hint":
    "Recommended. The follow-up appears in the same conversation as the first email; the recipient sees it as “Re: <first subject>”.",
  "tplEditor.subject.reuseHint":
    "In this follow-up the recipient sees the first email’s subject. This subject is only used if the first one is not available.",
  "preflight.step.group": "Step to preview",
  "preflight.step.initial": "First email",
  "preflight.step.followup": "Step {n} · +{days} days",
  "preflight.step.errors":
    "This step cannot be sent to this recipient: {reasons}. Fix the template.",
  "preflight.check.followups":
    "Including follow-ups, at most {total} emails. The last follow-up goes at least {after} days after the first email; everything takes about {days} days (no follow-ups go to people who reply).",
  "preflight.advisory.followup_missing_variables":
    "{n} previewed recipients have missing details in their follow-up email. Their follow-ups will stop when sending; complete the template or business details.",
  "preflight.advisory.followup_compose_error":
    "The follow-up email could not be prepared for {n} previewed recipients. Open the follow-up template and fix the problem, otherwise no follow-up is sent.",
} as const satisfies EnFragment<typeof TrOutreach>;
