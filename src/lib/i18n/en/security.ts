import type { security as TrSecurity } from "../tr/security";
import type { EnFragment } from "../types";

/** Package G (Faz 6): security and privacy UI/log copy (may stay small). */
export const security = {
  "security.title": "Security and privacy",
} as const satisfies EnFragment<typeof TrSecurity>;
