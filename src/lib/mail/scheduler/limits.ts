import { isConsumerGmailAddress } from "../consumer-gmail";

/**
 * Posta kutusu günlük tavan ve ısınma kuralları (SRS 4.6). SAF modül: `node:` içe aktarımı YOKTUR, bu yüzden istemci
 * (Ayarlar → posta kutusu sınırı penceresi) aynı hesaplamayla önizleme gösterebilir. Gönderim tarafı `throttle.ts`
 * üzerinden aynı fonksiyonları kullanır; kural tek yerde yaşar.
 */

const DAY_MS = 86_400_000;

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

/** Kullanıcının ayarlayabileceği alanların sınırları (`PATCH /api/mailboxes/[id]/limits`). */
export interface MailboxLimitBounds {
  /** Günlük tavanın üst sınırı: profilin mutlak tavanı (kişisel Gmail 50, diğerleri 80). */
  maxDailyCap: number;
  /** Haftalık ısınma artışının üst sınırı (kişisel Gmail 5, diğerleri 10). */
  maxWarmupStep: number;
  /** İlk hafta tavanı. */
  warmupBase: number;
}

export function mailboxLimitBounds(mailbox: { address?: string | null }): MailboxLimitBounds {
  const p = mailboxLimitProfile(mailbox);
  return {
    maxDailyCap: Math.min(p.maxDaily, MAX_DAILY_PER_MAILBOX),
    maxWarmupStep: p.maxWarmupStep,
    warmupBase: p.warmupBase,
  };
}

export interface WarmupPreview {
  /** Bugünkü geçerli tavan. */
  today: number;
  /** Bir hafta sonraki geçerli tavan. */
  nextWeek: number;
  /** Kaç tam hafta sonra kutu tavanına ulaşılır (`0` = zaten ulaşıldı; `null` = artış 0, hiç ulaşılmaz). */
  weeksToCap: number | null;
  /** Ulaşılacak tavan: kutu tavanı ile profil üst sınırının küçüğü. */
  target: number;
}

/**
 * Isınma önizlemesi (saf): verilen tavan/artışla bugün, bir hafta sonra ve tavana kaç haftada ulaşılacağı. Isınma
 * başlamamışsa (`warmupStartedAt = null`) ilk gönderimle bugün başlayacağı varsayılır.
 */
export function warmupPreview(
  mailbox: {
    dailyCap: number;
    warmupStep: number;
    warmupStartedAt: number | null;
    address?: string | null;
  },
  now: number,
): WarmupPreview {
  const started = mailbox.warmupStartedAt ?? now;
  const m = { ...mailbox, warmupStartedAt: started };
  const today = effectiveMailboxCap(m, now);
  const nextWeek = effectiveMailboxCap(m, now + WEEK_MS);
  const target = Math.min(mailbox.dailyCap, mailboxLimitBounds(mailbox).maxDailyCap);
  if (today >= target) return { today, nextWeek, weeksToCap: 0, target };
  const profile = mailboxLimitProfile(mailbox);
  const step = Math.min(Math.max(Math.trunc(mailbox.warmupStep), 0), profile.maxWarmupStep);
  if (step === 0) return { today, nextWeek, weeksToCap: null, target };
  const weeksTotal = Math.ceil((target - profile.warmupBase) / step);
  const elapsed = Math.floor(Math.max(0, now - started) / WEEK_MS);
  return { today, nextWeek, weeksToCap: Math.max(1, weeksTotal - elapsed), target };
}

/** Sonraki UTC gününün başlangıcı (günlük sınırlar UTC gününe göredir). */
export function nextUtcDayStart(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

export type LimitsDraftField = "dailyCap" | "warmupStep";
export interface LimitsDraftIssue {
  field: LimitsDraftField;
  code: "not_integer" | "below_min" | "above_max";
  min: number;
  max: number;
}

/**
 * Günlük sınır penceresinin form doğrulaması (saf; istemci ve testler kullanır). Metin girdiyi tam sayıya çevirir ve
 * profil sınırlarını uygular: günlük tavan 1..maxDailyCap, haftalık artış 0..maxWarmupStep. Sunucu aynı sınırları
 * ayrıca denetler; bu yalnızca kullanıcıya erken ve anlaşılır geri bildirim içindir.
 */
export function checkLimitsDraft(
  draft: { dailyCap: string; warmupStep: string },
  bounds: Pick<MailboxLimitBounds, "maxDailyCap" | "maxWarmupStep">,
): { value: { dailyCap: number; warmupStep: number } | null; issues: LimitsDraftIssue[] } {
  const issues: LimitsDraftIssue[] = [];
  const read = (field: LimitsDraftField, raw: string, min: number, max: number): number => {
    const text = raw.trim();
    const n = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(n)) issues.push({ field, code: "not_integer", min, max });
    else if (n < min) issues.push({ field, code: "below_min", min, max });
    else if (n > max) issues.push({ field, code: "above_max", min, max });
    return n;
  };
  const dailyCap = read("dailyCap", draft.dailyCap, 1, bounds.maxDailyCap);
  const warmupStep = read("warmupStep", draft.warmupStep, 0, bounds.maxWarmupStep);
  return { value: issues.length === 0 ? { dailyCap, warmupStep } : null, issues };
}
