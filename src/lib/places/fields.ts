import type { SkuId } from "@/lib/domain/types";

/**
 * Alan → fiyat sınıfı eşlemesi (Places API (New) data-fields tablosundan, Ekim 2026).
 * Bir istek, istediği EN PAHALI alanın sınıfı üzerinden faturalanır. Bu yüzden bilinmeyen bir
 * alan istenirse hata verilir: yanlışlıkla pahalı alan eklemek mümkün olmasın.
 */
export type FieldTier = "ids" | "pro" | "enterprise";

export const FIELD_TIERS: Readonly<Record<string, FieldTier>> = {
  id: "ids",
  displayName: "pro",
  formattedAddress: "pro",
  location: "pro",
  types: "pro",
  primaryType: "pro",
  businessStatus: "pro",
  openingDate: "pro",
  addressComponents: "pro",
  googleMapsUri: "pro",
  websiteUri: "enterprise",
  nationalPhoneNumber: "enterprise",
  internationalPhoneNumber: "enterprise",
  userRatingCount: "enterprise",
};

/**
 * İlk keşif maskesi (SRS 4.1 DISCOVERY). Hepsi "Pro" sınıfındadır.
 * `addressComponents` ve `googleMapsUri` aynı sınıfta olduğundan ek maliyet getirmez; ülke/şehir
 * filtreleri ve Google Haritalar bağlantısı için gereklidir.
 */
export const DISCOVERY_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "types",
  "primaryType",
  "businessStatus",
  "openingDate",
  "addressComponents",
  "googleMapsUri",
] as const;

/** Zenginleştirme maskesi (SRS 4.1 ENRICH): keşif alanları + Enterprise alanlar. */
export const ENRICH_FIELDS = [
  ...DISCOVERY_FIELDS,
  "websiteUri",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "userRatingCount",
] as const;

/** Tekil Place Details ile zenginleştirmede istenen alanlar. */
export const DETAILS_ENRICH_FIELDS = [
  "id",
  "businessStatus",
  "openingDate",
  "websiteUri",
  "nationalPhoneNumber",
  "internationalPhoneNumber",
  "userRatingCount",
] as const;

export type Endpoint = "text" | "nearby" | "details";

export function tierOf(fields: readonly string[]): FieldTier {
  let tier: FieldTier = "ids";
  for (const f of fields) {
    const t = FIELD_TIERS[f];
    if (!t)
      throw new Error(
        `Bilinmeyen Places alanı: "${f}". Önce fiyat sınıfını FIELD_TIERS içine ekleyin.`,
      );
    if (t === "enterprise") return "enterprise";
    if (t === "pro") tier = "pro";
  }
  return tier;
}

export function skuFor(endpoint: Endpoint, fields: readonly string[]): SkuId {
  const tier = tierOf(fields);
  if (endpoint === "text") {
    return tier === "ids"
      ? "text_search_ids"
      : tier === "pro"
        ? "text_search_pro"
        : "text_search_enterprise";
  }
  if (endpoint === "nearby") {
    // Nearby Search'te `id` bile Pro sınıfındadır.
    return tier === "enterprise" ? "nearby_search_enterprise" : "nearby_search_pro";
  }
  return tier === "ids"
    ? "place_details_essentials"
    : tier === "pro"
      ? "place_details_pro"
      : "place_details_enterprise";
}

/** Text/Nearby Search için `X-Goog-FieldMask` (alanlar `places.` önekiyle). */
export function searchFieldMask(fields: readonly string[]): string {
  tierOf(fields);
  return fields.map((f) => `places.${f}`).join(",");
}

/** Place Details için `X-Goog-FieldMask` (öneksiz). */
export function detailsFieldMask(fields: readonly string[]): string {
  tierOf(fields);
  return fields.join(",");
}
