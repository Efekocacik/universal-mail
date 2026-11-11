import crypto from "node:crypto";
import { DAY_MS } from "@/lib/compliance/frequency";

/**
 * Gönderim hacmi ve aralığı (SRS 4.6). Bu değerler yalnızca kontrollü gönderim içindir; sağlayıcı kurallarını veya
 * filtreleri aşmak için kullanılmaz.
 */

/** Isınma başlangıcı: posta kutusu başına günlük en fazla 20. */
export const WARMUP_BASE_PER_DAY = 20;
/** Varsayılan üst sınır: günde 80 (veritabanı kısıtı da 80). */
export const MAX_DAILY_PER_MAILBOX = 80;
/** Gönderimler arası bekleme alt sınırı (veritabanı kısıtı da 90 s). */
export const MIN_GAP_S = 90;
export const WEEK_MS = 7 * DAY_MS;

/**
 * Isınma tavanı: `20 + warmup_step × geçen tam hafta`, en fazla 80. Isınma henüz başlamadıysa 20. Bu yalnızca bir
 * TAVANDIR: artış otomatik yapılmaz, kullanıcı posta kutusunun `daily_cap` değerini yükseltmedikçe sınır değişmez.
 */
export function warmupCeiling(
  mailbox: { warmupStep: number; warmupStartedAt: number | null },
  now: number,
): number {
  const step = Number.isInteger(mailbox.warmupStep)
    ? Math.min(Math.max(mailbox.warmupStep, 0), 10)
    : 0;
  if (mailbox.warmupStartedAt === null || now < mailbox.warmupStartedAt) return WARMUP_BASE_PER_DAY;
  const weeks = Math.floor((now - mailbox.warmupStartedAt) / WEEK_MS);
  return Math.min(MAX_DAILY_PER_MAILBOX, WARMUP_BASE_PER_DAY + step * weeks);
}

/** Posta kutusunun bugünkü geçerli tavanı: kutu tavanı, ısınma tavanı ve mutlak üst sınırın en küçüğü. */
export function effectiveMailboxCap(
  mailbox: { dailyCap: number; warmupStep: number; warmupStartedAt: number | null },
  now: number,
): number {
  return Math.max(
    0,
    Math.min(mailbox.dailyCap, warmupCeiling(mailbox, now), MAX_DAILY_PER_MAILBOX),
  );
}

/**
 * Bir iletiden sonra aynı kutudan sonraki gönderime kadar beklenecek süre (ms). Değer [min, max] aralığında
 * rastgele görünür ama ileti kimliğinden DETERMİNİSTİK türetilir: yeniden başlatma sonrasında da aynı bekleme
 * hesaplanır, kısalmaz.
 */
export function gapMs(seed: number, minS: number, maxS: number): number {
  const lo = Math.max(MIN_GAP_S, Math.floor(minS));
  const hi = Math.max(lo, Math.floor(maxS));
  const x = crypto.createHash("sha256").update(`um-gap:${seed}`).digest().readUInt32BE(0);
  return (lo + (x % (hi - lo + 1))) * 1000;
}

/** Sonraki UTC gününün başlangıcı (günlük sınırlar UTC gününe göredir). */
export function nextUtcDayStart(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}
