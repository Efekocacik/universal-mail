/**
 * Google `businessStatus` → kalıcı türetilmiş bayraklar (`was_future`, `is_closed`) ve "açıldı" geçişi.
 *
 * Kurallar (Faz 4 hata düzeltmesi; önceden eksik durum "açıldı" sayılıyordu):
 * - Durum GELMEDİYSE (alan maskesinde yok veya yanıtta eksik) hiçbir bayrak değişmez ve geçiş kaydedilmez.
 * - `FUTURE_OPENING` → yakında açılacak; `CLOSED_PERMANENTLY` → kapalı.
 * - "Açıldı" yalnızca önceki kayıt "yakında açılacak" iken durum `OPERATIONAL` görülünce kaydedilir.
 * - `CLOSED_TEMPORARILY`: açılmamış bir yer için belirsizdir; önceki "yakında açılacak" bayrağı KORUNUR ki gerçek açılış
 *   (`OPERATIONAL`) sonradan yakalanabilsin. Açılış sayılmaz.
 */
export interface PlaceFlags {
  wasFuture: boolean;
  isClosed: boolean;
}

export interface StatusFlagsResult extends PlaceFlags {
  /** FUTURE_OPENING → OPERATIONAL geçişi bu gözlemde görüldü. */
  opened: boolean;
  /** Durum gerçekten gözlendi mi (`status_checked_at` yalnızca o zaman güncellenir). */
  observed: boolean;
}

const NO_FLAGS: PlaceFlags = { wasFuture: false, isClosed: false };

export function statusFlags(
  businessStatus: string | null | undefined,
  prev: PlaceFlags | null | undefined,
): StatusFlagsResult {
  const before = prev ?? NO_FLAGS;
  if (!businessStatus) return { ...before, opened: false, observed: false };
  if (businessStatus === "CLOSED_TEMPORARILY")
    return { wasFuture: before.wasFuture, isClosed: false, opened: false, observed: true };
  const wasFuture = businessStatus === "FUTURE_OPENING";
  const isClosed = businessStatus === "CLOSED_PERMANENTLY";
  return {
    wasFuture,
    isClosed,
    opened: before.wasFuture && businessStatus === "OPERATIONAL",
    observed: true,
  };
}
