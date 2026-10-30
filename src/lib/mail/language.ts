/**
 * Şablon dilleri (SRS FR-TPL-02). Ülkeye göre dil yalnızca ÖNERİDİR: ülke, alıcının tercih ettiği dili kesin
 * göstermez; kullanıcı değiştirebilir.
 */
export const SUPPORTED_LANGUAGES = ["tr", "en", "de", "fr", "es", "it", "nl", "pt", "pl"] as const;
export type TemplateLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Ülke → önerilen dil. Çok dilli ülkelerde (BE, CH, LU) en yaygın iş dili seçilmiştir; listede olmayan ülke: EN. */
const COUNTRY_LANGUAGE: Readonly<Record<string, TemplateLanguage>> = {
  TR: "tr",
  GB: "en",
  IE: "en",
  MT: "en",
  GI: "en",
  DE: "de",
  AT: "de",
  LI: "de",
  CH: "de",
  FR: "fr",
  MC: "fr",
  LU: "fr",
  BE: "fr",
  ES: "es",
  AD: "es",
  IT: "it",
  SM: "it",
  NL: "nl",
  PT: "pt",
  PL: "pl",
};

export function isSupportedLanguage(value: unknown): value is TemplateLanguage {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Ülke koduna göre önerilen şablon dili; bilinmeyen veya boş ülke için İngilizce. */
export function suggestLanguage(countryCode: string | null | undefined): TemplateLanguage {
  return COUNTRY_LANGUAGE[countryCode?.trim().toUpperCase() ?? ""] ?? "en";
}

/**
 * Elde şablonu olan diller arasından seçim: önerilen dil → İngilizce → (ikisi de yoksa) null.
 * Rastgele bir dile düşülmez; uygun şablon yoksa kullanıcı karar verir.
 */
export function pickTemplateLanguage(
  suggested: TemplateLanguage,
  available: readonly string[],
): TemplateLanguage | null {
  if (available.includes(suggested)) return suggested;
  if (available.includes("en")) return "en";
  return null;
}
