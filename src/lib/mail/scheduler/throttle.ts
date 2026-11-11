import crypto from "node:crypto";
import { DAY_MS } from "@/lib/compliance/frequency";
import { isConsumerGmailAddress } from "../consumer-gmail";

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
 * KİŞİSEL GMAIL (`@gmail.com`, `@googlemail.com`): Google'ın günlük sınırı Workspace'ten çok düşüktür (yaklaşık 500
 * alıcı/gün; yeni hesaplarda çok daha az) ve kişisel hesaptan toplu B2B gönderim hesabın kısıtlanmasına yol açabilir.
 * Bu yüzden ısınma 10'dan başlar, haftalık artış en çok 5'tir ve kutu tavanı ne olursa olsun günde en çok 50 iletiye
 * izin verilir (Workspace: 20'den başlar, en çok 80).
 */
export const CONSUMER_GMAIL_WARMUP_BASE_PER_DAY = 10;
export const CONSUMER_GMAIL_MAX_WARMUP_STEP = 5;
export const CONSUMER_GMAIL_MAX_DAILY = 50;

export interface MailboxLimitProfile {
  kind: "consumer_gmail" | "standard";
  /** Isınmanın ilk haftasındaki günlük tavan. */
  warmupBase: number;
  /** Haftalık artışın üst sınırı. */
  maxWarmupStep: number;
  /** Mutlak günlük üst sınır (kutu tavanı daha yüksek olsa bile). */
  maxDaily: number;
}

const STANDARD_PROFILE: MailboxLimitProfile = Object.freeze({
  kind: "standard",
  warmupBase: WARMUP_BASE_PER_DAY,
  maxWarmupStep: 10,
  maxDaily: MAX_DAILY_PER_MAILBOX,
});
const CONSUMER_GMAIL_PROFILE: MailboxLimitProfile = Object.freeze({
  kind: "consumer_gmail",
  warmupBase: CONSUMER_GMAIL_WARMUP_BASE_PER_DAY,
  maxWarmupStep: CONSUMER_GMAIL_MAX_WARMUP_STEP,
  maxDaily: CONSUMER_GMAIL_MAX_DAILY,
});

/** Kutunun sınır profili: adres kişisel Gmail ise daha sıkı profil. */
export function mailboxLimitProfile(mailbox: { address?: string | null }): MailboxLimitProfile {
  return isConsumerGmailAddress(mailbox.address) ? CONSUMER_GMAIL_PROFILE : STANDARD_PROFILE;
}

/**
 * Isınma tavanı: `taban + warmup_step × geçen tam hafta`, en fazla profilin üst sınırı (Workspace/standart: 20 + en
 * çok 10/hafta, en fazla 80; kişisel Gmail: 10 + en çok 5/hafta, en fazla 50). Isınma henüz başlamadıysa taban. Bu
 * yalnızca bir TAVANDIR: artış otomatik yapılmaz, kullanıcı posta kutusunun `daily_cap` değerini yükseltmedikçe sınır
 * değişmez.
 */
export function warmupCeiling(
  mailbox: { warmupStep: number; warmupStartedAt: number | null; address?: string | null },
  now: number,
): number {
  const profile = mailboxLimitProfile(mailbox);
  const step = Number.isInteger(mailbox.warmupStep)
    ? Math.min(Math.max(mailbox.warmupStep, 0), profile.maxWarmupStep)
    : 0;
  if (mailbox.warmupStartedAt === null || now < mailbox.warmupStartedAt) return profile.warmupBase;
  const weeks = Math.floor((now - mailbox.warmupStartedAt) / WEEK_MS);
  return Math.min(profile.maxDaily, profile.warmupBase + step * weeks);
}

/** Posta kutusunun bugünkü geçerli tavanı: kutu tavanı, ısınma tavanı ve mutlak üst sınırın en küçüğü. */
export function effectiveMailboxCap(
  mailbox: {
    dailyCap: number;
    warmupStep: number;
    warmupStartedAt: number | null;
    address?: string | null;
  },
  now: number,
): number {
  return Math.max(
    0,
    Math.min(
      mailbox.dailyCap,
      warmupCeiling(mailbox, now),
      mailboxLimitProfile(mailbox).maxDaily,
      MAX_DAILY_PER_MAILBOX,
    ),
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
