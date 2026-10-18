import type { BBox, FieldProfile, ScanQuery, SearchStrategy, SkuId } from "@/lib/domain/types";
import {
  bboxAreaKm2,
  bboxCircumCircle,
  bboxIntersectsCircle,
  bboxSizeKm,
  gridCells,
  isValidBBox,
} from "@/lib/geo/bbox";
import { clamp, round } from "@/lib/util";
import { marginalCostUsd, SKU_PRICING } from "@/lib/places/pricing";

export const MAX_AREA_KM2 = 10_000;
export const MIN_AREA_KM2 = 0.05;
export const MAX_UNITS = 6000;
export const MAX_DEPTH = 4;
export const MIN_CELL_KM = 0.25;
const TARGET_CELLS = 36;

export interface PlanUnit {
  bbox: BBox;
  kind: SearchStrategy;
  termKind: "type" | "keyword";
  /** Tür aramalarında Table A türü; Nearby grubunda virgülle ayrılmış türler; anahtar kelimede kelimenin kendisi. */
  term: string;
  depth: number;
}

export interface PlanInput {
  bbox: BBox;
  circle?: { lat: number; lng: number; radiusM: number };
  queries: ScanQuery[];
  strategy: SearchStrategy;
  fieldProfile: FieldProfile;
}

export class PlanError extends Error {}

/** Bölge büyüklüğüne göre başlangıç hücre boyutu (km). Yoğun bölgeler çalışma sırasında ayrıca bölünür. */
export function chooseCellKm(bbox: BBox): number {
  const area = bboxAreaKm2(bbox);
  return round(clamp(Math.sqrt(area / TARGET_CELLS), 1.5, 10), 2);
}

export function validatePlanInput(input: PlanInput): void {
  if (!isValidBBox(input.bbox)) throw new PlanError("Tarama alanı geçersiz.");
  const area = bboxAreaKm2(input.bbox);
  if (area < MIN_AREA_KM2) throw new PlanError("Tarama alanı çok küçük.");
  if (area > MAX_AREA_KM2) {
    throw new PlanError(
      `Tarama alanı çok büyük (${Math.round(area).toLocaleString("tr-TR")} km²). En fazla ${MAX_AREA_KM2.toLocaleString("tr-TR")} km² (yaklaşık 100×100 km) taranabilir; alanı küçültün veya parçalara bölün.`,
    );
  }
  if (input.queries.length === 0) throw new PlanError("En az bir kategori veya anahtar kelime seçin.");
}

/**
 * Sorgu birimleri: Text Search'te her (tür | anahtar kelime) ayrı birimdir. Nearby stratejisinde tüm
 * türler tek birimde gruplanır (Nearby birden çok türü tek çağrıda kabul eder); anahtar kelimeler
 * Nearby'de aranamadığından yine Text Search birimi olur.
 */
export function queryTerms(queries: ScanQuery[], strategy: SearchStrategy): { kind: SearchStrategy; termKind: "type" | "keyword"; term: string }[] {
  const types = queries.filter((q) => q.kind === "type").map((q) => q.term);
  const keywords = queries.filter((q) => q.kind === "keyword").map((q) => q.term);
  const out: { kind: SearchStrategy; termKind: "type" | "keyword"; term: string }[] = [];
  if (strategy === "nearby") {
    for (let i = 0; i < types.length; i += 50) {
      out.push({ kind: "nearby", termKind: "type", term: types.slice(i, i + 50).join(",") });
    }
  } else {
    for (const t of types) out.push({ kind: "text", termKind: "type", term: t });
  }
  for (const k of keywords) out.push({ kind: "text", termKind: "keyword", term: k });
  return out;
}

export function planCells(input: PlanInput): { cells: BBox[]; cellKm: number } {
  const cellKm = chooseCellKm(input.bbox);
  let cells = gridCells(input.bbox, cellKm);
  if (input.circle) {
    const circle = input.circle;
    cells = cells.filter((c) => bboxIntersectsCircle(c, circle));
  }
  return { cells, cellKm };
}

export function planUnits(input: PlanInput): { units: PlanUnit[]; cellKm: number; cells: number } {
  validatePlanInput(input);
  const { cells, cellKm } = planCells(input);
  const terms = queryTerms(input.queries, input.strategy);
  const units: PlanUnit[] = [];
  for (const cell of cells) {
    for (const t of terms) units.push({ bbox: cell, depth: 0, ...t });
  }
  if (units.length > MAX_UNITS) {
    throw new PlanError(
      `Bu tarama ${units.length.toLocaleString("tr-TR")} sorgu birimi gerektiriyor (en fazla ${MAX_UNITS.toLocaleString("tr-TR")}). Alanı veya kategori sayısını azaltın.`,
    );
  }
  return { units, cellKm, cells: cells.length };
}

export interface RangeEstimate {
  low: number;
  expected: number;
  high: number;
}

export interface ScanEstimate {
  areaKm2: number;
  cellKm: number;
  cells: number;
  units: number;
  queries: number;
  sku: SkuId;
  calls: RangeEstimate;
  costUsd: RangeEstimate;
  /** Bu ay bu SKU için şimdiye dek yapılan çağrı. */
  monthCallsSoFar: number;
  freeCallsLeft: number;
  /** Çalışma sırasında bu sayıyı aşarsa tarama güvenlik gereği duraklatılır. */
  maxCalls: number;
  notes: string[];
}

export function skuForScan(strategy: SearchStrategy, fieldProfile: FieldProfile, termKind: "type" | "keyword" = "type"): SkuId {
  const text = strategy === "text" || termKind === "keyword";
  if (fieldProfile === "enrich") return text ? "text_search_enterprise" : "nearby_search_enterprise";
  return text ? "text_search_pro" : "nearby_search_pro";
}

/**
 * Tarama öncesi tahmin (FR-DIS-05). Gerçek çağrı sayısı; sonuç sayfalarına, yoğun bölgelerin ek bölünmesine
 * ve tekrarlayan kayıtlara bağlıdır. Bu yüzden tek sayı yerine aralık verilir.
 */
export function estimateScan(
  input: PlanInput,
  usage: { monthCallsBySku: Partial<Record<SkuId, number>> },
): ScanEstimate {
  const { units, cellKm, cells } = planUnits(input);
  const textUnits = units.filter((u) => u.kind === "text").length;
  const nearbyUnits = units.length - textUnits;

  // Sayfa/bölünme çarpanları: düşük = hiç bölünme ve tek sayfa; yüksek = yoğun bölgede iki seviye bölünme ve üç sayfa.
  const calls = {
    low: textUnits * 1 + nearbyUnits * 1,
    expected: Math.ceil(textUnits * 1.7 * 1.5 + nearbyUnits * 1.4),
    high: Math.ceil(textUnits * 3 * 4 + nearbyUnits * 4),
  };

  const sku = skuForScan(input.strategy, input.fieldProfile);
  const before = usage.monthCallsBySku[sku] ?? 0;
  const cost = (n: number) => round(marginalCostUsd(sku, before, n), 2);
  const freeLeft = Math.max(0, SKU_PRICING[sku].freeMonthly - before);

  const notes: string[] = [];
  if (input.fieldProfile === "enrich") {
    notes.push("Zenginleştirme açık: web sitesi, telefon ve değerlendirme sayısı da istenir (Enterprise, daha pahalı).");
  }
  if (calls.high > calls.expected * 2.5) {
    notes.push("Yoğun şehir merkezlerinde alanlar otomatik bölündüğü için gerçek kullanım yüksek tahmine yaklaşabilir.");
  }
  if (input.strategy === "nearby") {
    notes.push("Nearby Search çağrı başına en fazla 20 sonuç döner; yoğun bölgelerde daha çok bölünme gerekir.");
  }

  return {
    areaKm2: round(bboxAreaKm2(input.bbox), 1),
    cellKm,
    cells,
    units: units.length,
    queries: input.queries.length,
    sku,
    calls,
    costUsd: { low: cost(calls.low), expected: cost(calls.expected), high: cost(calls.high) },
    monthCallsSoFar: before,
    freeCallsLeft: freeLeft,
    maxCalls: Math.max(50, Math.ceil(calls.high * 1.25)),
    notes,
  };
}

/** Doygun bir birim daha fazla bölünebilir mi? */
export function canSubdivide(unit: { bbox: BBox; depth: number; kind: SearchStrategy }): boolean {
  if (unit.depth >= MAX_DEPTH) return false;
  const { widthKm, heightKm } = bboxSizeKm(unit.bbox);
  if (Math.min(widthKm, heightKm) / 2 < MIN_CELL_KM) return false;
  if (unit.kind === "nearby") {
    return bboxCircumCircle(unit.bbox).radiusM > 100;
  }
  return true;
}
