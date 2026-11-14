import type { ai as TrAi } from "../tr/ai";
import type { EnFragment } from "../types";

/** Package A (Faz 5): AI card, cost note, intro panel, external email card and AI/external errors. */
export const ai = {
  "ai.settings.title": "Personal intro with AI",
  "ai.settings.desc":
    "Claude drafts a short opening sentence for each business. No sentence is used without your approval.",
  "ai.intro.title": "Personal intro",
  "ai.settings.enable": "Draft personal intros",
  "ai.settings.enable.hint":
    'When on, a "Generate" button appears in the lead details. Drafts are never used in an email until you approve them.',
  "ai.settings.model": "Model",
  "ai.settings.model.opus": "Claude Opus 5.5 (recommended)",
  "ai.settings.model.haiku": "Claude Haiku 5.5 (much cheaper)",
  "ai.settings.model.hint": "Changing the model only affects intros generated from now on.",
  "ai.settings.costNote":
    "Each intro sends one request to the Claude API: about {cost} per intro with the selected model. You pay through your Anthropic account; it does not count towards the Google budget cap.",
  "ai.settings.privacy":
    "Claude receives only the display name, city, category and visible text from the business's own homepage. Google data, email addresses, phone numbers and notes are never sent.",
  "ai.settings.demoNote":
    "Demo mode: intros come from sample templates; no request goes to Claude, and no key or cost is involved.",
  "ai.settings.confirm.title": "Turn on AI intros?",
  "ai.settings.confirm.ok": "I understand the cost, turn on",
  "ai.settings.ackedAt": "You confirmed the cost note on {date}.",
  "ai.settings.key.help":
    "Get it from console.anthropic.com → API Keys. The key is stored encrypted on this computer.",
  "ai.settings.test": "Test key",
  "ai.settings.test.ok": "The key works; {model} is available.",
  "ai.settings.test.demo": "Demo mode: the key was not tested and nothing was sent.",
  "ai.settings.usage.title": "Usage this month ({month})",
  "ai.settings.usage.requests": "Requests",
  "ai.settings.usage.tokens": "Tokens (input / output)",
  "ai.settings.usage.cost": "Estimated cost",
  "ai.intro.help":
    "The value of the kisisel_giris template variable. Emails only use text you approved; without approved text the fallback is used or the email is not sent.",
  "ai.intro.language": "Intro language",
  "ai.intro.generate": "Generate",
  "ai.intro.regenerate": "Generate again",
  "ai.intro.disabled": "AI intros are turned off.",
  "ai.intro.enableLink": "Turn on in Settings",
  "ai.intro.empty": 'No intro for this language yet. Use "Generate" to prepare a draft.',
  "ai.intro.status.draft": "Awaiting approval",
  "ai.intro.status.approved": "Approved",
  "ai.intro.status.rejected": "Rejected",
  "ai.intro.textLabel": "Intro text",
  "ai.intro.textHint":
    "1–2 sentences, up to 300 characters; no links, emails, phone numbers, years or percentages.",
  "ai.intro.chars": "{n}/300 characters",
  "ai.intro.save": "Save change",
  "ai.intro.approve": "Approve",
  "ai.intro.reject": "Reject",
  "ai.intro.never": "Nothing is ever sent without your approval.",
  "ai.intro.meta": "{model} · estimated {cost}",
  "ai.intro.meta.demo": "Demo text · free",
  "ai.intro.toast.generated": "Draft ready. Read it, edit if needed, then approve.",
  "ai.intro.toast.approved": "Intro approved; emails in this language will use it.",
  "ai.intro.toast.rejected": "Intro rejected.",
  "ai.intro.toast.saved": "Change saved. Approve it again to use it.",
  "ai.external.title": "Find emails with an external service (Hunter or Snov)",
  "ai.external.help":
    "Off by default. When on, only the domain of businesses whose website has no address is sent to the service you choose; each search uses that service's quota. Found addresses go through the same verification and block list (at most 5 addresses per domain). You also have to select it in the search dialog.",
  "ai.external.provider": "Service",
  "ai.external.provider.hunter": "Hunter.io",
  "ai.external.provider.snov": "Snov.io",
  "ai.external.snovId.help": "The User ID (client ID) under snov.io → Account settings → API.",
  "ai.external.snovSecret.help":
    "The API Secret (client secret) in the same section. Stored encrypted on this computer.",
  "ai.external.demoNote":
    "Demo mode: no request goes to the service; sample addresses are returned only for .example domains.",
  "ai.external.resetDate": "Quota renews on: {date}",
  "ai.external.demoQuota": "Demo mode: sample quota {n} (nothing was sent).",
  "apiError.AI_DISABLED": "AI intros are turned off. Turn them on in Settings → AI.",
  "apiError.AI_KEY_MISSING": "The Claude API key is missing. Add it in Settings → AI.",
  "apiError.AI_COST_ACK_REQUIRED": "Confirm the cost note first (Settings → AI).",
  "apiError.AI_NO_CONTEXT":
    "There is not enough information about this business. Add a name, city or category first.",
  "apiError.AI_AUTH": "Claude rejected the API key. Check the key and enter it again.",
  "apiError.AI_RATE_LIMITED":
    "Claude is receiving too many requests right now. Try again in a minute.",
  "apiError.AI_UPSTREAM": "Claude cannot be reached right now. Try again shortly.",
  "apiError.AI_REFUSED":
    "Claude did not write an intro for this business. You can write the text yourself.",
  "apiError.AI_TRUNCATED": "Claude's answer was cut off. Try again.",
  "apiError.AI_OUTPUT_INVALID":
    "The generated text did not follow the rules (1–2 sentences, no links or numbers). Try again or write it yourself.",
  "apiError.INTRO_TEXT_INVALID":
    "The intro must be 1–2 sentences, without links, emails, phone numbers, digits or {{ }}.",
  "apiError.EXTERNAL_KEY_MISSING":
    "The external email service key is missing. Add it in Settings → Email finding.",
  "apiError.EXTERNAL_AUTH":
    "The external email service rejected the key. Check the key and enter it again.",
  "apiError.EXTERNAL_QUOTA":
    "The external email service's monthly quota is used up. Try again when it renews.",
  "apiError.EXTERNAL_RATE":
    "The external email service received too many requests. Try again in a minute.",
  "apiError.EXTERNAL_NETWORK":
    "The external email service cannot be reached. Check your internet connection and try again.",
} as const satisfies EnFragment<typeof TrAi>;
