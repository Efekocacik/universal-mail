import type { IntroModel } from "./types";

/**
 * Claude fiyatları (USD / 1M belirteç; claude-api başvurusu, 2026-11). Maliyet notu ve satır başına tahmin buradan
 * hesaplanır. Fiyat değişirse yalnızca bu tablo güncellenir.
 *
 * Sunucu tarafı yedek (fallback) başka bir modelde yanıt verirse o modelin fiyatı bilinmeyebilir; bu durumda TUTUCU
 * (daha yüksek) Opus-4.x fiyatı kullanılır, maliyet hiçbir zaman eksik gösterilmez.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  demo: { inputPerMTok: 0, outputPerMTok: 0 },
};

/** Bilinmeyen (ör. yedek) model için tutucu fiyat. */
export const CONSERVATIVE_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[model] ?? CONSERVATIVE_PRICE;
}

/** Kullanım → tahmini USD (6 basamağa yuvarlanmış; negatif/NaN belirteç 0 sayılır). */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  const i = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const o = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return Math.round(((i * p.inputPerMTok + o * p.outputPerMTok) / 1_000_000) * 1e6) / 1e6;
}

/**
 * Maliyet notundaki "giriş başına yaklaşık" tutar. Varsayım: ~1.300 giriş belirteci (talimat + en çok 3.000 karakter
 * site metni) ve ~400 çıkış belirteci (düşük çaba düşünme + 1–2 cümle).
 */
export const TYPICAL_INPUT_TOKENS = 1300;
export const TYPICAL_OUTPUT_TOKENS = 400;

export function typicalIntroCostUsd(model: IntroModel): number {
  return estimateCostUsd(model, TYPICAL_INPUT_TOKENS, TYPICAL_OUTPUT_TOKENS);
}

/**
 * Açıkken model değişikliği yeni maliyet onayı ister mi? Yalnızca giriş başına tipik maliyet ARTIYORSA (ör. Haiku →
 * Opus, ~40 kat). Ucuz modele geçiş onaysız kaydedilir. Ayarlar kartı ve testler bunu kullanır (saf; istemci de alır).
 */
export function modelChangeNeedsCostAck(from: IntroModel, to: IntroModel): boolean {
  return typicalIntroCostUsd(to) > typicalIntroCostUsd(from);
}
