import { json, route } from "@/lib/api/http";
import { countryOptions, DEFAULT_EXCLUDED_COUNTRIES } from "@/lib/geo/countries";

export const dynamic = "force-dynamic";

export const GET = route(async () =>
  json({ countries: countryOptions("tr"), defaultExcluded: DEFAULT_EXCLUDED_COUNTRIES }),
);
