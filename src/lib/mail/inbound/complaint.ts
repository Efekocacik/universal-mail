import type { CampaignLeadStatus, SequenceStopReason } from "@/lib/db/schema";

/**
 * Şikâyet (ARF) ve durma nedeni gösterimi — Aşama 15.10-2 (TB-1, TB-2).
 *
 * YAZIM (yeni kod): şikâyet satırı `messages.classification = 'complaint'` olur; durdurulan dizi
 * `campaign_leads.stop_reason` alır. GERİ ALMA SÖZLEŞMESİ (0003 geri alma aracı) gereği eski işaretler de AYNI
 * yazımda korunur (çift yazım):
 *  - gelen satırda `error_code = 'arf_complaint'` (doğrulanmış) veya `'arf_complaint:<neden>'` (doğrulanmamış);
 *  - şikâyetle duran/işaretlenen dizide `exclusion_reasons` içinde `"arf_complaint"`.
 *
 * OKUMA: önce sütun; sütun boşsa (0003'ten önce veya 15.10-2'den önceki sürümün yazdığı satırlar) eski işarete düşülür.
 * Bu modül saf ve tek kaynaktır (istemci de kullanır; veritabanı içe aktarmaz). SQL karşılıkları `complaint-sql.ts`'tedir.
 */

/** Gelen ARF satırının eski işareti: doğrulanmış `arf_complaint`, doğrulanmamış `arf_complaint:<neden>`. */
export const ARF_COMPLAINT_CODE = "arf_complaint";
/**
 * TB-11(d): işletmenin BAŞKA bir adresinin doğrulanmış şikâyeti yüzünden durdurulan dizinin ek gerekçe kodu
 * (`arf_complaint` ile birlikte yazılır).
 */
export const BUSINESS_COMPLAINT_CODE = "business_complaint";

export const isArfComplaintCode = (code: string | null | undefined): boolean =>
  !!code && (code === ARF_COMPLAINT_CODE || code.startsWith(`${ARF_COMPLAINT_CODE}:`));

/** Gelen satırın etkin sınıfı: `complaint` sütunu, yoksa `other` + ARF işareti (eski satır) → `complaint`. */
export function effectiveClassification(
  classification: string | null,
  errorCode: string | null | undefined,
): string | null {
  if (classification === "complaint") return "complaint";
  if ((classification === "other" || classification === null) && isArfComplaintCode(errorCode))
    return "complaint";
  return classification;
}

/**
 * Dizinin etkin durma nedeni. `stop_reason` doluysa odur. Boşsa yalnızca `unsubscribed` durumunda eski gösterime
 * düşülür: `"arf_complaint"` işareti → şikâyet, aksi halde çıkış. Diğer durumlarda (ör. hiç durmamış) null.
 */
export function effectiveStopReason(
  status: CampaignLeadStatus,
  stopReason: SequenceStopReason | null | undefined,
  exclusionReasons: readonly string[] | null | undefined,
): SequenceStopReason | null {
  if (stopReason === "unsubscribe" || stopReason === "complaint") return stopReason;
  if (status !== "unsubscribed") return null;
  return exclusionReasons?.includes(ARF_COMPLAINT_CODE) ? "complaint" : "unsubscribe";
}
