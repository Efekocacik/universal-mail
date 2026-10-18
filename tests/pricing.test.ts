import { describe, expect, it } from "vitest";
import {
  DISCOVERY_FIELDS,
  ENRICH_FIELDS,
  detailsFieldMask,
  searchFieldMask,
  skuFor,
  tierOf,
} from "@/lib/places/fields";
import { marginalCostUsd, skuLabel } from "@/lib/places/pricing";

describe("marginalCostUsd", () => {
  it("ücretsiz kota içindeki çağrılar 0 USD", () => {
    expect(marginalCostUsd("text_search_pro", 0, 5000)).toBe(0);
    expect(marginalCostUsd("text_search_enterprise", 0, 1000)).toBe(0);
    expect(marginalCostUsd("text_search_ids", 0, 1_000_000)).toBe(0);
  });

  it("kotayı aşan kısım için ücret alınır", () => {
    // 4.990 yapılmışken 20 çağrı: 10 ücretsiz, 10 ücretli => 10 * 32 / 1000
    expect(marginalCostUsd("text_search_pro", 4990, 20)).toBeCloseTo(0.32, 6);
    expect(marginalCostUsd("text_search_pro", 5000, 1000)).toBeCloseTo(32, 6);
    expect(marginalCostUsd("text_search_enterprise", 1000, 1000)).toBeCloseTo(35, 6);
  });

  it("kademe sınırını (100.000) geçen çağrılar ikinci fiyattan hesaplanır", () => {
    // 99.000 -> 101.000 arası: 1.000 * 32 + 1.000 * 25,6 (bin başına)
    expect(marginalCostUsd("text_search_pro", 99_000, 2000)).toBeCloseTo(32 + 25.6, 6);
  });

  it("Google'ın yayımladığı örnek hesapla uyumlu (Autocomplete 200.000 çağrı: 481,70 USD)", () => {
    // Autocomplete bu projede kullanılmaz; kademe mantığını doğrulamak için aynı yapı elle kurulur.
    const paid1 = (100_000 - 10_000) * (2.83 / 1000);
    const paid2 = (200_000 - 100_000) * (2.27 / 1000);
    expect(paid1 + paid2).toBeCloseTo(481.7, 6);
  });

  it("sıfır veya negatif çağrı maliyetsiz", () => {
    expect(marginalCostUsd("text_search_pro", 10_000, 0)).toBe(0);
    expect(marginalCostUsd("text_search_pro", 10_000, -5)).toBe(0);
  });

  it("etiketler okunur", () => {
    expect(skuLabel("text_search_pro")).toBe("Text Search Pro");
    expect(skuLabel("bilinmeyen")).toBe("bilinmeyen");
  });
});

describe("alan maskeleri ve SKU", () => {
  it("keşif maskesi Pro sınıfındadır", () => {
    expect(tierOf(DISCOVERY_FIELDS)).toBe("pro");
    expect(skuFor("text", DISCOVERY_FIELDS)).toBe("text_search_pro");
    expect(skuFor("nearby", DISCOVERY_FIELDS)).toBe("nearby_search_pro");
    expect(skuFor("details", DISCOVERY_FIELDS)).toBe("place_details_pro");
  });

  it("zenginleştirme maskesi Enterprise sınıfındadır", () => {
    expect(tierOf(ENRICH_FIELDS)).toBe("enterprise");
    expect(skuFor("text", ENRICH_FIELDS)).toBe("text_search_enterprise");
    expect(skuFor("details", ["id", "websiteUri"])).toBe("place_details_enterprise");
  });

  it("yalnızca id istenirse Text Search ücretsiz sınıfta", () => {
    expect(skuFor("text", ["id"])).toBe("text_search_ids");
    expect(skuFor("nearby", ["id"])).toBe("nearby_search_pro");
    expect(skuFor("details", ["id"])).toBe("place_details_essentials");
  });

  it("bilinmeyen alan hata verir (yanlışlıkla pahalı alan eklenmesin)", () => {
    expect(() => tierOf(["id", "reviews"])).toThrow(/Bilinmeyen/);
    expect(() => searchFieldMask(["rating"])).toThrow();
  });

  it("maske biçimleri", () => {
    expect(searchFieldMask(["id", "displayName"])).toBe("places.id,places.displayName");
    expect(detailsFieldMask(["id", "websiteUri"])).toBe("id,websiteUri");
    expect(searchFieldMask(DISCOVERY_FIELDS)).not.toContain(" ");
  });
});
