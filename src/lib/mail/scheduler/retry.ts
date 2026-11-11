/**
 * Kesin ret (`rejected`) sonrası yeniden deneme politikası (NFR-04).
 *
 * - Kalıcı ret ASLA yeniden denenmez.
 * - Geçici ret: adım başına toplam en fazla 3 deneme; denemeler arası 15 dakika, sonra 2 saat.
 * - Sağlayıcı bir bekleme süresi bildirirse (ör. 429) ondan önce denenmez (en fazla 24 saat dikkate alınır).
 * - `unknown`, `sending` ve `sent` hiçbir koşulda yeniden gönderilmez; bu modül yalnızca `rejected` içindir.
 */

export const MAX_ATTEMPTS_PER_STEP = 3;
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([15 * 60_000, 2 * 3_600_000]);
export const MAX_RETRY_AFTER_MS = 24 * 3_600_000;

/**
 * `failedAttempts`: bu adımın şimdiye kadarki başarısız deneme sayısı (az önceki dahil). Yeniden deneme yoksa
 * `null`, varsa bekleme süresi (ms).
 */
export function retryDelayMs(
  failedAttempts: number,
  permanent: boolean,
  retryAfterMs?: number,
): number | null {
  if (permanent) return null;
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) return null;
  if (failedAttempts >= MAX_ATTEMPTS_PER_STEP) return null;
  const base = RETRY_BACKOFF_MS[failedAttempts - 1] ?? RETRY_BACKOFF_MS.at(-1)!;
  const hint =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
      : 0;
  return Math.max(base, hint);
}
