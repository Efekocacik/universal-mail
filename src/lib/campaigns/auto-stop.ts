import { and, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaigns, messages, settings } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { bumpUpdatedAt } from "./errors";

/**
 * Demo otomatik durdurma (Aşama 13, SRS 4.6: yüksek teslim edilememe oranında gönderimi duraklat).
 *
 * BİRİM: ALICI. Pay ve payda aynı kampanyadaki FARKLI alıcılardır (alıcı özeti `peer_hash`); bir alıcıya kaç takip
 * gittiği veya kaç bounce iletisi geldiği oranı değiştirmez.
 *  - Payda: kampanya iletisi (`purpose=campaign`) en az bir kez KABUL EDİLMİŞ (`status=sent`) farklı alıcılar.
 *  - Pay  : bu alıcılardan, tam doğrulanmış (kanıt katmanları L1-L4 veya insan onayı) adres-yok sınıfında kalıcı
 *           bounce'u bulunanlar (`delivery_status=bounced_hard`; bu alan YALNIZCA doğrulanmış bounce'ta yazılır).
 *  - Koşul: payda >= asgari alıcı VE pay >= 2 VE pay/payda >= asgari oran (tamsayı karşılaştırma, baz puan).
 *
 * SIKILAŞTIRMA = durdurmanın DAHA KOLAY tetiklenmesi: asgari alıcı sayısı ve oran yalnızca DÜŞÜRÜLEBİLİR (alt sınır
 * 10 alıcı, %1). Doğrulanmış bounce sayısı 2'de SABİTTİR (tek ileti kampanyayı durduramasın). Gevşetme ve geri
 * gevşetme yasaktır. Kayıtlı değer varsayılandan gevşekse okurken varsayılana sıkıştırılır.
 */

const AUTO_STOP_SETTING = "mail.autoStop";
export const AUTO_STOP_MIN_BOUNCES = 2;
export const AUTO_STOP_DEFAULTS = { minRecipients: 20, minRateBp: 500 } as const;
export const AUTO_STOP_FLOORS = { minRecipients: 10, minRateBp: 100 } as const;
export const AUTO_PAUSE_REASON = "auto_bounce_rate";

export interface AutoStopConfig {
  minRecipients: number;
  minBounces: number;
  minRateBp: number;
}

export type AutoStopErrorKind =
  "invalid_input" | "live_locked" | "loosening_forbidden" | "below_floor";

export class AutoStopError extends Error {
  constructor(
    readonly kind: AutoStopErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Etkin eşikler: kayıtlı değer, varsayılandan gevşek veya alt sınırın altındaysa sınırlara çekilir. */
export async function getAutoStopConfig(db: DbExecutor): Promise<AutoStopConfig> {
  const s = await getSetting(db, "mail.autoStop");
  return {
    minRecipients: clamp(
      Number.isFinite(s.minRecipients)
        ? Math.trunc(s.minRecipients)
        : AUTO_STOP_DEFAULTS.minRecipients,
      AUTO_STOP_FLOORS.minRecipients,
      AUTO_STOP_DEFAULTS.minRecipients,
    ),
    minBounces: AUTO_STOP_MIN_BOUNCES,
    minRateBp: clamp(
      Number.isFinite(s.minRateBp) ? Math.trunc(s.minRateBp) : AUTO_STOP_DEFAULTS.minRateBp,
      AUTO_STOP_FLOORS.minRateBp,
      AUTO_STOP_DEFAULTS.minRateBp,
    ),
  };
}

export interface TightenInput {
  scope: string;
  minRecipients?: number;
  minBounces?: number;
  minRateBp?: number;
}

/** Eşikleri SIKILAŞTIRIR. Eşit değer sorunsuz kabul edilir; gevşetme, alt sınır altı ve canlı kapsam reddedilir. */
export async function tightenAutoStop(
  db: Db,
  input: TightenInput,
  now = Date.now(),
): Promise<AutoStopConfig> {
  if (input.scope !== "demo") {
    throw new AutoStopError("live_locked", "Otomatik durdurma yalnızca demo kapsamında ayarlanır.");
  }
  const { minRecipients, minBounces, minRateBp } = input;
  if (minRecipients === undefined && minBounces === undefined && minRateBp === undefined) {
    throw new AutoStopError("invalid_input", "Değiştirilecek bir eşik belirtilmedi.");
  }
  for (const v of [minRecipients, minBounces, minRateBp]) {
    if (v !== undefined && (!Number.isInteger(v) || !Number.isFinite(v))) {
      throw new AutoStopError("invalid_input", "Eşikler tam sayı olmalıdır.");
    }
  }

  return db.transaction(async (tx) => {
    const cur = await getAutoStopConfig(tx);
    let nextRecipients = cur.minRecipients;
    let nextRate = cur.minRateBp;

    if (minBounces !== undefined && minBounces !== AUTO_STOP_MIN_BOUNCES) {
      throw new AutoStopError(
        minBounces > AUTO_STOP_MIN_BOUNCES ? "loosening_forbidden" : "below_floor",
        minBounces > AUTO_STOP_MIN_BOUNCES
          ? "Doğrulanmış bounce sayısı artırılamaz (gevşetme)."
          : "Doğrulanmış bounce sayısı 2'nin altına indirilemez; tek ileti kampanyayı durdurmamalıdır.",
      );
    }
    if (minRecipients !== undefined) {
      if (minRecipients > cur.minRecipients) {
        throw new AutoStopError(
          "loosening_forbidden",
          "Asgari alıcı sayısı artırılamaz (gevşetme).",
        );
      }
      if (minRecipients < AUTO_STOP_FLOORS.minRecipients) {
        throw new AutoStopError(
          "below_floor",
          `Asgari alıcı sayısı ${AUTO_STOP_FLOORS.minRecipients}'un altına inemez.`,
        );
      }
      nextRecipients = minRecipients;
    }
    if (minRateBp !== undefined) {
      if (minRateBp > cur.minRateBp) {
        throw new AutoStopError(
          "loosening_forbidden",
          "Asgari bounce oranı artırılamaz (gevşetme).",
        );
      }
      if (minRateBp < AUTO_STOP_FLOORS.minRateBp) {
        throw new AutoStopError("below_floor", "Asgari bounce oranı %1'in altına inemez.");
      }
      nextRate = minRateBp;
    }

    if (nextRecipients === cur.minRecipients && nextRate === cur.minRateBp) return cur;
    const now0 = now;
    const value = { minRecipients: nextRecipients, minRateBp: nextRate };
    await tx
      .insert(settings)
      .values({ key: AUTO_STOP_SETTING, value, updatedAt: now0 })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now0 } });
    await audit(
      tx,
      "autostop.tightened",
      "setting",
      "mail.autoStop",
      {
        fromRecipients: cur.minRecipients,
        toRecipients: nextRecipients,
        fromRateBp: cur.minRateBp,
        toRateBp: nextRate,
      },
      now0,
    );
    return {
      minRecipients: nextRecipients,
      minBounces: AUTO_STOP_MIN_BOUNCES,
      minRateBp: nextRate,
    };
  });
}

export interface BounceStats {
  /** Payda: kabul edilmiş kampanya iletisi olan farklı alıcılar. */
  recipients: number;
  /** Pay: doğrulanmış kalıcı bounce'lu farklı alıcılar. */
  bounced: number;
}

export async function computeBounceStats(db: DbExecutor, campaignId: number): Promise<BounceStats> {
  const [row] = await db
    .select({
      recipients: sql<number>`count(distinct ${messages.peerHash})`,
      bounced: sql<number>`count(distinct case when ${messages.deliveryStatus} = 'bounced_hard' then ${messages.peerHash} end)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.campaignId, campaignId),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        eq(messages.status, "sent"),
      ),
    );
  return { recipients: Number(row?.recipients ?? 0), bounced: Number(row?.bounced ?? 0) };
}

/** Saf karar: üç koşul birlikte. Oran, tamsayı baz puanla karşılaştırılır (kayan nokta yok). */
export function shouldAutoPause(stats: BounceStats, cfg: AutoStopConfig): boolean {
  return (
    stats.recipients >= cfg.minRecipients &&
    stats.bounced >= cfg.minBounces &&
    stats.bounced * 10_000 >= cfg.minRateBp * stats.recipients
  );
}

/**
 * Çalışan kampanyayı koşul sağlanıyorsa duraklatır (aynı işlem içinde; audit kaydıyla). Duraklatma geri alınabilir:
 * kullanıcı kampanyayı elle devam ettirir. Yalnızca `running` kampanya etkilenir.
 */
export async function autoPauseIfNeeded(
  tx: DbExecutor,
  campaignId: number,
  now: number,
): Promise<boolean> {
  const cfg = await getAutoStopConfig(tx);
  const stats = await computeBounceStats(tx, campaignId);
  if (!shouldAutoPause(stats, cfg)) return false;
  const rows = await tx
    .update(campaigns)
    .set({
      status: "paused",
      pausedAt: now,
      pauseReason: AUTO_PAUSE_REASON,
      updatedAt: bumpUpdatedAt(now),
    })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "running")))
    .returning({ id: campaigns.id });
  if (rows.length !== 1) return false;
  await audit(
    tx,
    "campaign.auto_paused",
    "campaign",
    campaignId,
    {
      reason: AUTO_PAUSE_REASON,
      recipients: stats.recipients,
      bounced: stats.bounced,
      minRecipients: cfg.minRecipients,
      minBounces: cfg.minBounces,
      minRateBp: cfg.minRateBp,
    },
    now,
  );
  return true;
}
