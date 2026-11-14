import type { ai as TrAi } from "../tr/ai";
import type { EnFragment } from "../types";

/** Package A (Faz 5): AI card, cost note, intro panel, external email card and AI/external errors. */
export const ai = {
  "ai.settings.title": "Personal intro with AI",
  "ai.settings.desc":
    "Claude drafts a short opening sentence for each business. No sentence is used without your approval.",
  "ai.intro.title": "Personal intro",
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
