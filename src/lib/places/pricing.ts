import type { SkuId } from "@/lib/domain/types";

/**
 * Google Maps Platform liste fiyatları (USD / 1.000 çağrı). Kaynak: Google fiyat sayfası,
 * Ekim 2026. Fiyatlar değişebilir; canlı kullanımdan önce doğrulayın. Uygulamadaki rakamlar
 * TAHMİNDİR, kesin fatura Google Cloud hesabındaki tutardır.
 *
 * `upTo` değerleri AYLIK KÜMÜLATİF çağrı sayısıdır (ücretsiz kısım dahil). Kesin olarak bilinen
 * ilk iki dilim dışındaki dilimler için son bilinen fiyat korunmuştur (temkinli yaklaşım).
 */
export const PRICING_VERIFIED_AT = "2026-10-18";

export interface PriceBand {
  upTo: number;
  perThousandUsd: number;
}

export interface SkuPricing {
  label: string;
  freeMonthly: number;
  bands: PriceBand[];
}

const INF = Number.POSITIVE_INFINITY;

export const SKU_PRICING: Readonly<Record<SkuId, SkuPricing>> = {
  text_search_ids: {
    label: "Text Search (yalnızca ID)",
    freeMonthly: INF,
    bands: [{ upTo: INF, perThousandUsd: 0 }],
  },
  text_search_pro: {
    label: "Text Search Pro",
    freeMonthly: 5000,
    bands: [
      { upTo: 100_000, perThousandUsd: 32 },
      { upTo: 500_000, perThousandUsd: 25.6 },
      { upTo: 1_000_000, perThousandUsd: 19.2 },
      { upTo: 5_000_000, perThousandUsd: 9.6 },
      { upTo: INF, perThousandUsd: 2.4 },
    ],
  },
  text_search_enterprise: {
    label: "Text Search Enterprise",
    freeMonthly: 1000,
    bands: [
      { upTo: 100_000, perThousandUsd: 35 },
      { upTo: 500_000, perThousandUsd: 28 },
      { upTo: 1_000_000, perThousandUsd: 21 },
      { upTo: 5_000_000, perThousandUsd: 10.5 },
      { upTo: INF, perThousandUsd: 2.63 },
    ],
  },
  nearby_search_pro: {
    label: "Nearby Search Pro",
    freeMonthly: 5000,
    bands: [
      { upTo: 100_000, perThousandUsd: 32 },
      { upTo: 500_000, perThousandUsd: 25.6 },
      { upTo: 1_000_000, perThousandUsd: 19.2 },
      { upTo: 5_000_000, perThousandUsd: 9.6 },
      { upTo: INF, perThousandUsd: 2.4 },
    ],
  },
  nearby_search_enterprise: {
    label: "Nearby Search Enterprise",
    freeMonthly: 1000,
    bands: [
      { upTo: 100_000, perThousandUsd: 35 },
      { upTo: 500_000, perThousandUsd: 28 },
      { upTo: 1_000_000, perThousandUsd: 21 },
      { upTo: 5_000_000, perThousandUsd: 10.5 },
      { upTo: INF, perThousandUsd: 2.63 },
    ],
  },
  place_details_essentials: {
    label: "Place Details Essentials",
    freeMonthly: 10_000,
    bands: [
      { upTo: 100_000, perThousandUsd: 5 },
      { upTo: INF, perThousandUsd: 4 },
    ],
  },
  place_details_pro: {
    label: "Place Details Pro",
    freeMonthly: 5000,
    bands: [
      { upTo: 100_000, perThousandUsd: 17 },
      { upTo: INF, perThousandUsd: 13.6 },
    ],
  },
  place_details_enterprise: {
    label: "Place Details Enterprise",
    freeMonthly: 1000,
    bands: [
      { upTo: 100_000, perThousandUsd: 20 },
      { upTo: INF, perThousandUsd: 16 },
    ],
  },
};

export function skuLabel(sku: string): string {
  return SKU_PRICING[sku as SkuId]?.label ?? sku;
}

/**
 * Ay içinde `before` çağrı yapılmışken, `count` çağrı daha yapılırsa doğacak EK maliyet (USD).
 * Ücretsiz kota ve kademeli fiyatlar hesaba katılır.
 */
export function marginalCostUsd(sku: SkuId, before: number, count: number): number {
  if (count <= 0) return 0;
  const pricing = SKU_PRICING[sku];
  const start = before; // (start, end] aralığındaki çağrılar
  const end = before + count;
  let cost = 0;
  let bandStart = pricing.freeMonthly; // ücretsiz kısım sıfır maliyetli
  for (const band of pricing.bands) {
    const lo = Math.max(start, bandStart);
    const hi = Math.min(end, band.upTo);
    if (hi > lo) cost += ((hi - lo) / 1000) * band.perThousandUsd;
    bandStart = Math.max(bandStart, band.upTo);
    if (bandStart >= end) break;
  }
  return cost;
}
