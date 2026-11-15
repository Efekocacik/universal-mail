import { describe, expect, it } from "vitest";
import {
  categoryForCodes,
  codesForScheme,
  isSchemeAvailable,
  NAF_CATEGORY,
  SIC_CATEGORY,
} from "@/lib/registry/codes";
import {
  addressKey,
  AMBIGUITY_MARGIN,
  assignMatches,
  buildCandidateIndex,
  decideMatch,
  diceBigram,
  foldText,
  localityKey,
  MATCH_MIN,
  MATCH_MIN_POSTCODE,
  nameSimilarity,
  normaliseName,
  postcodeKey,
  postcodeKeyFromAddress,
  tokenContainment,
  type MatchCandidate,
  type MatchSubject,
} from "@/lib/registry/match";

/** Eşleştirme birim testleri: yalnızca YAPAY adlar (gerçek şirket yok). */

const cand = (
  placeId: string,
  name: string,
  city: string | null,
  address = "",
  country = "GB",
): MatchCandidate => ({
  placeId,
  nameNorm: normaliseName(name),
  cityKey: localityKey(city),
  postcodeKey: postcodeKeyFromAddress(country, address),
  addressFold: foldText(address),
});

const subj = (
  id: number,
  name: string,
  locality: string | null,
  extra: Partial<MatchSubject> = {},
): MatchSubject => ({
  id,
  countryCode: "GB",
  nameNorm: normaliseName(name),
  localityKey: localityKey(locality),
  postcodeKey: null,
  addressKey: null,
  ...extra,
});

describe("normaliseName", () => {
  it.each([
    ["DAILY GRIND CAFÉ LTD", "daily grind cafe"],
    ["The Daily Grind Café", "daily grind cafe"],
    ["Fish & Chips Company Limited", "fish chips"],
    ["L'ATELIER DU CAFÉ SARL", "atelier du cafe"],
    ["LA BRÛLERIE EXEMPLE SAS", "brulerie exemple"],
    ["Café  Crème   et  Croissant EURL", "cafe creme croissant"],
    ["Örnek Kahve Evi", "ornek kahve evi"],
    ["LTD", "ltd"],
    ["!!!", "?"],
    ["The", "the"],
    ["ACME UK PLC LLP CIC", "acme"],
  ])("%s → %s", (raw, expected) => {
    expect(normaliseName(raw)).toBe(expected);
  });
});

describe("benzerlik", () => {
  it("dice bigram: aynı 1, ayrık 0, kısa dizeler", () => {
    expect(diceBigram("night owl", "night owl")).toBe(1);
    expect(diceBigram("abc", "xyz")).toBe(0);
    expect(diceBigram("a", "a")).toBe(1);
    expect(diceBigram("a", "b")).toBe(0);
    expect(diceBigram("", "")).toBe(0);
    expect(diceBigram("night owl", "nightowl")).toBe(1); // boşluk yok sayılır
  });
  it("belirteç kapsama: kısa taraf en az 2 belirteç", () => {
    expect(tokenContainment("copper kettle", "copper kettle london")).toBe(1);
    expect(tokenContainment("kettle", "copper kettle")).toBe(0);
    expect(tokenContainment("copper kettle", "copper pot works")).toBe(0.5);
  });
  it("benzerlik iki ölçünün büyüğüdür", () => {
    const a = normaliseName("Copper Kettle");
    const b = normaliseName("Copper Kettle Riverside");
    expect(nameSimilarity(a, b)).toBe(1);
    expect(nameSimilarity("daily grind cafe", "daily grind bakery")).toBeLessThan(
      MATCH_MIN_POSTCODE,
    );
  });
});

describe("posta kodu, adres, şehir anahtarları", () => {
  it("GB dış kod ve FR 5 hane", () => {
    expect(postcodeKey("GB", "ec1a 1bb")).toBe("EC1A");
    expect(postcodeKey("GB", "W1A0AX")).toBe("W1A");
    expect(postcodeKey("GB", "SW1")).toBeNull();
    expect(postcodeKey("FR", "75 011")).toBe("75011");
    expect(postcodeKey("FR", "7501")).toBeNull();
    expect(postcodeKey("DE", "10115")).toBeNull();
    expect(postcodeKey("GB", null)).toBeNull();
  });
  it("adres metninden çıkarım", () => {
    expect(postcodeKeyFromAddress("GB", "1 Example St, London EC1A 1BB, UK")).toBe("EC1A");
    expect(postcodeKeyFromAddress("FR", "7 Rue Exemple, 75011 Paris, France")).toBe("75011");
    expect(postcodeKeyFromAddress("GB", "12 High Street, London")).toBeNull();
    expect(postcodeKeyFromAddress("FR", null)).toBeNull();
    expect(postcodeKeyFromAddress("IT", "Via Roma 1, 00100 Roma")).toBeNull();
  });
  it("adres satırı yalnızca rakamlı ve yeterince uzunsa ayırt edicidir", () => {
    expect(addressKey("12 HIGH STREET, LONDON")).toBe("12 high street");
    expect(addressKey("HIGH STREET")).toBeNull();
    expect(addressKey("1 a")).toBeNull();
    expect(addressKey(null)).toBeNull();
  });
  it("şehir anahtarı katlanır", () => {
    expect(localityKey("Saint-Denis")).toBe("saint denis");
    expect(localityKey("  ")).toBeNull();
    expect(localityKey(null)).toBeNull();
  });
});

describe("decideMatch (eşikler, belirsizlik, adres önceliği)", () => {
  const idx = buildCandidateIndex([
    cand("p1", "Copper Kettle Café", "London", "4 Mill Lane, London"),
    cand("p2", "Copper Kettle Café", "London", "9 Park Road, London"),
    cand("p3", "Hidden Lounge", "London"),
    cand("p4", "Night Owl Coffee", "Leeds"),
    cand("p5", "Riverside Owl Coffee", "Bristol", "2 Dock Road, Bristol BS1 4AA"),
  ]);

  it("ad + şehir eşleşir (name_city)", () => {
    expect(decideMatch(subj(1, "HIDDEN LOUNGE LTD", "London"), idx)).toMatchObject({
      status: "matched",
      placeId: "p3",
      reason: "name_city",
      score: 1,
    });
  });

  it("aynı adlı iki aday: adres satırı birini seçer (name_address); adres yoksa belirsiz", () => {
    expect(
      decideMatch(subj(2, "COPPER KETTLE CAFE LTD", "London", { addressKey: "9 park road" }), idx),
    ).toMatchObject({ status: "matched", placeId: "p2", reason: "name_address" });
    expect(decideMatch(subj(3, "COPPER KETTLE CAFE LTD", "London"), idx)).toMatchObject({
      status: "unmatched",
      reason: "ambiguous",
    });
  });

  it("posta kodu ile daha düşük eşik (0.75) yeter; şehirle yetmez", () => {
    const near = "Riverside Owl Coffees Co"; // ~0.9 dice → her iki yoldan da geçer
    expect(decideMatch(subj(4, near, null, { postcodeKey: "BS1" }), idx).status).toBe("matched");
    // Benzerlik 0.75–0.86 arası: yalnızca posta koduyla eşleşir.
    const mid = "Riverside Owl Cafe";
    const sim = nameSimilarity(normaliseName(mid), normaliseName("Riverside Owl Coffee"));
    expect(sim).toBeGreaterThanOrEqual(MATCH_MIN_POSTCODE);
    expect(sim).toBeLessThan(MATCH_MIN);
    expect(decideMatch(subj(5, mid, null, { postcodeKey: "BS1" }), idx)).toMatchObject({
      status: "matched",
      reason: "name_postcode",
    });
    expect(decideMatch(subj(6, mid, "Bristol"), idx)).toMatchObject({
      status: "unmatched",
      reason: "below_threshold",
    });
  });

  it("aynı ad başka şehirde: aday değildir (no_cache = o bölgede veri yok)", () => {
    expect(decideMatch(subj(7, "NIGHT OWL COFFEE LTD", "London"), idx)).toMatchObject({
      status: "unmatched",
      reason: "below_threshold",
    });
    expect(decideMatch(subj(8, "NIGHT OWL COFFEE LTD", "Manchester"), idx)).toEqual({
      status: "pending",
      placeId: null,
      score: null,
      reason: "no_cache",
    });
  });

  it("dizin yok veya boş → no_cache; bloktaki tüm yerler alınmışsa no_candidates", () => {
    expect(decideMatch(subj(9, "X", "London"), undefined).reason).toBe("no_cache");
    expect(decideMatch(subj(9, "X", "London"), buildCandidateIndex([])).reason).toBe("no_cache");
    expect(decideMatch(subj(10, "NIGHT OWL COFFEE", "Leeds"), idx, new Set(["p4"]))).toMatchObject({
      status: "unmatched",
      reason: "no_candidates",
    });
  });

  it("belirsizlik payı: ikinci aday payın dışındaysa en iyi kazanır", () => {
    expect(AMBIGUITY_MARGIN).toBe(0.03);
    const i2 = buildCandidateIndex([
      cand("a", "Golden Spoon Diner", "York"),
      cand("b", "Golden Spoon Diners Club", "York"),
    ]);
    const d = decideMatch(subj(11, "GOLDEN SPOON DINER LTD", "York"), i2);
    expect(d.status).toBe("matched");
    expect(d.placeId).toBe("a");
  });
});

describe("assignMatches (bire bir)", () => {
  it("aynı yeri isteyen iki kayıttan güçlü olan kazanır, diğeri belirsiz", () => {
    const idx = new Map([
      [
        "GB",
        buildCandidateIndex([cand("p1", "Velvet Grind Café", "London", "3 King Road, London")]),
      ],
    ]);
    const out = assignMatches(
      [
        subj(1, "VELVET GRIND CAFE LTD", "London"),
        subj(2, "VELVET GRIND CAFE LTD", "London", { addressKey: "3 king road" }),
        subj(3, "OTHER", "Paris", { countryCode: "FR" }),
      ],
      idx,
    );
    expect(out.get(2)).toMatchObject({ status: "matched", placeId: "p1", reason: "name_address" });
    expect(out.get(1)).toMatchObject({ status: "unmatched", reason: "ambiguous", placeId: null });
    expect(out.get(3)).toMatchObject({ status: "pending", reason: "no_cache" });
    expect(Object.keys(out.get(2)!)).not.toContain("address");
  });

  it("eşitlikte küçük kimlik kazanır; zaten bağlı yer aday değildir", () => {
    const idx = new Map([["GB", buildCandidateIndex([cand("p1", "Iron Anchor Inn", "Hull")])]]);
    const out = assignMatches(
      [subj(5, "IRON ANCHOR INN LTD", "Hull"), subj(4, "IRON ANCHOR INN", "Hull")],
      idx,
    );
    expect(out.get(4)?.status).toBe("matched");
    expect(out.get(5)?.reason).toBe("ambiguous");
    const taken = assignMatches([subj(6, "IRON ANCHOR INN", "Hull")], idx, new Set(["p1"]));
    expect(taken.get(6)?.reason).toBe("no_candidates");
  });
});

describe("kod → kategori", () => {
  it("SIC ve NAF eşlemeleri; barlar pub kategorisinde", () => {
    expect(SIC_CATEGORY["56102"]).toBe("cafe");
    expect(SIC_CATEGORY["56301"]).toBe("pub");
    expect(NAF_CATEGORY["56.30Z"]).toBe("cafe");
    expect(categoryForCodes("SIC2007", ["99999", "56302"])).toBe("pub");
    expect(categoryForCodes("NAFRev2", ["01.11Z"])).toBeNull();
    expect(categoryForCodes("NAF2025", ["56.30Z"])).toBeNull();
  });
  it("NAF 2025 tablosu yayımlanana dek kullanılamaz", () => {
    expect(isSchemeAvailable("SIC2007")).toBe(true);
    expect(isSchemeAvailable("NAFRev2")).toBe(true);
    expect(isSchemeAvailable("NAF2025")).toBe(false);
    expect(codesForScheme("SIC2007")).toContain("56102");
    expect(codesForScheme("NAF2025")).toEqual([]);
  });
});
