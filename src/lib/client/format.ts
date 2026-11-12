import { countryName } from "@/lib/geo/countries";
import { getLocale, intlLocale, t, type Locale, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Sayı, para, tarih ve etiket biçimlendirme. Etkin arayüz diline göre çalışır (Faz 4, 10a-3): biçimlendiriciler dil
 * başına bir kez kurulur ve önbelleğe alınır; dil değişince bir sonraki çağrı yeni dili kullanır.
 */
interface Formatters {
  nf: Intl.NumberFormat;
  usd: Intl.NumberFormat;
  usdSmall: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
  monthYear: Intl.DateTimeFormat;
  relative: Intl.RelativeTimeFormat;
}

const cache = new Map<Locale, Formatters>();

function fmt(locale: Locale = getLocale()): Formatters {
  let f = cache.get(locale);
  if (!f) {
    const tag = intlLocale(locale);
    f = {
      nf: new Intl.NumberFormat(tag),
      usd: new Intl.NumberFormat(tag, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      usdSmall: new Intl.NumberFormat(tag, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
      date: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
      dateTime: new Intl.DateTimeFormat(tag, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
      monthYear: new Intl.DateTimeFormat(tag, { month: "long", year: "numeric" }),
      relative: new Intl.RelativeTimeFormat(tag, { numeric: "auto" }),
    };
    cache.set(locale, f);
  }
  return f;
}

export const fmtNumber = (n: number): string => fmt().nf.format(n);
export const fmtUsd = (n: number): string =>
  n > 0 && n < 0.1 ? fmt().usdSmall.format(n) : fmt().usd.format(n);
export const fmtDate = (ms: number | null | undefined): string =>
  ms ? fmt().date.format(new Date(ms)) : "—";
export const fmtDateTime = (ms: number | null | undefined): string =>
  ms ? fmt().dateTime.format(new Date(ms)) : "—";

/** Gün cinsinden göreli zaman: "bugün", "dün", "3 gün önce" / "today", "yesterday", "3 days ago". */
export function fmtRelativeDays(ms: number, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000));
  return fmt().relative.format(-days, "day");
}

/** Dakika/saat/gün ölçeğinde göreli zaman (bildirimler gibi yakın olaylar için). */
export function fmtRelativeTime(ms: number, now: number = Date.now()): string {
  const sec = Math.round((ms - now) / 1000);
  const abs = Math.abs(sec);
  const r = fmt().relative;
  if (abs < 60) return r.format(0, "minute");
  if (abs < 3600) return r.format(Math.round(sec / 60), "minute");
  if (abs < 86_400) return r.format(Math.round(sec / 3600), "hour");
  return r.format(Math.round(sec / 86_400), "day");
}

/** "2027-03-01" / "2027-03" / "2027" → okunur tarih. */
export function fmtOpeningDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  if (!m) return String(y);
  if (!d) return fmt().monthYear.format(new Date(y, m - 1, 1));
  return fmt().date.format(new Date(y, m - 1, d));
}

const hasKey = (key: string): key is TrKey => Object.prototype.hasOwnProperty.call(tr, key);

/** Google işletme türü → yerelleştirilmiş etiket; bilinmeyen tür okunur biçime çevrilir ("dog_cafe" → "dog cafe"). */
export function typeLabel(type: string | null | undefined): string {
  if (!type) return "";
  const key = `placeType.${type}`;
  return hasKey(key) ? t(key) : type.replace(/_/g, " ");
}

/** Kategori seti adı: sunucu `key` ve (Türkçe) `name` gönderir; arayüz anahtara göre yerelleştirir. */
export function categoryLabel(key: string | null | undefined, fallback = ""): string {
  if (!key) return fallback;
  const k = `category.${key}`;
  return hasKey(k) ? t(k) : fallback || key;
}

/** Yenilik gerekçesi: sinyal kimliğine göre yerelleştirilir; tanınmayan kimlikte saklanan metin gösterilir. */
export function noveltySignalText(
  id: string,
  storedReason: string,
  params: { days?: number } = {},
): string {
  const k = `noveltySignal.${id}`;
  if (!hasKey(k)) return storedReason;
  return t(k, params.days !== undefined ? { days: params.days } : undefined);
}

export function countryLabel(code: string | null | undefined): string {
  return code ? countryName(code, getLocale()) : "";
}

export const NOVELTY_ORDER = ["future_opening", "high", "likely", "low"] as const;
