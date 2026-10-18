import { describe, expect, it } from "vitest";
import { bboxAreaKm2, haversineM } from "@/lib/geo/bbox";
import { MAX_AREA_KM2 } from "@/lib/scan/planner";
import {
  latLngToPixel,
  MAX_CIRCLE_RADIUS_M,
  MIN_CIRCLE_RADIUS_M,
  MIN_DRAG_PX,
  pixelToLatLng,
  regionFromDrag,
} from "@/features/explore/map-math";

const size = { w: 1000, h: 600 };
const london = { south: 51.3, west: -0.5, north: 51.7, east: 0.3 };

describe("piksel ↔ koordinat (Web Mercator)", () => {
  it("köşeler görünür alanın köşelerine denk gelir", () => {
    expect(pixelToLatLng(0, 0, size, london)).toMatchObject({ lng: -0.5 });
    expect(pixelToLatLng(0, 0, size, london).lat).toBeCloseTo(51.7, 6);
    expect(pixelToLatLng(1000, 600, size, london).lat).toBeCloseTo(51.3, 6);
    expect(pixelToLatLng(1000, 600, size, london).lng).toBeCloseTo(0.3, 6);
  });

  it("gidiş-dönüş kayıpsızdır", () => {
    for (const [x, y] of [
      [0, 0],
      [123, 456],
      [999, 1],
      [500, 300],
    ] as const) {
      const ll = pixelToLatLng(x, y, size, london);
      const back = latLngToPixel(ll.lat, ll.lng, size, london);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it("enlem Mercator'dur: orta piksel, düz ortalamanın (30°) güneyinde değil kuzeyinde (≈35°) kalır", () => {
    const wide = { south: 0, west: 0, north: 60, east: 10 };
    const mid = pixelToLatLng(500, 300, size, wide);
    expect(mid.lat).toBeGreaterThan(30);
    expect(mid.lat).toBeCloseTo(35.4, 0);
    expect(latLngToPixel(mid.lat, 5, size, wide).y).toBeCloseTo(300, 6);
  });

  it("180° boylamını aşan görünür alan doğru çözülür", () => {
    const across = { south: 60, west: 170, north: 70, east: -170 };
    expect(pixelToLatLng(0, 0, size, across).lng).toBeCloseTo(170, 6);
    expect(pixelToLatLng(500, 0, size, across).lng).toBeCloseTo(180, 6);
    expect(pixelToLatLng(750, 0, size, across).lng).toBeCloseTo(-175, 6);
    expect(latLngToPixel(65, -175, size, across).x).toBeCloseTo(750, 6);
  });
});

describe("sürüklemeden bölge üretimi", () => {
  it("dikdörtgen: sürükleme yönünden bağımsız aynı kutu", () => {
    const a = regionFromDrag("rect", { x: 200, y: 100 }, { x: 600, y: 400 }, size, london)!;
    const b = regionFromDrag("rect", { x: 600, y: 400 }, { x: 200, y: 100 }, size, london)!;
    expect(a.kind).toBe("bbox");
    expect(a.bbox).toEqual(b.bbox);
    expect(a.bbox.north).toBeGreaterThan(a.bbox.south);
    expect(a.bbox.east).toBeGreaterThan(a.bbox.west);
    expect(a.bbox.west).toBeCloseTo(-0.5 + 0.2 * 0.8, 6);
  });

  it("daire: yarıçap, iki nokta arası gerçek mesafedir ve sınırlanır", () => {
    const r = regionFromDrag("circle", { x: 500, y: 300 }, { x: 600, y: 300 }, size, london)!;
    expect(r.kind).toBe("circle");
    const edge = pixelToLatLng(600, 300, size, london);
    expect(r.circle!.radiusM).toBe(
      Math.round(haversineM({ lat: r.circle!.lat, lng: r.circle!.lng }, edge)),
    );
    expect(r.circle!.radiusM).toBeGreaterThan(5000);
    expect(r.bbox.north - r.bbox.south).toBeGreaterThan(0);

    const huge = regionFromDrag("circle", { x: 0, y: 0 }, { x: 1000, y: 600 }, size, {
      south: 20,
      west: -30,
      north: 70,
      east: 50,
    })!;
    expect(huge.circle!.radiusM).toBe(MAX_CIRCLE_RADIUS_M);
    const tiny = regionFromDrag(
      "circle",
      { x: 500, y: 300 },
      { x: 500 + MIN_DRAG_PX, y: 300 },
      size,
      { south: 51.5, west: -0.13, north: 51.51, east: -0.12 },
    )!;
    expect(tiny.circle!.radiusM).toBe(MIN_CIRCLE_RADIUS_M);
  });

  it("en büyük daire bile taranabilir alan sınırını aşmaz (aksi halde tahmin isteği reddedilirdi)", () => {
    for (const lat of [0, 36, 51.5, 60]) {
      const b = { south: lat - 25, west: -40, north: lat + 25, east: 40 };
      const r = regionFromDrag("circle", { x: 0, y: 300 }, { x: 1000, y: 300 }, size, b)!;
      expect(r.circle!.radiusM).toBe(MAX_CIRCLE_RADIUS_M);
      expect(bboxAreaKm2(r.bbox)).toBeLessThan(MAX_AREA_KM2);
    }
  });

  it("çok kısa sürükleme (yanlış tıklama) bölge üretmez", () => {
    expect(regionFromDrag("rect", { x: 10, y: 10 }, { x: 13, y: 12 }, size, london)).toBeNull();
    expect(regionFromDrag("circle", { x: 10, y: 10 }, { x: 10, y: 10 }, size, london)).toBeNull();
  });
});
