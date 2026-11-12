/**
 * Gösterge paneli zaman yardımcıları (SAF; `node:` içe aktarımı yok). "Bu hafta" kullanıcının saat dilimindeki
 * Pazartesi 00:00'dan başlar; gönderim sayaçları ise günlük sınırlarla aynı olsun diye UTC gününe göredir.
 */

const DAY_MS = 86_400_000;
const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Geçerli bir IANA saat dilimi mi? (ör. "Europe/Istanbul"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length < 1 || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Sürecin saat dilimi; çözülemezse UTC. */
export function defaultTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function wallClock(ts: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY[get("weekday")] ?? 1,
  };
}

/** Saat dilimindeki duvar saati → UTC anı (yaz saati geçişlerinde iki adımda yakınsar). */
function zonedToUtc(y: number, m: number, d: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const w = wallClock(guess, timeZone);
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess -= asUtc - Date.UTC(y, m - 1, d);
  }
  return guess;
}

/** Saat dilimindeki bu haftanın Pazartesi 00:00 anı (UTC ms). */
export function weekStart(now: number, timeZone: string): number {
  const w = wallClock(now, timeZone);
  const monday = new Date(Date.UTC(w.year, w.month - 1, w.day) - (w.weekday - 1) * DAY_MS);
  return zonedToUtc(
    monday.getUTCFullYear(),
    monday.getUTCMonth() + 1,
    monday.getUTCDate(),
    timeZone,
  );
}

/** Saat dilimindeki bugünün 00:00 anı (UTC ms). */
export function dayStart(now: number, timeZone: string): number {
  const w = wallClock(now, timeZone);
  return zonedToUtc(w.year, w.month, w.day, timeZone);
}

/** UTC ay başlangıcı ve ayın gün sayısı (bütçe ayı `monthKey` ile aynıdır: UTC). */
export function utcMonth(now: number): { start: number; end: number; days: number; key: string } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end, days: Math.round((end - start) / DAY_MS), key: d.toISOString().slice(0, 7) };
}

/**
 * Ay sonu harcama tahmini (doğrusal). Ayın ilk 3 gününde tahmin güvenilir sayılmaz (`reliable: false`); arayüz o
 * zaman tahmini göstermez.
 */
export function projectMonthSpend(
  spentUsd: number,
  now: number,
): { projectedUsd: number; reliable: boolean; elapsedDays: number } {
  const m = utcMonth(now);
  const elapsedDays = Math.max(0, (now - m.start) / DAY_MS);
  const projectedUsd =
    elapsedDays >= 1 ? Math.round((spentUsd / elapsedDays) * m.days * 100) / 100 : spentUsd;
  return { projectedUsd, reliable: elapsedDays >= 3, elapsedDays: Math.floor(elapsedDays) };
}
