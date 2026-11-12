import type { DashboardMailboxQueue, DashboardScheduleItem } from "@/lib/client/dashboard";
import { intlLocale, type Locale } from "@/lib/i18n";

/**
 * Gösterge panelinin saf görünüm mantığı (DOM'suz test edilir): Keşif bağlantıları, posta kutusu satırının durumu,
 * bütçe tonu ve göreli zaman metni.
 */

export type ExploreLifecycle = "new" | "opened" | "future";

/**
 * Keşif'e süzgeçli bağlantı. `lifecycle` ve `detectedSince` (epoch ms) parametrelerini Keşif sayfası (Paket C)
 * okur; bağlantı yalnızca adres üretir, hiçbir şey değiştirmez.
 */
export function exploreLink(lifecycle: ExploreLifecycle, detectedSince?: number): string {
  const q = new URLSearchParams({ lifecycle });
  if (detectedSince !== undefined && Number.isSafeInteger(detectedSince) && detectedSince > 0) {
    q.set("detectedSince", String(detectedSince));
  }
  return `/?${q.toString()}`;
}

export type QueueState =
  | { kind: "reauth" }
  | { kind: "backoff"; until: number }
  | { kind: "capReached"; until: number | null }
  | { kind: "due"; n: number }
  | { kind: "next"; at: number }
  | { kind: "idle" };

/** Satırın tek cümlelik durumu; öncelik: yeniden bağlanma > geçici bekleme > tavan doldu > sırada > planlı > boş. */
export function queueState(m: DashboardMailboxQueue, now: number): QueueState {
  if (m.reauthorizationRequired) return { kind: "reauth" };
  if (m.backoff && m.backoff.until > now) return { kind: "backoff", until: m.backoff.until };
  if (m.capReached && m.waiting > 0) return { kind: "capReached", until: m.nextSendAt };
  if (m.dueNow > 0) return { kind: "due", n: m.dueNow };
  if (m.nextSendAt !== null && m.waiting > 0) return { kind: "next", at: m.nextSendAt };
  return { kind: "idle" };
}

/** Günlük kullanım yüzdesi (tavan 0 ise 0). */
export function usagePct(used: number, cap: number): number {
  return cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
}

export function budgetTone(level: "ok" | "warning" | "blocked"): "primary" | "warning" | "danger" {
  return level === "blocked" ? "danger" : level === "warning" ? "warning" : "primary";
}

/** Planlı tarama satırının durumu: zamanı geçmiş, son çalışması atlanmış veya olağan. */
export function scheduleState(s: DashboardScheduleItem): "overdue" | "skipped" | "ok" {
  if (s.overdue) return "overdue";
  if (s.lastOutcome === "skipped") return "skipped";
  return "ok";
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 saat sonra", "dün", "şimdi" gibi göreli zaman (dakika altı: şimdi). */
export function relativeTime(at: number, now: number, locale: Locale): string {
  const diff = at - now;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, "minute");
}

/** Kısa saat ("09:30") — sınırın sıfırlanma saatini kullanıcının saatinde göstermek için. */
/** UTC gününün başlangıcı (posta kutusu günlük sınır sayacının sıfırlandığı an). */
export function utcDayStart(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

export function clockTime(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(
    new Date(at),
  );
}

export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(n);
}

export function formatUsd(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
