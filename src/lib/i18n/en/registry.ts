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
  "registry.settings.help":
    "The registry is the official list of newly incorporated companies. Records are matched with businesses on the Google map by name and postcode; unmatched ones stay in a separate list and can be added as leads.",
  "registry.matchBadge": "In the registry",
  "registry.matchBadge.detail": "Registry: {name} · incorporated {date}",
  "registry.matchBadge.demo": "Demo registry record",

  "registry.demoBanner":
    "Demo registry data: these records are not real. They are derived from businesses on the demo map and never mix with real data.",
  "registry.note":
    "The incorporation date is not the opening date. Records with no match on the map are not treated as new businesses, and nothing is sent to them without verified contact details.",
  "registry.source.companies_house": "United Kingdom · Companies House",
  "registry.source.insee": "France · INSEE Sirene",
  "registry.source.short.companies_house": "Companies House",
  "registry.source.short.insee": "INSEE",

  "registry.form.title": "New registry run",
  "registry.form.source": "Registry",
  "registry.form.locality": "Place (optional)",
  "registry.form.localityHint": "City name or postcode. Leave empty to search the whole country.",
  "registry.form.codes": "Activity codes",
  "registry.form.codesRequired": "Choose at least one activity code.",
  "registry.form.window": "Incorporated in the last … days",
  "registry.form.windowHint": "Between 1 and 365 days.",
  "registry.form.windowInvalid": "Enter a number of days between 1 and 365.",
  "registry.form.run": "Run",
  "registry.form.started": "The registry run has started. Records appear within a few seconds.",
  "registry.form.liveOff":
    "This registry is turned off for live use. Turn it on in Settings → Official registries and enter the key.",
  "registry.form.openSettings": "Open settings",

  "registry.runs.title": "Runs",
  "registry.runs.empty": "No registry runs yet",
  "registry.runs.emptyBody": "Choose a registry above and select Run.",
  "registry.runs.window": "Incorporated: {from} – {to}",
  "registry.runs.counts": "Fetched: {fetched} · new: {new}",
  "registry.runs.rate": "Match: {rate}",
  "registry.runs.matching": "Matching…",
  "registry.status.queued": "Queued",
  "registry.status.running": "Fetching",
  "registry.status.done": "Done",
  "registry.status.failed": "Failed",
  "registry.error.REGISTRY_AUTH": "The registry rejected the key. Enter the key again in Settings.",
  "registry.error.REGISTRY_RATE":
    "The registry rate limit was reached. Run it again a little later.",
  "registry.error.REGISTRY_UPSTREAM":
    "The registry could not be reached or the run was interrupted. Run it again.",
  "registry.error.REGISTRY_BAD_RESPONSE":
    "The registry sent an unexpected response. Try again; if it continues, change the codes.",
  "registry.error.REGISTRY_KEY_MISSING": "The registry key is missing. Add it in Settings.",
  "registry.error.REGISTRY_TOO_MANY":
    "More than 5,000 records were found. Use fewer days or enter a place.",

  "registry.rematch": "Match again",
  "registry.rematch.started": "Matching has started. The results update within a few seconds.",
  "registry.stats.rate": "Match rate",
  "registry.stats.summary": "Matched with a business on the map: {matched} of {total}.",
  "registry.tabs.matched": "Matched on the map",
  "registry.tabs.unmatched": "In the registry, not on the map",
  "registry.list.search": "Search registry names",
  "registry.list.empty.matched": "No matched records yet",
  "registry.list.empty.matchedBody":
    "First scan the same city on the map, then select Match again.",
  "registry.list.empty.unmatched": "No unmatched records",
  "registry.list.empty.unmatchedBody": "Every registry record matched a business on the map.",
  "registry.list.incorporated": "Incorporated: {date}",
  "registry.list.empty.none": "No registry records yet",
  "registry.list.empty.noneBody":
    "Start a registry search with the form above; the records found are listed here.",
  "registry.list.empty.noResults": "No results for this search",
  "registry.list.empty.noResultsBody": "Try another name or clear the search box.",
  "registry.stats.inSearch": "In this search: {n} records",
  "registry.list.score": "Similarity: {score}",
  "registry.list.openLead": "Open the business on the map",
  "registry.list.addLead": "Add as lead",
  "registry.list.leadCreated":
    "Lead created. It appears in Explore with the “Official registry” source.",
  "registry.list.openCreatedLead": "Open lead",
  "registry.list.more": "Show more",
  "registry.list.demoTag": "Demo",
  "registry.list.pending": "Waiting to match",
  "registry.reason.name_address": "Name and address match",
  "registry.reason.name_postcode": "Name and postcode match",
  "registry.reason.name_city": "Name and city match",
  "registry.reason.ambiguous": "Several similar businesses; check by hand.",
  "registry.reason.below_threshold": "No business on the map has a similar enough name.",
  "registry.reason.no_candidates": "Similar businesses here already match other records.",
  "registry.reason.no_cache":
    "No map data for this area. Scan this city first, then select Match again.",

  "registry.code.56102": "56102 · Cafés and unlicensed restaurants",
  "registry.code.56302": "56302 · Pubs and bars",
  "registry.code.56101": "56101 · Licensed restaurants",
  "registry.code.56103": "56103 · Take-away food",
  "registry.code.56301": "56301 · Licensed clubs and bars",
  "registry.code.55100": "55100 · Hotels",
  "registry.code.56.30Z": "56.30Z · Beverage serving (cafés, bars)",
  "registry.code.56.10A": "56.10A · Traditional restaurants",
  "registry.code.56.10C": "56.10C · Fast food",
  "registry.code.55.10Z": "55.10Z · Hotels",

  "registry.settings.demo":
    "You are in demo mode: registries run without keys on demo data. For real registries, switch the Google connection to live and enter the key.",
  "registry.settings.ch.enable": "Companies House (United Kingdom)",
  "registry.settings.ch.hint":
    "Get a free API key from the Companies House developer site. Only active companies are fetched.",
  "registry.settings.insee.enable": "INSEE Sirene (France)",
  "registry.settings.insee.hint":
    "Get an API key from the INSEE API portal. Sole traders and records that may not be published are skipped.",
  "registry.settings.codes": "Default activity codes",
  "registry.settings.window": "Default window (days)",
  "registry.settings.scheme": "Code table",
  "registry.settings.scheme.NAFRev2": "NAF rev. 2",
  "registry.settings.scheme.NAF2025": "NAF 2025 (not published yet)",
  "registry.settings.naf2025Note":
    "INSEE moves to NAF rev. 2025 on 1 January 2027. You can choose the new code table here once it is published; until then NAF rev. 2 is used.",
  "registry.settings.chKey": "Companies House API key",
  "registry.settings.inseeKey": "INSEE API key",
  "registry.settings.keyHelp":
    "The key is stored encrypted on this computer and is sent only to that registry.",
  "registry.settings.test": "Test connection",
  "registry.settings.test.ok": "The connection works.",
  "registry.settings.test.okDemo": "Demo mode: no connection needed.",
  "registry.settings.limit":
    "Known limit: the registered office in Companies House is often not where the business trades, so the real match rate may be low.",
  "registry.settings.openPage": "Go to registry records",

  "registry.filter.source": "Source",
  "registry.filter.help":
    "Choose where the lead came from and whether it has a matching record in the official registry.",
  "registry.filter.source.google": "Google map",
  "registry.filter.source.demo": "Demo map",
  "registry.filter.source.registry": "Official registry",
  "registry.filter.source.import": "Import",
  "registry.filter.match": "Registry match",
  "registry.filter.match.any": "Any",
  "registry.filter.match.yes": "Has a registry match",
  "registry.filter.match.no": "No registry match",

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
