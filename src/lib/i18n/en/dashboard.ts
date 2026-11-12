import type { dashboard as TrDashboard } from "../tr/dashboard";
import type { EnFragment } from "../types";

/** Gösterge paneli (Paket E) anahtarlarının İngilizcesi. */
export const dashboard = {
  "nav.dashboard": "Dashboard",
  "dash.title": "Dashboard",
  "dash.desc": "New businesses, today's sending and monthly spend at a glance.",
  "dash.cta.explore": "Go to Explore",
  "dash.updated": "Last updated: {time}. The page refreshes every minute.",
  "dash.refresh": "Refresh",
  "dash.loadError": "The dashboard could not be loaded.",
  "dash.loadError.next":
    "Try again in a few seconds; if it keeps happening, close and reopen the app.",
  "dash.sectionError":
    "This section could not be loaded right now. The page will try again within a minute.",
  "dash.stats.label": "Summary figures",
  "dash.stat.businesses": "Businesses",
  "dash.stat.businesses.help": "All businesses saved in Explore. Archived ones are not counted.",
  "dash.stat.withEmail": "With an email",
  "dash.stat.withEmail.help": "Businesses whose own website lists a contact email.",
  "dash.stat.newThisWeek": "New this week",
  "dash.stat.newThisWeek.help":
    "Businesses seen for the first time in scans since Monday. Click to list them in Explore.",
  "dash.stat.openedThisWeek": "Opened this week",
  "dash.stat.openedThisWeek.help":
    'Businesses that were shown as "opening soon" and were seen open this week.',
  "dash.stat.activeCampaigns": "Active campaigns",
  "dash.stat.activeCampaigns.paused": "{n} paused",
  "dash.stat.sentToday": "Sent today",
  "dash.stat.sentToday.help":
    "Campaign emails sent today (your time, since midnight). Mailbox daily limits count by UTC day and reset at 03:00 Turkey time; if the two numbers differ, the limit count is shown below.",
  "dash.stat.sentToday.limitDay": "{n} on the daily limit counter (as of {time})",
  "dash.stat.sentMonth": "Sent this month",
  "dash.stat.replies": "Replies (this month)",
  "dash.stat.replies.pending": "{n} waiting for review",
  "dash.stat.replies.negative": "{n} not interested",
  "dash.stat.replies.help":
    "Real replies from businesses this month, including “not interested” answers. Auto-replies, bounced emails and unsubscribe requests are not counted.",
  "dash.queue.title": "Today's sending queue",
  "dash.queue.help":
    "Each mailbox's limit for today and its next send. There are at least 90 seconds between sends; limits count by UTC day.",
  "dash.queue.used": "{used} / {cap} sent",
  "dash.queue.waiting": "{n} people in the queue",
  "dash.queue.state.due":
    "{n} people are due; they are sent one by one while the sending window is open and the rules allow it.",
  "dash.queue.state.next": "Next send {when}.",
  "dash.queue.state.capReached": "Today's limit is reached; sending continues after {time}.",
  "dash.queue.state.capReachedNoTime": "Today's limit is reached; sending continues tomorrow.",
  "dash.queue.state.backoff": "Google has paused this mailbox for a while; it will retry {when}.",
  "dash.queue.state.reauth":
    "The Gmail connection needs renewing. Reconnect it under Settings → Mailboxes.",
  "dash.queue.state.idle": "No one is waiting to be sent from this mailbox in a running campaign.",
  "dash.queue.empty": "No mailbox is connected. Connect a mailbox before sending a campaign.",
  "dash.queue.empty.cta": "Go to mailboxes",
  "dash.queue.editLimit": "Change the daily limit",
  "dash.budget.title": "Google spend (this month)",
  "dash.budget.help":
    "Estimated cost of this month's Google Maps searches. When the budget is used up, new searches stop until the month ends; email sending is not affected.",
  "dash.budget.spent": "{spent} / {limit}",
  "dash.budget.left": "Left: {left}",
  "dash.budget.projection": "At this pace the month will end at about {usd}.",
  "dash.budget.projectionOver":
    "At this pace the budget may run out before the month ends (estimate {usd}).",
  "dash.budget.warning": "Most of the budget has been used.",
  "dash.budget.blocked":
    "The budget is used up: new Google searches are stopped until the month ends.",
  "dash.budget.mock": "Demo data is in use; there is no Google charge.",
  "dash.budget.edit": "Change the budget",
  "dash.new.title": "Newly opened this week",
  "dash.new.desc": "Businesses seen opening or found for the first time since Monday.",
  "dash.new.kind.opened": "Opened",
  "dash.new.kind.new": "New",
  "dash.new.unnamed": "Name not loaded yet",
  "dash.new.more": "and {n} more businesses",
  "dash.new.seeOpened": "See opened ones in Explore",
  "dash.new.seeNew": "See new ones in Explore",
  "dash.new.empty":
    "No new businesses this week yet. They will appear here as scans run regularly.",
  "dash.scans.title": "Upcoming scans",
  "dash.scans.help":
    "Scheduled scans start by themselves while the app is open. If the budget or settings do not allow it, the run is skipped and you get a notification.",
  "dash.scans.active": "{n} scans are running now.",
  "dash.scans.every": "every {days} days",
  "dash.scans.overdue": "Due now; it starts while the app is open.",
  "dash.scans.skipped": "The last run was skipped; see the Scans page for details.",
  "dash.scans.empty": "No scheduled scans. Use the Scans page to scan an area regularly.",
  "dash.scans.cta": "Go to Scans",
  "dash.notif.title": "Recent notifications",
  "dash.notif.unread": "{n} unread",
  "dash.notif.empty":
    "No notifications yet. They appear here when a scan finishes or new businesses are found.",
  "dash.notif.open": "Open",
  "dash.notif.unreadItem": "Unread",
  "dash.notif.openLabel": "Open notification: {title}",
} as const satisfies EnFragment<typeof TrDashboard>;
