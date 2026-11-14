import type { sources as TrSources } from "../tr/sources";
import type { EnFragment } from "../types";

/** P0 (Faz 5): scans sub-navigation, settings section names, shared Faz 5 labels and secret field labels. */
export const sources = {
  "scans.subnav.label": "Lead sources",
  "scans.subnav.scans": "Map scans",
  "scans.subnav.registry": "Registry",
  "scans.subnav.import": "Import",
  "settings.nav.registry": "Registries",
  "settings.nav.ai": "AI",
  "settings.nav.tracking": "Open tracking",
  "faz5.demoBadge": "Demo data",
  "faz5.preparing.title": "This section is being prepared",
  "faz5.preparing.body":
    "This feature is switched on as part of Phase 5. Nothing else is needed for now.",
  "detail.source.import": "Imported",
  "detail.source.registry": "Registry record",
  "detail.placeless":
    "This lead came from a list or the official registry and has no Google record. The details are your own data.",
  "secret.registry.companiesHouseKey": "Companies House API key",
  "secret.registry.inseeKey": "INSEE Sirene API key",
  "secret.anthropic.apiKey": "Claude (Anthropic) API key",
  "secret.snov.clientId": "Snov.io client ID",
  "secret.snov.clientSecret": "Snov.io client secret",
} as const satisfies EnFragment<typeof TrSources>;
