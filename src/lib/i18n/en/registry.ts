import type { registry as TrRegistry } from "../tr/registry";
import type { EnFragment } from "../types";

/** Package R (Faz 5): registry page, settings card, run states, match reasons, errors. */
export const registry = {
  "registry.title": "Registry records",
  "registry.subtitle":
    "Find newly incorporated businesses in the official company registry and match them with businesses on the map.",
  "registry.settings.title": "Official registries",
  "registry.settings.desc":
    "Newly incorporated businesses from the UK (Companies House) and France (INSEE Sirene) registries.",
  "registry.matchBadge": "In the registry",
  "apiError.REGISTRY_DISABLED":
    "This registry source is turned off. Turn it on in Settings → Registries.",
  "apiError.REGISTRY_KEY_MISSING":
    "The registry API key is missing. Add it in Settings → Registries, or use demo mode.",
  "apiError.REGISTRY_RUN_ACTIVE":
    "A registry run is already in progress for this source. Wait for it to finish.",
  "apiError.REGISTRY_MATCH_ACTIVE":
    "Matching is already running. The results update on their own when it finishes.",
  "apiError.REGISTRY_ALREADY_LEAD": "A lead has already been created from this registry record.",
  "apiError.REGISTRY_MATCHED":
    "This record matches a business on the map. Use that business instead of creating a new lead.",
  "apiError.REGISTRY_AUTH": "The registry rejected the API key. Check the key and enter it again.",
  "apiError.REGISTRY_RATE":
    "The registry service received too many requests. Try again in a minute.",
  "apiError.REGISTRY_UPSTREAM":
    "The registry service cannot be reached right now. Try again shortly.",
  "apiError.REGISTRY_SCHEME_UNAVAILABLE":
    "The NAF 2025 code table is not published yet. Use NAF rev. 2 for now.",
} as const satisfies EnFragment<typeof TrRegistry>;
