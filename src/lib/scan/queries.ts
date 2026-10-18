import type { BBox, ScanQuery, SearchStrategy } from "@/lib/domain/types";
import { roundBBox } from "@/lib/geo/bbox";
import { sha1, stableStringify } from "@/lib/util";

export interface CategoryLike {
  key: string;
  placeTypes: string[];
  keywords: string[];
}

const TYPE_RE = /^[a-z][a-z0-9_]{1,60}$/;

export function isValidPlaceType(type: string): boolean {
  return TYPE_RE.test(type);
}

/** Seçilen kategorilerden ve serbest anahtar kelimelerden yinelenmeyen sorgu listesi üretir. */
export function buildQueries(
  categories: CategoryLike[],
  customKeywords: string[] = [],
): ScanQuery[] {
  const seen = new Set<string>();
  const out: ScanQuery[] = [];
  const add = (q: ScanQuery) => {
    const id = `${q.kind}:${q.term.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(q);
  };
  for (const c of categories) {
    for (const t of c.placeTypes)
      if (isValidPlaceType(t)) add({ kind: "type", term: t, categoryKey: c.key });
    for (const k of c.keywords)
      if (k.trim()) add({ kind: "keyword", term: k.trim(), categoryKey: c.key });
  }
  for (const k of customKeywords) if (k.trim()) add({ kind: "keyword", term: k.trim() });
  return out;
}

/**
 * Bir sonucun hangi kategori aramasından geldiğini bulur. Kategori, Google'ın türü değil BİZİM etiketimizdir.
 * Nearby gruplarında (birden çok tür tek birimde) sonucun türü, kategori türlerinden biriyle eşleştirilir.
 */
export function categoryKeyFor(
  queries: ScanQuery[],
  unit: { kind: "text" | "nearby"; termKind: "type" | "keyword"; term: string },
  record: { primaryType?: string; types: string[] },
): string | null {
  if (unit.kind === "nearby") {
    for (const q of queries) {
      if (q.kind === "type" && (record.primaryType === q.term || record.types.includes(q.term)))
        return q.categoryKey ?? null;
    }
    return null;
  }
  const hit = queries.find(
    (q) => q.kind === unit.termKind && q.term.toLowerCase() === unit.term.toLowerCase(),
  );
  return hit?.categoryKey ?? null;
}

export interface ScanKeyInput {
  bbox: BBox;
  circle?: { lat: number; lng: number; radiusM: number };
  queries: ScanQuery[];
  strategy: SearchStrategy;
}

/**
 * Karşılaştırılabilir taramaları aynı anahtarla eşler: aynı bölge, aynı sorgular, aynı strateji.
 * Kapsam değişirse (kategori, sınır) anahtar değişir ve snapshot karşılaştırması yapılmaz (SRS 4.2).
 */
export function computeScanKey(input: ScanKeyInput): string {
  return sha1(
    stableStringify({
      bbox: roundBBox(input.bbox, 4),
      circle: input.circle
        ? {
            lat: Math.round(input.circle.lat * 1e4) / 1e4,
            lng: Math.round(input.circle.lng * 1e4) / 1e4,
            r: Math.round(input.circle.radiusM),
          }
        : null,
      queries: input.queries.map((q) => `${q.kind}:${q.term.toLowerCase()}`).sort(),
      strategy: input.strategy,
    }),
  );
}
