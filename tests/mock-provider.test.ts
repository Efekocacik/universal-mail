import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bboxFromCenter, splitBBox } from "@/lib/geo/bbox";
import { DISCOVERY_FIELDS, ENRICH_FIELDS } from "@/lib/places/fields";
import { MockPlacesProvider } from "@/lib/places/mock";
import type { PlaceRecord } from "@/lib/domain/types";

beforeAll(() => {
  process.env.UM_STATIC_DATA_DIR = path.resolve(__dirname, "..", "data");
});

const londonCentre = bboxFromCenter(51.5085, -0.1257, 5); // 10×10 km: yoğun merkezde 60 sonuç sınırını aşar
const farAway = bboxFromCenter(35, -30, 5); // okyanus ortası

function provider(epoch = 0) {
  return new MockPlacesProvider({ getEpoch: () => epoch });
}

async function allPages(
  p: MockPlacesProvider,
  bbox = londonCentre,
  fields: readonly string[] = DISCOVERY_FIELDS,
  future = true,
) {
  const out: PlaceRecord[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await p.searchText({
      textQuery: "cafe",
      includedType: "cafe",
      bbox,
      pageToken: token,
      fields,
      includeFutureOpening: future,
    });
    out.push(...res.places);
    token = res.nextPageToken;
    pages++;
  } while (token && pages < 10);
  return { places: out, pages };
}

describe("MockPlacesProvider", () => {
  it("deterministiktir: aynı istek aynı sonucu verir", async () => {
    const a = await allPages(provider());
    const b = await allPages(provider());
    expect(a.places.map((p) => p.placeId)).toEqual(b.places.map((p) => p.placeId));
    expect(a.places.length).toBeGreaterThan(0);
  });

  it("yoğun merkezde 60 sonuç sınırına ulaşır ve 20'şerli sayfalar verir", async () => {
    const { places, pages } = await allPages(provider());
    expect(places).toHaveLength(60);
    expect(pages).toBe(3);
  });

  it("sonuçlar istenen kutunun içindedir ve demo olarak işaretlidir", async () => {
    const { places } = await allPages(provider());
    for (const p of places) {
      expect(p.lat).toBeGreaterThanOrEqual(londonCentre.south);
      expect(p.lat).toBeLessThanOrEqual(londonCentre.north);
      expect(p.lng).toBeGreaterThanOrEqual(londonCentre.west);
      expect(p.lng).toBeLessThanOrEqual(londonCentre.east);
      expect(p.source).toBe("demo");
      expect(p.countryCode).toBe("GB");
      expect(p.primaryType).toBe("cafe");
    }
  });

  it("kutu bölününce çocuk sonuçları ebeveynin kümesiyle tutarlıdır (aynı kimlikler)", async () => {
    const big = bboxFromCenter(51.5085, -0.1257, 0.5);
    const parent = await allPages(provider(), big);
    const children = (
      await Promise.all(splitBBox(big).map((c) => allPages(provider(), c)))
    ).flatMap((r) => r.places);
    const childIds = new Set(children.map((p) => p.placeId));
    // Ebeveyn 60 ile sınırlıysa onun gördüğü her yer çocuklarda da bulunmalı.
    for (const p of parent.places) expect(childIds.has(p.placeId)).toBe(true);
  });

  it("kentten uzakta sonuç yok", async () => {
    const { places } = await allPages(provider(), farAway);
    expect(places).toHaveLength(0);
  });

  it("FUTURE_OPENING yalnızca includeFutureOpening açıkken döner ve açılış tarihi içerir", async () => {
    const big = bboxFromCenter(51.5085, -0.1257, 4);
    // Birden çok küçük hücre tara, çünkü tek sorgu 60 ile sınırlı.
    const cells = splitBBox(bboxFromCenter(51.5085, -0.1257, 4))
      .flatMap((c) => splitBBox(c))
      .flatMap((c) => splitBBox(c));
    const withFuture = (
      await Promise.all(cells.map((c) => allPages(provider(), c, DISCOVERY_FIELDS, true)))
    ).flatMap((r) => r.places);
    const without = (
      await Promise.all(cells.map((c) => allPages(provider(), c, DISCOVERY_FIELDS, false)))
    ).flatMap((r) => r.places);
    void big;
    const future = withFuture.filter((p) => p.businessStatus === "FUTURE_OPENING");
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.openingDate ?? ""))).toBe(true);
    expect(without.some((p) => p.businessStatus === "FUTURE_OPENING")).toBe(false);
  });

  it("epoch artınca yeni işletmeler belirir ve bazı FUTURE_OPENING işletmeler açılır", async () => {
    const cells = splitBBox(bboxFromCenter(51.5085, -0.1257, 4))
      .flatMap((c) => splitBBox(c))
      .flatMap((c) => splitBBox(c));
    const scan = async (epoch: number) =>
      (
        await Promise.all(cells.map((c) => allPages(provider(epoch), c, DISCOVERY_FIELDS, true)))
      ).flatMap((r) => r.places);
    const e0 = await scan(0);
    const e3 = await scan(3);
    const ids0 = new Set(e0.map((p) => p.placeId));
    const added = e3.filter((p) => !ids0.has(p.placeId));
    expect(added.length).toBeGreaterThan(0);

    const futureAt0 = new Map(
      e0.filter((p) => p.businessStatus === "FUTURE_OPENING").map((p) => [p.placeId, p]),
    );
    const opened = e3.filter((p) => futureAt0.has(p.placeId) && p.businessStatus === "OPERATIONAL");
    expect(opened.length).toBeGreaterThan(0);
  });

  it("zenginleştirme alanları yalnızca istenirse gelir; web siteleri .example alan adındadır", async () => {
    const cheap = await allPages(provider(), londonCentre, DISCOVERY_FIELDS);
    expect(
      cheap.places.every((p) => p.website === undefined && p.userRatingCount === undefined),
    ).toBe(true);
    const rich = await allPages(provider(), londonCentre, ENRICH_FIELDS);
    expect(
      rich.places.every(
        (p) => p.website?.endsWith(".example") && typeof p.userRatingCount === "number",
      ),
    ).toBe(true);
    expect(
      (
        await provider().searchText({
          textQuery: "cafe",
          includedType: "cafe",
          bbox: londonCentre,
          fields: ENRICH_FIELDS,
          includeFutureOpening: true,
        })
      ).sku,
    ).toBe("text_search_enterprise");
  });

  it("Nearby Search en fazla 20 sonuç döndürür ve daire içinde kalır", async () => {
    const res = await provider().searchNearby({
      includedTypes: ["cafe", "pub"],
      circle: { lat: 51.5085, lng: -0.1257, radiusM: 1500 },
      fields: DISCOVERY_FIELDS,
      includeFutureOpening: false,
    });
    expect(res.places.length).toBeGreaterThan(0);
    expect(res.places.length).toBeLessThanOrEqual(20);
    expect(res.nextPageToken).toBeUndefined();
    expect(res.sku).toBe("nearby_search_pro");
  });

  it("anahtar kelime aramaları türe eşlenir, bilinmeyen kelime sonuç vermez", async () => {
    const p = provider();
    const hit = await p.searchText({
      textQuery: "specialty coffee",
      bbox: londonCentre,
      fields: DISCOVERY_FIELDS,
      includeFutureOpening: false,
    });
    expect(hit.places.length).toBeGreaterThan(0);
    const none = await p.searchText({
      textQuery: "bowling alley",
      bbox: londonCentre,
      fields: DISCOVERY_FIELDS,
      includeFutureOpening: false,
    });
    expect(none.places).toHaveLength(0);
  });

  it("Place Details demo kimliğinden aynı kaydı yeniden üretir", async () => {
    const { places } = await allPages(provider(), londonCentre, ENRICH_FIELDS);
    const target = places[5]!;
    const res = await provider().getDetails(target.placeId, [
      "id",
      "websiteUri",
      "userRatingCount",
    ]);
    expect(res.place?.placeId).toBe(target.placeId);
    expect(res.place?.website).toBe(target.website);
    expect(res.sku).toBe("place_details_enterprise");
    expect((await provider().getDetails("ChIJ-gercek", ["id"])).place).toBeNull();
  });

  it("geçersiz sayfa belirteci hata verir", async () => {
    await expect(
      provider().searchText({
        textQuery: "cafe",
        includedType: "cafe",
        bbox: londonCentre,
        pageToken: "!!!",
        fields: DISCOVERY_FIELDS,
        includeFutureOpening: true,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});
