import type { SendWindow } from "@/lib/db/schema";

/**
 * Alıcının yerel saatine göre gönderim penceresi (SRS 4.6, FR-CMP-03, NFR-09).
 *
 * - Saat dilimi ülke kodundan bulunur (yalnızca uygulamanın kendi tablosu; Google verisi kullanılmaz).
 * - Birden çok saat dilimli ülkelerde pencere TÜM dilimlerde aynı anda açık olmalıdır (kesişim).
 * - Tabloda olmayan ülkeye gönderim yapılmaz (`null`).
 * - Kampanya penceresi varsayılanı (hafta içi 09.00–17.00) yalnızca daraltabilir.
 * - Resmî tatiller bu sürümde dikkate alınmaz.
 */

export const DEFAULT_SEND_WINDOW: Readonly<{
  days: readonly number[];
  start: string;
  end: string;
}> = Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: "09:00", end: "17:00" });

/** Ülke → IANA saat dilimleri. İlk öğe ana dilimdir; ek öğeler kesişime katılır. */
export const COUNTRY_TIME_ZONES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  AT: ["Europe/Vienna"],
  BE: ["Europe/Brussels"],
  BG: ["Europe/Sofia"],
  CH: ["Europe/Zurich"],
  CY: ["Asia/Nicosia"],
  CZ: ["Europe/Prague"],
  DE: ["Europe/Berlin"],
  DK: ["Europe/Copenhagen"],
  EE: ["Europe/Tallinn"],
  ES: ["Europe/Madrid", "Atlantic/Canary"],
  FI: ["Europe/Helsinki"],
  FR: ["Europe/Paris"],
  GB: ["Europe/London"],
  GR: ["Europe/Athens"],
  HR: ["Europe/Zagreb"],
  HU: ["Europe/Budapest"],
  IE: ["Europe/Dublin"],
  IS: ["Atlantic/Reykjavik"],
  IT: ["Europe/Rome"],
  LI: ["Europe/Vaduz"],
  LT: ["Europe/Vilnius"],
  LU: ["Europe/Luxembourg"],
  LV: ["Europe/Riga"],
  MT: ["Europe/Malta"],
  NL: ["Europe/Amsterdam"],
  NO: ["Europe/Oslo"],
  PL: ["Europe/Warsaw"],
  PT: ["Europe/Lisbon", "Atlantic/Azores"],
  RO: ["Europe/Bucharest"],
  SE: ["Europe/Stockholm"],
  SI: ["Europe/Ljubljana"],
  SK: ["Europe/Bratislava"],
  TR: ["Europe/Istanbul"],
});

export function timeZonesForCountry(
  countryCode: string | null | undefined,
): readonly string[] | null {
  if (!countryCode) return null;
  return COUNTRY_TIME_ZONES[countryCode.trim().toUpperCase()] ?? null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Kampanya penceresini doğrular ve varsayılanla kesiştirir. Geçersizse veya varsayılanın dışına taşıyorsa `null`
 * (pencere yalnızca daraltılabilir).
 */
export function effectiveWindow(
  w: SendWindow | null | undefined,
): { days: ReadonlySet<number>; start: number; end: number } | null {
  if (!w || !Array.isArray(w.days) || w.days.length === 0) return null;
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  const dStart = minutesOf(DEFAULT_SEND_WINDOW.start)!;
  const dEnd = minutesOf(DEFAULT_SEND_WINDOW.end)!;
  if (start === null || end === null || start >= end) return null;
  if (start < dStart || end > dEnd) return null;
  const allowed = new Set(DEFAULT_SEND_WINDOW.days);
  if (!w.days.every((d) => Number.isInteger(d) && allowed.has(d))) return null;
  return { days: new Set(w.days), start, end };
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Verilen anın o saat dilimindeki ISO hafta günü ve gün içi dakikası. */
export function localParts(ts: number, tz: string): { weekday: number; minutes: number } {
  const parts = formatter(tz).formatToParts(ts);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

type Window = NonNullable<ReturnType<typeof effectiveWindow>>;

function openIn(ts: number, w: Window, zones: readonly string[]): boolean {
  return zones.every((tz) => {
    const p = localParts(ts, tz);
    return w.days.has(p.weekday) && p.minutes >= w.start && p.minutes < w.end;
  });
}

export function isInWindow(ts: number, w: Window, zones: readonly string[]): boolean {
  return zones.length > 0 && openIn(ts, w, zones);
}

const STEP_MS = 5 * 60_000;
const SEARCH_LIMIT_MS = 15 * 86_400_000;

/**
 * `ts` anında veya sonrasında pencerenin açık olduğu ilk an. Arama 5 dakikalık adımlarla yapılır; bulunan an en
 * fazla 5 dakika geç olabilir (erken asla). 15 gün içinde açık an yoksa `null`.
 */
export function nextWindowStart(ts: number, w: Window, zones: readonly string[]): number | null {
  if (zones.length === 0) return null;
  if (openIn(ts, w, zones)) return ts;
  let t = Math.ceil(ts / STEP_MS) * STEP_MS;
  for (const limit = ts + SEARCH_LIMIT_MS; t <= limit; t += STEP_MS) {
    if (openIn(t, w, zones)) return t;
  }
  return null;
}
