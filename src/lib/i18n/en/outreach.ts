import type { outreach as TrOutreach } from "../tr/outreach";
import type { EnFragment } from "../types";

/** Paket E (gönderim/kampanya) anahtarlarının İngilizcesi. */
export const outreach = {
  // F: complaint/stop_reason — stage 15.10-2 (TB-2, TB-10, TB-11d) and campaign counts ("bug a").
  "campaign.progress.repliedBeforeSend": "{n} not emailed because they had already replied",
  "campaign.progress.stoppedBeforeSend": "{n} stopped before receiving any email",
  "campaign.progress.ofWhich": "Of these: {list}",
  "campaign.progress.optedOut": "{n} unsubscribed",
  "campaign.progress.complained": "{n} stopped because of a spam complaint",
  "sequenceStop.unsubscribe": "Unsubscribed",
  "sequenceStop.complaint": "Stopped: spam complaint",
  "sequenceStop.completedThenUnsubscribe": "Completed, then unsubscribed",
  "sequenceStop.completedThenComplaint": "Completed, then complained",
  "sequenceStop.filterStopped": "Stopped (unsubscribed or complaint)",
  "reason.business_complaint": "Another address at this business complained",
  "reason.business_complaint.hint":
    "Another email address at this business filed a spam complaint, so sending to this address was stopped. This address is not blocked.",
  // F: end of block
} as const satisfies EnFragment<typeof TrOutreach>;
