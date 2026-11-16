import type { Db } from "@/lib/db/client";
import {
  countLeadIds,
  queryFacets,
  queryLeadIds,
  queryLeads,
  queryPoints,
  type LeadFilters,
  type LeadSort,
} from "@/lib/leads/query";

/**
 * Faz 6 (paket G, NFR-03): 100k lead üzerinde ölçülen sorgu durumları. `tests/perf-100k.test.ts` ve `npm run bench`
 * (`scripts/bench.mts`) AYNI listeyi kullanır; yeni bir Keşfet süzgeci eklenince buraya da eklenir.
 *
 * Değerler `seed-leads.ts`'nin ürettiği veriye göredir (8 şehir, 7 tür, iki tarama).
 */

export interface PerfCase {
  name: string;
  run: (db: Db) => Promise<unknown>;
}

export interface PerfContext {
  /** `seedLeads` sonucu: ikinci taramanın kimliği (`scanId` süzgeci). */
  scanId: number;
  /** Zaman tabanı (`detectedSince`). */
  now: number;
  /** Toplu seçim için gerçek lead kimlikleri (≤ 2000). */
  ids: number[];
}

const DAY = 86_400_000;
export const LONDON_BBOX = { south: 51.4, west: -0.3, north: 51.6, east: 0.1 };
export const PERF_SORTS: LeadSort[] = ["novelty", "name", "recent"];
const PAGE = 80;

/** Tek tek her süzgeç (her biri üç sırayla ölçülür). */
export function singleFilters(ctx: PerfContext): [string, LeadFilters][] {
  return [
    ["süzgeçsiz", {}],
    ["q (metin)", { q: "Kafe 12" }],
    ["ülke", { countries: ["GB"] }],
    ["şehir", { city: "London" }],
    ["kategori", { categories: ["cafe"] }],
    ["yenilik", { novelty: ["future_opening", "high"] }],
    ["lead durumu", { leadStatus: ["new"] }],
    ["işletme durumu", { businessStatus: ["FUTURE_OPENING"] }],
    ["kaynak", { source: ["registry", "import"] }],
    ["sicil eşleşti", { registryMatch: true }],
    ["sicil eşleşmedi", { registryMatch: false }],
    ["harita kutusu", { bbox: LONDON_BBOX }],
    ["web sitesi var", { hasWebsite: true }],
    ["web sitesi yok", { hasWebsite: false }],
    ["değerlendirme aralığı", { ratingMin: 50, ratingMax: 300 }],
    ["tarama", { scanId: ctx.scanId }],
    ["e-posta durumu", { emailStatus: ["generic", "found_verified"] }],
    ["son taramada yok", { notFound: true }],
    ["son taramada var", { notFound: false }],
    ["arşiv görünümü", { archived: true }],
    ["seçili kimlikler (2000)", { ids: ctx.ids }],
    ["yaşam döngüsü: açıldı", { lifecycle: ["opened"] }],
    ["yaşam döngüsü: yakında", { lifecycle: ["future"] }],
    ["yaşam döngüsü: yeni", { lifecycle: ["new"] }],
    ["tespit tarihi", { detectedSince: ctx.now - 14 * DAY }],
  ];
}

/** Temsilî çoklu süzgeç birleşimleri (varsayılan sırayla). */
export function comboFilters(ctx: PerfContext): [string, LeadFilters][] {
  return [
    ["ülke + yenilik", { countries: ["GB"], novelty: ["future_opening", "high"] }],
    ["şehir + kategori + durum", { city: "London", categories: ["cafe"], leadStatus: ["new"] }],
    ["kaynak + sicil eşleşti", { source: ["google"], registryMatch: true }],
    ["kaynak + sicil eşleşmedi", { source: ["google", "demo"], registryMatch: false }],
    ["e-posta durumu + web sitesi", { emailStatus: ["generic"], hasWebsite: true }],
    [
      "yaşam döngüsü + tespit tarihi",
      { lifecycle: ["opened", "new"], detectedSince: ctx.now - 14 * DAY },
    ],
    ["harita kutusu + yenilik", { bbox: LONDON_BBOX, novelty: ["high", "likely"] }],
    ["q + ülke", { q: "Kafe 1", countries: ["FR"] }],
    ["arşiv + ülke", { archived: true, countries: ["DE"] }],
    ["tarama + yenilik", { scanId: ctx.scanId, novelty: ["low"] }],
    ["son taramada yok + şehir", { notFound: true, city: "Paris" }],
    [
      "tüm süzgeçler birden",
      {
        q: "Kafe",
        countries: ["GB"],
        city: "London",
        categories: ["cafe", "pub"],
        novelty: ["high", "likely", "low"],
        leadStatus: ["new", "enriched"],
        businessStatus: ["OPERATIONAL"],
        source: ["google", "demo"],
        registryMatch: false,
        bbox: LONDON_BBOX,
        hasWebsite: false,
        scanId: ctx.scanId,
        emailStatus: ["unchecked", "generic", "not_found"],
        notFound: false,
        lifecycle: ["new", "future", "opened"],
        detectedSince: ctx.now - 60 * DAY,
      },
    ],
  ];
}

/** Ölçülecek tüm durumlar (liste satırları + toplam; derin sayfa; facet; harita; toplu seçim). */
export function perfCases(ctx: PerfContext): PerfCase[] {
  const cases: PerfCase[] = [];
  for (const [label, f] of singleFilters(ctx)) {
    for (const sort of PERF_SORTS) {
      cases.push({
        name: `liste [${label}] sıra=${sort}`,
        run: (db) => queryLeads(db, f, { sort, limit: PAGE }),
      });
    }
  }
  for (const [label, f] of comboFilters(ctx)) {
    cases.push({ name: `liste [${label}]`, run: (db) => queryLeads(db, f, { limit: PAGE }) });
  }
  cases.push(
    {
      name: "liste derin sayfa (offset 50.000)",
      run: (db) => queryLeads(db, {}, { limit: PAGE, offset: 50_000 }),
    },
    {
      name: "liste derin sayfa (offset 50.000) sıra=name",
      run: (db) => queryLeads(db, {}, { sort: "name", limit: PAGE, offset: 50_000 }),
    },
  );
  const facetFilters: [string, LeadFilters][] = [
    ...singleFilters(ctx).filter(([l]) => l !== "seçili kimlikler (2000)"),
    ...comboFilters(ctx),
  ];
  for (const [label, f] of facetFilters) {
    cases.push({ name: `facet [${label}]`, run: (db) => queryFacets(db, f) });
  }
  cases.push(
    { name: "harita noktaları [süzgeçsiz]", run: (db) => queryPoints(db, {}) },
    {
      name: "harita noktaları [harita kutusu]",
      run: (db) => queryPoints(db, { bbox: LONDON_BBOX }),
    },
    {
      name: "harita noktaları [ülke + yenilik]",
      run: (db) => queryPoints(db, { countries: ["GB"], novelty: ["high"] }),
    },
    { name: "toplu seçim sayısı [süzgeçsiz]", run: (db) => countLeadIds(db, {}) },
    { name: "toplu seçim kimlikleri [süzgeçsiz]", run: (db) => queryLeadIds(db, {}) },
    {
      name: "toplu seçim sayısı [ülke + e-posta]",
      run: (db) => countLeadIds(db, { countries: ["GB"], emailStatus: ["generic"] }),
    },
    {
      name: "toplu seçim kimlikleri [ülke + e-posta]",
      run: (db) => queryLeadIds(db, { countries: ["GB"], emailStatus: ["generic"] }),
    },
  );
  return cases;
}

/** Ortanca süre (ms): bir ısınma çalıştırması, sonra `runs` ölçüm. */
export async function medianMs(fn: () => Promise<unknown>, runs = 3): Promise<number> {
  await fn();
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    await fn();
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}
