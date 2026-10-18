import type { BBox, LatLng } from "@/lib/domain/types";

const KM_PER_DEG_LAT = 111.32;
const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function kmPerDegLng(lat: number): number {
  return KM_PER_DEG_LAT * Math.cos(toRad(lat));
}

export function isValidBBox(b: BBox): boolean {
  return (
    [b.south, b.west, b.north, b.east].every(Number.isFinite) &&
    b.south >= -90 &&
    b.north <= 90 &&
    b.west >= -180 &&
    b.east <= 180 &&
    b.south < b.north &&
    b.west < b.east
  );
}

export function bboxCenter(b: BBox): LatLng {
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}

export function bboxSizeKm(b: BBox): { widthKm: number; heightKm: number } {
  const mid = (b.south + b.north) / 2;
  return {
    widthKm: (b.east - b.west) * kmPerDegLng(mid),
    heightKm: (b.north - b.south) * KM_PER_DEG_LAT,
  };
}

export function bboxAreaKm2(b: BBox): number {
  const { widthKm, heightKm } = bboxSizeKm(b);
  return widthKm * heightKm;
}

/** Merkez ve yarı kenar uzunluğundan (km) kare kutu üretir. */
export function bboxFromCenter(lat: number, lng: number, halfSideKm: number): BBox {
  const dLat = halfSideKm / KM_PER_DEG_LAT;
  const dLng = halfSideKm / kmPerDegLng(lat);
  return {
    south: Math.max(-90, lat - dLat),
    north: Math.min(90, lat + dLat),
    west: Math.max(-180, lng - dLng),
    east: Math.min(180, lng + dLng),
  };
}

export function circleToBBox(lat: number, lng: number, radiusM: number): BBox {
  return bboxFromCenter(lat, lng, radiusM / 1000);
}

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Kutuyu tamamen kapsayan en küçük daire (Nearby Search için). */
export function bboxCircumCircle(b: BBox): { lat: number; lng: number; radiusM: number } {
  const c = bboxCenter(b);
  const radiusM = Math.max(
    haversineM(c, { lat: b.south, lng: b.west }),
    haversineM(c, { lat: b.north, lng: b.east }),
  );
  return { ...c, radiusM: Math.ceil(radiusM) };
}

/** Kutuyu dört eşit parçaya böler: [güneybatı, güneydoğu, kuzeybatı, kuzeydoğu]. */
export function splitBBox(b: BBox): [BBox, BBox, BBox, BBox] {
  const c = bboxCenter(b);
  return [
    { south: b.south, west: b.west, north: c.lat, east: c.lng },
    { south: b.south, west: c.lng, north: c.lat, east: b.east },
    { south: c.lat, west: b.west, north: b.north, east: c.lng },
    { south: c.lat, west: c.lng, north: b.north, east: b.east },
  ];
}

/** Kutuyu yaklaşık `cellKm` kenarlı hücrelere böler (satır satır, güneyden kuzeye). */
export function gridCells(b: BBox, cellKm: number): BBox[] {
  const { widthKm, heightKm } = bboxSizeKm(b);
  // Kayan nokta hatası (4,0000001 → 5 hücre) yüzünden gereksiz satır/sütun oluşmasın diye toleranslı yuvarlama.
  const cols = Math.max(1, Math.ceil(widthKm / cellKm - 1e-6));
  const rows = Math.max(1, Math.ceil(heightKm / cellKm - 1e-6));
  const dLat = (b.north - b.south) / rows;
  const dLng = (b.east - b.west) / cols;
  const cells: BBox[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        south: b.south + r * dLat,
        north: b.south + (r + 1) * dLat,
        west: b.west + c * dLng,
        east: b.west + (c + 1) * dLng,
      });
    }
  }
  return cells;
}

export function pointInBBox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

/** Hücrenin daireyle kesişip kesişmediğini yaklaşık olarak denetler (en yakın nokta yöntemi). */
export function bboxIntersectsCircle(
  b: BBox,
  circle: { lat: number; lng: number; radiusM: number },
): boolean {
  const nearest: LatLng = {
    lat: Math.min(Math.max(circle.lat, b.south), b.north),
    lng: Math.min(Math.max(circle.lng, b.west), b.east),
  };
  return haversineM(nearest, { lat: circle.lat, lng: circle.lng }) <= circle.radiusM;
}

export function roundBBox(b: BBox, digits = 5): BBox {
  const f = 10 ** digits;
  const r = (v: number) => Math.round(v * f) / f;
  return { south: r(b.south), west: r(b.west), north: r(b.north), east: r(b.east) };
}
