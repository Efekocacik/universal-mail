import type { PlaceRecord } from "@/lib/domain/types";

interface RawAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
  businessStatus?: string;
  openingDate?: { year?: number; month?: number; day?: number };
  addressComponents?: RawAddressComponent[];
  googleMapsUri?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  userRatingCount?: number;
}

const CITY_COMPONENT_ORDER = [
  "locality",
  "postal_town",
  "administrative_area_level_3",
  "sublocality_level_1",
  "administrative_area_level_2",
];

/** Google `Date` nesnesini ("YYYY", "YYYY-MM" veya "YYYY-MM-DD") metne çevirir; 0 değerleri bilinmeyen sayılır. */
export function formatOpeningDate(d: RawPlace["openingDate"]): string | undefined {
  if (!d?.year) return undefined;
  const y = String(d.year).padStart(4, "0");
  if (!d.month) return y;
  const m = String(d.month).padStart(2, "0");
  if (!d.day) return `${y}-${m}`;
  return `${y}-${m}-${String(d.day).padStart(2, "0")}`;
}

export function extractAddress(components: RawAddressComponent[] | undefined): {
  countryCode?: string;
  city?: string;
} {
  if (!components?.length) return {};
  const country = components.find((c) => c.types?.includes("country"))?.shortText;
  let city: string | undefined;
  for (const type of CITY_COMPONENT_ORDER) {
    const hit = components.find((c) => c.types?.includes(type));
    if (hit?.longText) {
      city = hit.longText;
      break;
    }
  }
  return { countryCode: country?.toUpperCase(), city };
}

/** Google yanıtındaki tek bir yeri normalleştirir. Kimliği veya konumu olmayan kayıt `null` döner. */
export function normalizeGooglePlace(raw: unknown): PlaceRecord | null {
  const p = raw as RawPlace;
  const lat = p?.location?.latitude;
  const lng = p?.location?.longitude;
  if (!p?.id || typeof lat !== "number" || typeof lng !== "number") return null;
  const { countryCode, city } = extractAddress(p.addressComponents);
  return {
    placeId: p.id,
    source: "google",
    name: p.displayName?.text?.trim() || "(adsız işletme)",
    formattedAddress: p.formattedAddress,
    lat,
    lng,
    countryCode,
    city,
    primaryType: p.primaryType,
    types: p.types ?? [],
    businessStatus: p.businessStatus,
    openingDate: formatOpeningDate(p.openingDate),
    googleMapsUri: p.googleMapsUri,
    website: p.websiteUri,
    phone: p.nationalPhoneNumber,
    intlPhone: p.internationalPhoneNumber,
    userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
  };
}
