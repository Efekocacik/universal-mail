import type { variants as TrVariants } from "../tr/variants";
import type { EnFragment } from "../types";

/** Package T (Faz 5): info-only badge, A/B subject, category variants, campaign stats, open tracking. */
export const variants = {
  "tracking.settings.title": "Open tracking",
  "tracking.settings.desc":
    "Shows roughly whether messages in demo campaigns were opened. Off by default.",
  "apiError.TEMPLATE_INFO_ONLY":
    "This template is for information only and cannot be used for sending. Choose another template.",
  "apiError.TEMPLATE_NO_VARIANT_B":
    "This template has no subject B. Add a subject B to the template first.",
  "apiError.CATEGORY_TEMPLATE_MISMATCH":
    "The category template's language or type does not match the step. Choose a template with the same language and type.",
} as const satisfies EnFragment<typeof TrVariants>;
