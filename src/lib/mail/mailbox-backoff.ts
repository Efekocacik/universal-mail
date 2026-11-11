import { and, eq } from "drizzle-orm";
import { bumpUpdatedAt } from "@/lib/campaigns/errors";
import { DAY_MS } from "@/lib/compliance/frequency";
import { audit } from "@/lib/db/audit";
import type { DbExecutor } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { nextUtcDayStart } from "./scheduler/throttle";

/**
 * Kutu düzeyi gönderim retleri (Gmail kotası, 429, yetki uç noktası/ağ erişilemez, Google 403).
 *
 * Bu retler TEK BİR alıcıya ait değildir: aynı kutudan sıradaki her dizi aynı sonucu alır. Eskiden her biri o dizinin
 * deneme hakkından düşülüyor ve birkaç turda diziler kalıcı `failed` oluyordu (ör. günlük kota dolunca 24 saat
 * boyunca her aralıkta yeni bir dizi yakılıyordu). Artık:
 *  - dizi deneme hakkı TÜKETİLMEDEN önceki durumuna döner ve kutunun bekleme bitişine ertelenir;
 *  - kutu için kalıcı (yeniden başlatmada da geçerli) bir bekleme yazılır; `checkPacing` bitene kadar `mailbox_halted` döndürür;
 *  - kalıcı kutu retlerinde (`forbidden`, `scope_missing`) kutunun çalışan kampanyaları DURAKLATILIR (dizi bozulmaz).
 */

export const MAILBOX_SCOPED_REJECT_CODES: ReadonlySet<string> = new Set([
  "rate_limited",
  "rate_limited_daily",
  "auth_unavailable",
  "network_unreachable",
  "forbidden",
  "scope_missing",
]);

/** Kullanıcı eylemi gerektiren kutu retleri: kutunun çalışan kampanyaları duraklatılır. */
export const MAILBOX_PERMANENT_REJECT_CODES: ReadonlySet<string> = new Set([
  "forbidden",
  "scope_missing",
]);

/** Kutudan son kampanya iletisi `unknown` ise (gidip gitmediği belirsiz) bu süre başka dizi gönderilmez. */
export const RECENT_UNKNOWN_COOLDOWN_MS = 30 * 60_000;

/** Kalıcı kutu retinde dizinin yeniden deneneceği süre (kampanya duraklatıldığı için ancak sürdürülünce gönderilir). */
export const MAILBOX_PERMANENT_DEFER_MS = 30 * 60_000;

const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = DAY_MS;
const DEFAULT_BACKOFF_MS: Record<string, number> = {
  rate_limited: 15 * 60_000,
  auth_unavailable: 10 * 60_000,
  network_unreachable: 10 * 60_000,
};

const clamp = (ms: number) => Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, ms));

/** Geçici kutu retinin bekleme bitişi. Günlük kota: sonraki UTC günü (sağlayıcı daha geç bildirirse o). */
export function mailboxBackoffUntil(
  code: string,
  retryAfterMs: number | undefined,
  now: number,
): number {
  const hint =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? clamp(retryAfterMs)
      : null;
  if (code === "rate_limited_daily") {
    return Math.max(nextUtcDayStart(now), hint === null ? 0 : now + hint);
  }
  return now + (hint ?? clamp(DEFAULT_BACKOFF_MS[code] ?? 15 * 60_000));
}

/** Kutu için süren bekleme (yoksa veya bittiyse null). */
export async function getMailboxBackoff(
  db: DbExecutor,
  mailboxId: number,
  now: number,
): Promise<{ until: number; code: string } | null> {
  const entry = (await getSetting(db, "mail.mailboxSendBackoff"))[String(mailboxId)];
  return entry && entry.until > now ? { until: entry.until, code: entry.code } : null;
}

/**
 * Kutu beklemesini yazar (mevcut bekleme daha geçse o korunur); bitmiş kayıtlar temizlenir. Bekleme uzadıysa denetim
 * kaydı bırakılır (yalnızca kutu kimliği, kod ve bitiş; kişisel veri yok). Etkin bitiş anını döndürür.
 */
export async function extendMailboxBackoff(
  tx: DbExecutor,
  mailboxId: number,
  code: string,
  until: number,
  now: number,
): Promise<number> {
  const all = await getSetting(tx, "mail.mailboxSendBackoff");
  const key = String(mailboxId);
  const prev = all[key];
  if (prev && prev.until >= until) return prev.until;
  const next: typeof all = {};
  for (const [k, v] of Object.entries(all)) if (v.until > now) next[k] = v;
  next[key] = { until, code, at: now };
  await setSetting(tx, "mail.mailboxSendBackoff", next);
  await audit(tx, "mailbox.send_backoff", "mailbox", mailboxId, { code, until }, now);
  return until;
}

/** Kalıcı kutu retinde kutunun çalışan kampanyalarını duraklatır (dizi bozulmaz); duraklatılan sayısını döndürür. */
export async function pauseMailboxCampaigns(
  tx: DbExecutor,
  mailboxId: number,
  code: string,
  now: number,
): Promise<number> {
  const paused = await tx
    .update(campaigns)
    .set({
      status: "paused",
      pausedAt: now,
      pauseReason: `auto:${code}`,
      updatedAt: bumpUpdatedAt(now),
    })
    .where(and(eq(campaigns.mailboxId, mailboxId), eq(campaigns.status, "running")))
    .returning({ id: campaigns.id });
  if (paused.length > 0) {
    await audit(
      tx,
      "mailbox.campaigns_paused",
      "mailbox",
      mailboxId,
      { code, pausedCampaigns: paused.length },
      now,
    );
  }
  return paused.length;
}
