import { beforeAll, describe, expect, it } from "vitest";
import {
  bboxAreaKm2,
  bboxCircumCircle,
  bboxFromCenter,
  bboxIntersectsCircle,
  bboxSizeKm,
  gridCells,
  haversineM,
  isValidBBox,
  pointInBBox,
  splitBBox,
} from "@/lib/geo/bbox";
import { countryName, countryOptions, isKnownCountry } from "@/lib/geo/countries";
import {
  cityBBox,
  defaultRadiusKm,
  getCityById,
  nearestCity,
  normalizeText,
  searchCities,
} from "@/lib/geo/cities";
import path from "node:path";

beforeAll(() => {
  process.env.UM_STATIC_DATA_DIR = path.resolve(__dirname, "..", "data");
});

describe("bbox", () => {
  const london = bboxFromCenter(51.5, -0.12, 5);

  it("kare kutunun kenarları yaklaşık istenen uzunlukta", () => {
    const { widthKm, heightKm } = bboxSizeKm(london);
    expect(widthKm).toBeCloseTo(10, 0);
    expect(heightKm).toBeCloseTo(10, 0);
    expect(bboxAreaKm2(london)).toBeCloseTo(100, -1);
    expect(isValidBBox(london)).toBe(true);
  });

  it("geçersiz kutuları reddeder", () => {
    expect(isValidBBox({ south: 10, north: 5, west: 0, east: 1 })).toBe(false);
    expect(isValidBBox({ south: 0, north: 1, west: 10, east: 5 })).toBe(false);
    expect(isValidBBox({ south: -91, north: 1, west: 0, east: 1 })).toBe(false);
    expect(isValidBBox({ south: NaN, north: 1, west: 0, east: 1 })).toBe(false);
  });

  it("dörde bölünce parçalar kutuyu tam kapsar", () => {
    const parts = splitBBox(london);
    expect(parts).toHaveLength(4);
    const area = parts.reduce((a, p) => a + bboxAreaKm2(p), 0);
    expect(area).toBeCloseTo(bboxAreaKm2(london), 3);
    expect(Math.min(...parts.map((p) => p.south))).toBe(london.south);
    expect(Math.max(...parts.map((p) => p.north))).toBe(london.north);
  });

  it("ızgara hücreleri kutuyu boşluksuz kapsar", () => {
    const cells = gridCells(london, 2.5);
    expect(cells).toHaveLength(16);
    const area = cells.reduce((a, c) => a + bboxAreaKm2(c), 0);
    expect(area).toBeCloseTo(bboxAreaKm2(london), 3);
    expect(gridCells(london, 100)).toHaveLength(1);
  });

  it("çevrel daire tüm köşeleri kapsar", () => {
    const c = bboxCircumCircle(london);
    for (const [lat, lng] of [
      [london.south, london.west],
      [london.north, london.east],
      [london.south, london.east],
      [london.north, london.west],
    ] as const) {
      expect(haversineM({ lat: c.lat, lng: c.lng }, { lat, lng })).toBeLessThanOrEqual(
        c.radiusM + 1,
      );
    }
  });

  it("haversine bilinen mesafeyi verir (Londra–Paris ≈ 344 km)", () => {
    const d = haversineM({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }) / 1000;
    expect(d).toBeGreaterThan(340);
    expect(d).toBeLessThan(348);
  });

  it("nokta ve daire kesişimi", () => {
    expect(pointInBBox({ lat: 51.5, lng: -0.12 }, london)).toBe(true);
    expect(pointInBBox({ lat: 52.5, lng: -0.12 }, london)).toBe(false);
    expect(bboxIntersectsCircle(london, { lat: 51.5, lng: -0.12, radiusM: 100 })).toBe(true);
    expect(bboxIntersectsCircle(london, { lat: 40, lng: 10, radiusM: 1000 })).toBe(false);
  });
});

describe("şehirler", () => {
  it("veri kümesi Avrupa ve Türkiye şehirlerini içerir", () => {
    const london = searchCities("London", { limit: 1 })[0]!;
    expect(london.cc).toBe("GB");
    expect(london.pop).toBeGreaterThan(5_000_000);
    expect(searchCities("Amsterdam", { limit: 1 })[0]?.cc).toBe("NL");
    expect(searchCities("Istanbul", { limit: 1 })[0]?.cc).toBe("TR");
  });

  it("Türkçe takma adlar ve aksan duyarsız arama çalışır", () => {
    expect(searchCities("Londra", { limit: 1 })[0]?.name).toBe("London");
    expect(searchCities("viyana", { limit: 1 })[0]?.cc).toBe("AT");
    expect(searchCities("izmir", { limit: 1 })[0]?.cc).toBe("TR");
    expect(normalizeText("İstanbul")).toBe("istanbul");
  });

  it("ülke filtresi ve sıralama (tam eşleşme önce)", () => {
    const res = searchCities("Mans", { countries: ["GB"], limit: 5 });
    expect(res.every((c) => c.cc === "GB")).toBe(true);
    expect(searchCities("", { countries: ["NL"], limit: 3 }).length).toBe(3);
  });

  it("yarıçap sınırlı ve nüfusla artar", () => {
    expect(defaultRadiusKm(60_000)).toBe(2.5);
    expect(defaultRadiusKm(9_000_000)).toBe(25);
    expect(defaultRadiusKm(700_000)).toBeGreaterThan(defaultRadiusKm(100_000));
    const ams = searchCities("Amsterdam", { limit: 1 })[0]!;
    expect(isValidBBox(cityBBox(ams))).toBe(true);
    expect(getCityById(ams.id)?.name).toBe("Amsterdam");
    expect(nearestCity(ams.lat + 0.01, ams.lng, 5)?.id).toBe(ams.id);
    expect(nearestCity(0, -30, 60)).toBeUndefined();
  });

  it("ülke adları Türkçe ve kapsam dışı ülkeler reddedilir", () => {
    expect(countryName("DE")).toBe("Almanya");
    expect(countryName("XK")).toBe("Kosova");
    expect(isKnownCountry("TR")).toBe(true);
    expect(isKnownCountry("RU")).toBe(false);
    expect(countryOptions().length).toBeGreaterThan(40);
  });
});
