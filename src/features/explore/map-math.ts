import type { BBox } from "@/lib/client/types";
import { haversineM } from "@/lib/geo/bbox";
import type { DraftRegion } from "./state";

/**
 * Harita üzerinde çizim için saf (Google'dan bağımsız) hesaplar. Google Haritası'nın `Map` nesnesi
 * fare basma/bırakma olayı vermediğinden çizimi kendi katmanımızla yaparız ve ekran pikselini koordinata
 * görünür alan (bounds) üzerinden çeviririz. Harita eğilmez ve döndürülmez (2B), bu yüzden dönüşüm Web Mercator'dür.
 */

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
const invMercY = (y: number) => deg(2 * Math.atan(Math.exp(y)) - Math.PI / 2);

export interface Size {
  w: number;
  h: number;
}

/** Konteyner pikselini (sol üst = 0,0) koordinata çevirir. 180° boylamını aşan görünür alanları destekler. */
export function pixelToLatLng(
  px: number,
  py: number,
  size: Size,
  bounds: BBox,
): { lat: number; lng: number } {
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  let lng = bounds.west + (px / size.w) * (east - bounds.west);
  if (lng > 180) lng -= 360;
  const yTop = mercY(Math.min(bounds.north, 85.0511));
  const yBottom = mercY(Math.max(bounds.south, -85.0511));
  const lat = invMercY(yTop + (py / size.h) * (yBottom - yTop));
  return { lat, lng };
}

/** `pixelToLatLng`in tersi (testler ve önizleme için). */
export function latLngToPixel(
  lat: number,
  lng: number,
  size: Size,
  bounds: BBox,
): { x: number; y: number } {
  const east = bounds.east < bounds.west ? bounds.east + 360 : bounds.east;
  let l = lng;
  if (l < bounds.west) l += 360;
  const x = ((l - bounds.west) / (east - bounds.west)) * size.w;
  const yTop = mercY(Math.min(bounds.north, 85.0511));
  const yBottom = mercY(Math.max(bounds.south, -85.0511));
  const y = ((mercY(lat) - yTop) / (yBottom - yTop)) * size.h;
  return { x, y };
}

export const MIN_DRAG_PX = 8;
/** 49 km: çemberin kapsayan kutusu (98×98 km ≈ 9.604 km²) en çok taranabilir alan sınırının (10.000 km²) altında kalır. */
export const MAX_CIRCLE_RADIUS_M = 49_000;
export const MIN_CIRCLE_RADIUS_M = 100;

/**
 * Sürükleme başlangıç/bitiş piksellerinden taslak bölge üretir. Çok kısa sürüklemeler (yanlış tıklama) `null` döner.
 * Daire: başlangıç merkez, bitiş çevre noktasıdır; yarıçap 100 m – 49 km ile sınırlanır.
 */
export function regionFromDrag(
  mode: "rect" | "circle",
  start: { x: number; y: number },
  end: { x: number; y: number },
  size: Size,
  bounds: BBox,
): DraftRegion | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_DRAG_PX) return null;
  const a = pixelToLatLng(start.x, start.y, size, bounds);
  const b = pixelToLatLng(end.x, end.y, size, bounds);
  if (mode === "rect") {
    return {
      kind: "bbox",
      name: "Çizilen alan",
      bbox: {
        south: Math.min(a.lat, b.lat),
        north: Math.max(a.lat, b.lat),
        west: Math.min(a.lng, b.lng),
        east: Math.max(a.lng, b.lng),
      },
    };
  }
  const radiusM = Math.round(
    Math.min(MAX_CIRCLE_RADIUS_M, Math.max(MIN_CIRCLE_RADIUS_M, haversineM(a, b))),
  );
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(rad(a.lat)));
  return {
    kind: "circle",
    name: "Çizilen daire",
    circle: { lat: a.lat, lng: a.lng, radiusM },
    bbox: { south: a.lat - dLat, north: a.lat + dLat, west: a.lng - dLng, east: a.lng + dLng },
  };
}

/**
 * Görünür alandaki noktaların lead kimlikleri ("Görünümdekileri seç"). Kenardakiler dahildir. 180° boylamını aşan
 * görünür alanda (`west > east`) boylam koşulu VEYA ile uygulanır.
 */
export function pointsInBounds(points: readonly (readonly number[])[], b: BBox): number[] {
  const wraps = b.west > b.east;
  const out: number[] = [];
  for (const p of points) {
    const lat = p[1]!;
    const lng = p[2]!;
    if (lat < b.south || lat > b.north) continue;
    if (wraps ? lng < b.west && lng > b.east : lng < b.west || lng > b.east) continue;
    out.push(p[0]!);
  }
  return out;
}

/** Noktaların kapsayan kutusu (boşsa null). */
export function boundsOfPoints(points: readonly (readonly number[])[]): BBox | null {
  if (points.length === 0) return null;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const p of points) {
    south = Math.min(south, p[1]!);
    north = Math.max(north, p[1]!);
    west = Math.min(west, p[2]!);
    east = Math.max(east, p[2]!);
  }
  return { south, west, north, east };
}

/** Harita kamerası (merkez + yakınlaştırma); tarayıcıda `um.explore.camera` anahtarında saklanır. */
export interface Camera {
  lat: number;
  lng: number;
  zoom: number;
}
export const CAMERA_KEY = "um.explore.camera";

/** Saklanan kamera değerini doğrular (bozuk/eski değer null döner; harita varsayılanla açılır). */
export function parseCamera(raw: string | null | undefined): Camera | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Camera>;
    const ok =
      typeof v.lat === "number" &&
      typeof v.lng === "number" &&
      typeof v.zoom === "number" &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng) &&
      Number.isFinite(v.zoom) &&
      Math.abs(v.lat) <= 85.06 &&
      Math.abs(v.lng) <= 180 &&
      v.zoom >= 0 &&
      v.zoom <= 22;
    return ok ? { lat: v.lat!, lng: v.lng!, zoom: v.zoom! } : null;
  } catch {
    return null;
  }
}

export function readCamera(): Camera | null {
  try {
    return parseCamera(localStorage.getItem(CAMERA_KEY));
  } catch {
    return null;
  }
}

export function writeCamera(c: Camera): void {
  try {
    localStorage.setItem(
      CAMERA_KEY,
      JSON.stringify({ lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), zoom: +c.zoom.toFixed(2) }),
    );
  } catch {
    /* depolama kapalı olabilir */
  }
}

/**
 * Nokta durum kodu (bkz. query.ts `queryPoints`): 0 temas yok, 1 gönderildi/kuyrukta, 2 yanıt/müşteri,
 * 3 ilgilenmiyor/iletişime geçme. FR-UI-02: gönderim ve yanıt durumları ayrı işaretçi özellikleriyle gösterilir.
 */
export const CONTACT_PIN_CLASS = [
  "",
  "um-pin--contacted",
  "um-pin--replied",
  "um-pin--stopped",
] as const;

export function pinClassName(statusCode: number | undefined, checked = false): string {
  const c = CONTACT_PIN_CLASS[statusCode ?? 0] ?? "";
  return ["um-pin", c, checked ? "um-pin--checked" : ""].filter(Boolean).join(" ");
}

/** Şematik görünümün hatırlanan merkezi ve ölçeği (bozuksa null). */
export function parseSchematicView(
  raw: string | null,
): { lat: number; lng: number; scale: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { lat?: unknown; lng?: unknown; scale?: unknown };
    if (
      typeof v.lat === "number" &&
      typeof v.lng === "number" &&
      typeof v.scale === "number" &&
      Math.abs(v.lat) <= 90 &&
      Math.abs(v.lng) <= 540 &&
      v.scale >= 0.00005 &&
      v.scale <= 0.5
    )
      return { lat: v.lat, lng: v.lng, scale: v.scale };
  } catch {
    /* bozuk değer */
  }
  return null;
}
