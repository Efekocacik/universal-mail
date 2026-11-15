import type { ActivityScheme, RegistrySource } from "./types";

/**
 * Faaliyet kodu → uygulama kategorisi (`category_sets.key`). Ayar kartındaki kod seçenekleri de buradan gelir (etiketler
 * i18n: `registry.code.<kod>`). Uygulamada ayrı bir "bar" kategorisi yoktur: barlar `pub` kategorisindedir (Bar / pub),
 * bu yüzden SIC 56301 (licensed clubs/bars) `pub`'a eşlenir.
 */
export const SIC_CATEGORY = {
  "56102": "cafe",
  "56302": "pub",
  "56101": "restaurant",
  "56103": "restaurant",
  "56301": "pub",
  "55100": "hotel",
} as const satisfies Record<string, string>;

export const NAF_CATEGORY = {
  "56.30Z": "cafe",
  "56.10A": "restaurant",
  "56.10C": "restaurant",
  "55.10Z": "hotel",
} as const satisfies Record<string, string>;

/**
 * NAF rév. 2025 (INSEE, 1 Ocak 2027'den itibaren). Karşılık tablosu INSEE yayımlayana kadar BOŞTUR; bu yüzden
 * `NAF2025` seçimi `REGISTRY_SCHEME_UNAVAILABLE` ile reddedilir (bkz. `isSchemeAvailable`).
 */
export const NAF2025_CATEGORY: Readonly<Record<string, string>> = {};

const BY_SCHEME: Record<ActivityScheme, Readonly<Record<string, string>>> = {
  SIC2007: SIC_CATEGORY,
  NAFRev2: NAF_CATEGORY,
  NAF2025: NAF2025_CATEGORY,
};

/** Şemanın seçilebilir kodları (ayar kartı ve çalışma formu). */
export function codesForScheme(scheme: ActivityScheme): string[] {
  return Object.keys(BY_SCHEME[scheme]);
}

/** Şemanın kod tablosu yayımlandı mı? (NAF2025: henüz hayır.) */
export function isSchemeAvailable(scheme: ActivityScheme): boolean {
  return codesForScheme(scheme).length > 0;
}

/** Kodların ilk eşlenen kategorisi; hiçbiri bilinmiyorsa null. */
export function categoryForCodes(scheme: ActivityScheme, codes: readonly string[]): string | null {
  const map = BY_SCHEME[scheme];
  for (const c of codes) {
    const hit = map[c];
    if (hit) return hit;
  }
  return null;
}

/** Kaynağın kod biçimi (istek doğrulaması). */
export const CODE_RE: Record<RegistrySource, RegExp> = {
  companies_house: /^\d{5}$/,
  insee: /^\d{2}\.\d{2}[A-Z]$/,
};
