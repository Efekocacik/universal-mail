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
