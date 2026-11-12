import { en } from "./en";
import { enOne } from "./en/plurals";
import { tr, type TrKey } from "./tr";

export type { TrKey } from "./tr";

/**
 * Arayüz metni ve dil çalışma zamanı (NFR-09). Türkçe birincil dildir; İngilizce `en.ts`'te KISMİ olabilir ve eksik
 * anahtar Türkçeye, o da yoksa anahtarın kendisine düşer. Kullanılan her anahtarın sözlükte bulunduğu ve İngilizce
 * kapsamı `tests/i18n.test.ts` ile denetlenir.
 *
 * Etkin dil süreç içinde TEK bir değerdir (tarayıcıda kullanıcının seçimi). SUNUCU tarafında istekler arasında paylaşılan
 * bu değere güvenilmez: sunucu kodu (bildirim metni, e-posta, API) dili `t(key, params, locale)` ile AÇIKÇA verir.
 */
export type Locale = "tr" | "en";
export const LOCALES: readonly Locale[] = ["tr", "en"];
export const DEFAULT_LOCALE: Locale = "tr";

export const isLocale = (v: unknown): v is Locale => v === "tr" || v === "en";

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(l: Locale) => void>();

export function getLocale(): Locale {
  return current;
}

/** Etkin dili değiştirir (geçersiz değer yok sayılır) ve dinleyicileri bilgilendirir. */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  for (const l of listeners) l(locale);
}

/** Dil değişimini dinler (ör. React `useSyncExternalStore`); aboneliği kaldıran işlev döner. */
export function onLocaleChange(listener: (l: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `Intl` biçimlendiricileri için BCP 47 etiketi. */
export function intlLocale(locale: Locale = current): "tr-TR" | "en-GB" {
  return locale === "en" ? "en-GB" : "tr-TR";
}

/** Anahtarın verilen dilde gerçekten çevrisi var mı (Türkçeye düşme hariç)? */
export function hasTranslation(key: TrKey, locale: Locale): boolean {
  // `en` türü tamdır; çalışma zamanında sözlük dışı bir dize (ör. sunucudan gelen kod) gelebileceği için yine denetlenir.
  return locale === "tr" ? key in tr : (en as Partial<Record<TrKey, string>>)[key] !== undefined;
}

const EN_PLURAL = new Intl.PluralRules("en");

/**
 * `{n}` İngilizcede tekil mi? Çağıranlar sayıyı çoğu zaman biçimlenmiş dize olarak verir (`fmtNumber(1)` → "1");
 * binlik ayırıcılar atılıp sayıya çevrilir. Sayı değilse (ör. "—") çoğul kalır.
 */
function isEnglishOne(v: string | number | undefined): boolean {
  if (v === undefined) return false;
  const num = typeof v === "number" ? v : Number(String(v).replace(/[,\s\u00a0\u202f]/g, ""));
  return String(v).trim() !== "" && Number.isFinite(num) && EN_PLURAL.select(num) === "one";
}

export function t(key: TrKey, params?: Record<string, string | number>, locale?: Locale): string {
  const lang = locale ?? current;
  // İngilizce tekil/çoğul (`en/plurals.ts`): Türkçede isim sayıdan sonra tekil kaldığı için yalnızca İngilizcede.
  const one = lang === "en" && isEnglishOne(params?.n) ? enOne[key] : undefined;
  const enText = lang === "en" ? (one ?? (en as Partial<Record<TrKey, string>>)[key]) : undefined;
  let text: string = enText ?? tr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
