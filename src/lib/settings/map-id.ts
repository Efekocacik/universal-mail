import { z } from "zod";

/**
 * Google Maps "Map ID" (vektör harita / bulut tabanlı stil kimliği) doğrulaması.
 *
 * Google Cloud Console'da üretilen kimlikler kısa, boşluksuz, ASCII harf-rakam dizileridir (çoğunlukla 16 haneli onaltılık,
 * ör. `8e0a97af9386fef`; geliştirme için `DEMO_MAP_ID`). Hata kaynağı: alana e-posta adresi veya rastgele metin
 * yazılabiliyordu ve harita bu değeri Google'a gönderiyordu. Kural bilerek biraz geniştir (harf, rakam, `_`, `-`; en çok
 * 64 karakter) ki Google ileride biçimi değiştirirse geçerli kimlikler reddedilmesin; `@`, `.`, boşluk, `/` gibi
 * karakterler (e-posta, URL, cümle) kesinlikle reddedilir. Boş dize "temizle" anlamına gelir (demo kimliğine dönülür).
 */
export const MAP_ID_MAX = 64;
const MAP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Kayıtlı/girilen değeri karşılaştırma ve saklama için normalleştirir (yalnızca baş/son boşluk kırpılır). */
export const normalizeMapId = (raw: string): string => raw.trim();

/** Normalleştirilmiş değer geçerli bir Map ID mi (boş = geçerli, "temizle")? */
export function isValidMapId(value: string): boolean {
  return value === "" || (value.length <= MAP_ID_MAX && MAP_ID_RE.test(value));
}

/** Kullanıcıya gösterilecek ret nedeni kodu (arayüz yerelleştirir); geçerliyse `null`. */
export function mapIdProblem(raw: string): "too_long" | "email" | "invalid" | null {
  const v = normalizeMapId(raw);
  if (isValidMapId(v)) return null;
  if (v.length > MAP_ID_MAX) return "too_long";
  if (v.includes("@")) return "email";
  return "invalid";
}

/**
 * Ayar şeması: kırpılmış ve doğrulanmış değer. Okumada geçersiz eski bir değer (ör. önceden kaydedilmiş e-posta)
 * `getSetting`'in güvenli ayrıştırma geri dönüşüyle varsayılana ("") düşer; harita demo kimliğini kullanır.
 */
export const mapIdSchema = z.string().max(200).transform(normalizeMapId).refine(isValidMapId, {
  message:
    "Geçersiz Map ID: yalnızca harf, rakam, '_' ve '-' içerebilir (en çok 64 karakter); e-posta veya adres olamaz.",
});

/** /api/config'in tarayıcıya verdiği kimlik: geçerli kayıtlı değer, yoksa Google'ın demo kimliği. */
export const DEMO_MAP_ID = "DEMO_MAP_ID";
export function effectiveMapId(stored: unknown): string {
  const v = typeof stored === "string" ? normalizeMapId(stored) : "";
  return v && isValidMapId(v) ? v : DEMO_MAP_ID;
}
