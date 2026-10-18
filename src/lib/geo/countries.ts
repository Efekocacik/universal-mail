/** Hedef pazar olarak sunulan ülkeler: Avrupa + Türkiye. Rusya, Belarus ve Ukrayna kapsam dışıdır. */
export const COUNTRY_CODES = [
  "AD", "AL", "AT", "BA", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB",
  "GI", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT",
  "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR", "XK",
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

/** Türkiye varsayılan hedef pazar değildir (ihracat odağı). */
export const DEFAULT_EXCLUDED_COUNTRIES: readonly string[] = ["TR"];

const NAME_OVERRIDES_TR: Record<string, string> = { XK: "Kosova" };

export function countryName(code: string, locale = "tr"): string {
  if (locale === "tr" && NAME_OVERRIDES_TR[code]) return NAME_OVERRIDES_TR[code];
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function isKnownCountry(code: string): boolean {
  return (COUNTRY_CODES as readonly string[]).includes(code);
}

export interface CountryOption {
  code: string;
  name: string;
}

export function countryOptions(locale = "tr"): CountryOption[] {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) =>
    a.name.localeCompare(b.name, locale),
  );
}
