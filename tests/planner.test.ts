import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bboxAreaKm2, bboxFromCenter, circleToBBox } from "@/lib/geo/bbox";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { leads, places } from "@/lib/db/schema";
import { createProvider } from "@/lib/places/factory";
import { GooglePlacesClient } from "@/lib/places/client";
import { MockPlacesProvider } from "@/lib/places/mock";
import { PlacesApiError } from "@/lib/places/errors";
import type { PlacesProvider } from "@/lib/places/provider";
import { enrichPlaces } from "@/lib/scan/enrich";
import {
  MAX_AREA_KM2,
  PlanError,
  canSubdivide,
  chooseCellKm,
  estimateScan,
  planCells,
  planUnits,
  queryTerms,
  skuForScan,
  type PlanInput,
} from "@/lib/scan/planner";
import { buildQueries, computeScanKey, isValidPlaceType } from "@/lib/scan/queries";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

const center = { lat: 51.5085, lng: -0.1257 };
const box = bboxFromCenter(center.lat, center.lng, 6);
const queries = buildQueries([
  { key: "cafe", placeTypes: ["cafe", "coffee_shop"], keywords: [] },
  { key: "pub", placeTypes: ["pub"], keywords: ["gastropub"] },
]);
const base: PlanInput = { bbox: box, queries, strategy: "text", fieldProfile: "discovery" };

describe("sorgu üretimi", () => {
  it("türler ve anahtar kelimeler yinelenmeden birleştirilir; geçersiz tür adları atlanır", () => {
    const q = buildQueries(
      [
        { key: "a", placeTypes: ["cafe", "Geçersiz Tür!", "cafe"], keywords: ["Coffee "] },
        { key: "b", placeTypes: ["cafe"], keywords: ["coffee"] },
      ],
      ["brunch", "  ", "BRUNCH"],
    );
    expect(q.map((x) => `${x.kind}:${x.term}`)).toEqual([
      "type:cafe",
      "keyword:Coffee",
      "keyword:brunch",
    ]);
    expect(isValidPlaceType("coffee_shop")).toBe(true);
    expect(isValidPlaceType("Coffee Shop")).toBe(false);
    expect(isValidPlaceType("a")).toBe(false);
  });

  it("tarama anahtarı kararlıdır; kapsam değişince değişir", () => {
    const a = computeScanKey({ bbox: box, queries, strategy: "text" });
    expect(
      computeScanKey({ bbox: { ...box }, queries: [...queries].reverse(), strategy: "text" }),
    ).toBe(a); // sıra önemsiz
    expect(
      computeScanKey({ bbox: { ...box, north: box.north + 0.00001 }, queries, strategy: "text" }),
    ).toBe(a); // yuvarlama
    expect(computeScanKey({ bbox: box, queries, strategy: "nearby" })).not.toBe(a);
    expect(computeScanKey({ bbox: box, queries: queries.slice(1), strategy: "text" })).not.toBe(a);
    expect(
      computeScanKey({
        bbox: bboxFromCenter(center.lat, center.lng, 7),
        queries,
        strategy: "text",
      }),
    ).not.toBe(a);
    expect(
      computeScanKey({
        bbox: box,
        circle: { lat: 1, lng: 2, radiusM: 500 },
        queries,
        strategy: "text",
      }),
    ).not.toBe(a);
  });
});

describe("planlayıcı", () => {
  it("hücre boyutu alanla ölçeklenir ve 1,5–10 km arasında kalır", () => {
    expect(chooseCellKm(bboxFromCenter(0, 0, 0.5))).toBe(1.5);
    expect(chooseCellKm(bboxFromCenter(0, 0, 25))).toBeGreaterThan(5);
    expect(chooseCellKm(bboxFromCenter(0, 0, 49))).toBe(10);
  });

  it("Text Search: her tür ve anahtar kelime ayrı birimdir; Nearby: türler tek birimde gruplanır", () => {
    const text = queryTerms(queries, "text");
    expect(text).toHaveLength(4);
    expect(text.every((t) => t.kind === "text")).toBe(true);
    const nearby = queryTerms(queries, "nearby");
    expect(nearby).toEqual([
      { kind: "nearby", termKind: "type", term: "cafe,coffee_shop,pub" },
      { kind: "text", termKind: "keyword", term: "gastropub" },
    ]);
  });

  it("birim sayısı hücre × sorgu; daire bölgesi köşe hücreleri eler", () => {
    const { units, cells } = planUnits(base);
    expect(units).toHaveLength(cells * 4);
    const circle = { lat: center.lat, lng: center.lng, radiusM: 3000 };
    const full = planCells({ ...base, bbox: circleToBBox(center.lat, center.lng, 6000) });
    const round = planCells({ ...base, bbox: circleToBBox(center.lat, center.lng, 6000), circle });
    expect(round.cells.length).toBeLessThan(full.cells.length);
    expect(round.cells.length).toBeGreaterThan(0);
  });

  it("geçersiz girdiler PlanError verir", () => {
    expect(() => planUnits({ ...base, queries: [] })).toThrow(/kategori/);
    expect(() => planUnits({ ...base, bbox: { south: 10, north: 5, west: 0, east: 1 } })).toThrow(
      PlanError,
    );
    expect(() => planUnits({ ...base, bbox: bboxFromCenter(48, 10, 80) })).toThrow(/çok büyük/);
    expect(() => planUnits({ ...base, bbox: bboxFromCenter(48, 10, 0.01) })).toThrow(/çok küçük/);
    expect(bboxAreaKm2(bboxFromCenter(48, 10, 80))).toBeGreaterThan(MAX_AREA_KM2);
    // Birim üst sınırı: çok kategori + çok geniş alan
    const many = buildQueries([
      { key: "x", placeTypes: Array.from({ length: 70 }, (_, i) => `type_${i}a`), keywords: [] },
    ]);
    expect(() => planUnits({ ...base, bbox: bboxFromCenter(48, 10, 49), queries: many })).toThrow(
      /sorgu birimi/,
    );
  });

  it("tahmin: aralıklar sıralı, SKU profile göre, ücretsiz kota hesaba katılır", () => {
    const e = estimateScan(base, { monthCallsBySku: {} });
    expect(e.calls.low).toBeLessThan(e.calls.expected);
    expect(e.calls.expected).toBeLessThan(e.calls.high);
    expect(e.sku).toBe("text_search_pro");
    expect(e.freeCallsLeft).toBe(5000);
    expect(e.maxCalls).toBeGreaterThanOrEqual(Math.ceil(e.calls.high * 1.25));

    const used = estimateScan(base, { monthCallsBySku: { text_search_pro: 5000 } });
    expect(used.freeCallsLeft).toBe(0);
    expect(used.costUsd.expected).toBeGreaterThan(0);
    expect(used.costUsd.high).toBeGreaterThan(used.costUsd.expected);
    expect(used.costUsd.low).toBeCloseTo(e.calls.low * 0.032, 2);

    const rich = estimateScan({ ...base, fieldProfile: "enrich" }, { monthCallsBySku: {} });
    expect(rich.sku).toBe("text_search_enterprise");
    expect(rich.notes.join(" ")).toContain("Enterprise");

    const nearby = estimateScan({ ...base, strategy: "nearby" }, { monthCallsBySku: {} });
    expect(nearby.sku).toBe("nearby_search_pro");
    expect(nearby.notes.join(" ")).toContain("20 sonuç");
    expect(skuForScan("nearby", "enrich", "keyword")).toBe("text_search_enterprise");
  });

  it("alt bölme sınırlara uyar", () => {
    const unit = {
      bbox: bboxFromCenter(center.lat, center.lng, 2),
      depth: 0,
      kind: "text" as const,
    };
    expect(canSubdivide(unit)).toBe(true);
    expect(canSubdivide({ ...unit, depth: 4 })).toBe(false);
    expect(canSubdivide({ ...unit, bbox: bboxFromCenter(center.lat, center.lng, 0.2) })).toBe(
      false,
    ); // hücre çok küçük
    expect(
      canSubdivide({ ...unit, kind: "nearby", bbox: bboxFromCenter(center.lat, center.lng, 0.05) }),
    ).toBe(false);
  });
});

describe("sağlayıcı fabrikası ve zenginleştirme uç durumları", () => {
  let t: TestDb;
  let db: Db;
  beforeEach(async () => {
    t = await createTestDb();
    db = t.db;
    await initDatabase();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("ayara göre demo veya Google sağlayıcısı kurar", async () => {
    expect(await createProvider(db)).toBeInstanceOf(GooglePlacesClient);
    await setSetting(db, "places.provider", "mock");
    const mock = await createProvider(db);
    expect(mock).toBeInstanceOf(MockPlacesProvider);
    await setSetting(db, "mock.epoch", 2);
    expect((await mock.getDetails("yok", ["id"])).place).toBeNull();
  });

  function deps(provider: PlacesProvider) {
    return {
      db,
      provider,
      getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
      getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
      sleep: async () => undefined,
    };
  }

  it("var olmayan işletme atlanır; sağlayıcı null dönerse atlanır; 'invalid' hata atlanır; diğer hatalar fırlatılır", async () => {
    const now = Date.now();
    await db.insert(places).values({
      placeId: "p1",
      source: "demo",
      lat: 1,
      lng: 2,
      coordsFetchedAt: now,
      firstSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .insert(leads)
      .values({ placeId: "p1", source: "demo", createdAt: now, updatedAt: now });
    const stub = (impl: PlacesProvider["getDetails"]): PlacesProvider => ({
      id: "mock",
      pageSize: 20,
      maxTextResults: 60,
      maxNearbyResults: 20,
      searchText: async () => ({ places: [], sku: "text_search_pro" }),
      searchNearby: async () => ({ places: [], sku: "nearby_search_pro" }),
      getDetails: impl,
    });

    expect(
      (
        await enrichPlaces(
          deps(stub(async () => ({ place: null, sku: "place_details_enterprise" }))),
          ["yok", "p1"],
        )
      ).skipped,
    ).toBe(2);
    expect(
      (
        await enrichPlaces(
          deps(
            stub(async () => {
              throw new PlacesApiError("invalid", "x");
            }),
          ),
          ["p1"],
        )
      ).skipped,
    ).toBe(1);
    await expect(
      enrichPlaces(
        deps(
          stub(async () => {
            throw new PlacesApiError("auth", "anahtar");
          }),
        ),
        ["p1"],
      ),
    ).rejects.toMatchObject({ kind: "auth" });

    // Zenginleştirme "yeni açıldı" geçişini de yakalar
    await db.update(places).set({ wasFuture: true }).where(eq(places.placeId, "p1"));
    const opened = stub(async () => ({
      place: {
        placeId: "p1",
        source: "demo" as const,
        name: "A",
        lat: 1,
        lng: 2,
        types: [],
        businessStatus: "OPERATIONAL",
        userRatingCount: 2,
        website: "https://a.example",
      },
      sku: "place_details_enterprise" as const,
    }));
    expect((await enrichPlaces(deps(opened), ["p1"])).enriched).toBe(1);
    const row = (await db.select().from(places).where(eq(places.placeId, "p1")))[0]!;
    expect(row.openedDetectedAt).not.toBeNull();
    expect(row.wasFuture).toBe(false);
    expect(row.isClosed).toBe(false);
    const lead = (await db.select().from(leads).where(eq(leads.placeId, "p1")))[0]!;
    expect(lead.status).toBe("enriched");
    expect(lead.noveltyScore).toBe(100); // 90 (açıldı) + 25 (az yorum) → 100 ile sınırlı
  });
});
