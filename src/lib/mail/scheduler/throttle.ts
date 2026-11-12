import crypto from "node:crypto";

/**
 * Gönderim hacmi ve aralığı (SRS 4.6). Bu değerler yalnızca kontrollü gönderim içindir; sağlayıcı kurallarını veya
 * filtreleri aşmak için kullanılmaz.
 */

export {
  CONSUMER_GMAIL_MAX_DAILY,
  CONSUMER_GMAIL_MAX_WARMUP_STEP,
  CONSUMER_GMAIL_WARMUP_BASE_PER_DAY,
  effectiveMailboxCap,
  MAX_DAILY_PER_MAILBOX,
  MIN_GAP_S,
  mailboxLimitBounds,
  mailboxLimitProfile,
  nextUtcDayStart,
  WARMUP_BASE_PER_DAY,
  warmupCeiling,
  warmupPreview,
  WEEK_MS,
  type MailboxLimitBounds,
  type MailboxLimitProfile,
  type WarmupPreview,
} from "./limits";
import { MIN_GAP_S } from "./limits";

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
