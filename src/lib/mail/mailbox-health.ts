import { and, eq, gte, lte, sql } from "drizzle-orm";
import { AutoStopError } from "@/lib/campaigns/auto-stop";
import { bumpUpdatedAt } from "@/lib/campaigns/errors";
import { DAY_MS } from "@/lib/compliance/frequency";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaigns, messages, settings, suppressions } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";

/**
 * Posta kutusu düzeyi gönderim sağlığı (SRS 5.6.1: "bounce oranı %3'ü veya şikâyet oranı %0,1'i aşarsa yeni
 * gönderimler durdurulur ve kullanıcı uyarılır"). Kampanya düzeyindeki otomatik durdurmadan (campaigns/auto-stop)
 * AYRIDIR: kapsam bütün kampanyalar birlikte, tek posta kutusudur.
 *
 * BİRİM: ALICI (`peer_hash`). Pencere: son 30 gün; bir alıcı, pencerede kabul edilmiş (`sent`) en az bir kampanya
 * iletisi aldıysa paydaya girer. Bounce, GİDEN İLETİNİN gönderim tarihine atfedilir (geç gelen DSN oranı düşürmez).
 * Alıcı kaç takip alırsa, kaç kampanyada bulunursa, kaç ileti bounce olursa olsun BİR kez sayılır. Pay: doğrulanmış
 * (`delivery_status=bounced_hard`; yalnızca tam kanıtlı veya insan onaylı bounce'ta yazılır) kalıcı bounce'lu alıcılar.
 *
 * SINIR: "aşarsa" = KESİN BÜYÜKTÜR. Tamsayı baz puanla: `bounce × 10000 > eşik_bp × alıcı`. Tam %3,00'da durdurulmaz.
 *
 * YETERLİ VERİ (varsayılan 50 alıcı) yalnızca istatistiksel yeterlilik GÖSTERGESİDİR; küçük örneklemde ciddi sorunu
 * görmezden gelmez: örneklem < 50 ise ve oran eşiğin üzerindeyse, en az `guardBounces` (varsayılan 3) farklı
 * doğrulanmış bounce'lu alıcı "küçük örneklem freni"ni tetikler. Ayrıca adres düzeyinde anında suppression ve kampanya
 * düzeyinde otomatik durdurma zaten çalışır.
 *
 * ŞİKÂYET: Bu sürümde sağlayıcıdan şikâyet verisi YOKTUR. %0,1 kuralı "ölçülemiyor" olarak gösterilir; elle girilen
 * şikâyet kayıtları posta kutusuna bağlanamadığından orana KATILMAZ ve doğrulanmış sayılmaz.
 *
 * Eşikler yalnızca SIKILAŞTIRILABİLİR (durdurmayı kolaylaştırma yönünde); geri gevşetme yoktur.
 */

export const MAILBOX_WINDOW_DAYS = 30;
export const MAILBOX_WINDOW_MS = MAILBOX_WINDOW_DAYS * DAY_MS;
export const MAILBOX_DEFAULTS = { bounceBp: 300, minRecipients: 50, guardBounces: 3 } as const;
export const MAILBOX_FLOORS = { bounceBp: 100, minRecipients: 20, guardBounces: 2 } as const;
export const COMPLAINT_THRESHOLD_BP = 10; // %0,1 (ölçülemediği için değerlendirilmez)
export const MAILBOX_HALT_REASON = "mailbox_rate_exceeded";

export interface MailboxLimits {
  bounceBp: number;
  minRecipients: number;
  guardBounces: number;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? Math.trunc(v as number) : fallback));

/** Etkin eşikler: kayıtlı değer varsayılandan gevşek veya alt sınırın altındaysa sınırlara çekilir. */
export async function getMailboxLimits(db: DbExecutor): Promise<MailboxLimits> {
  const s = await getSetting(db, "mail.mailboxLimits");
  return {
    bounceBp: clamp(
      s.bounceBp,
      MAILBOX_FLOORS.bounceBp,
      MAILBOX_DEFAULTS.bounceBp,
      MAILBOX_DEFAULTS.bounceBp,
    ),
    minRecipients: clamp(
      s.minRecipients,
      MAILBOX_FLOORS.minRecipients,
      MAILBOX_DEFAULTS.minRecipients,
      MAILBOX_DEFAULTS.minRecipients,
    ),
    guardBounces: clamp(
      s.guardBounces,
      MAILBOX_FLOORS.guardBounces,
      MAILBOX_DEFAULTS.guardBounces,
      MAILBOX_DEFAULTS.guardBounces,
    ),
  };
}

export async function tightenMailboxLimits(
  db: Db,
  input: { scope: string; bounceBp?: number; minRecipients?: number; guardBounces?: number },
  now = Date.now(),
): Promise<MailboxLimits> {
  if (input.scope !== "demo") {
    throw new AutoStopError(
      "live_locked",
      "Posta kutusu eşikleri yalnızca demo kapsamında ayarlanır.",
    );
  }
  const fields = ["bounceBp", "minRecipients", "guardBounces"] as const;
  if (fields.every((f) => input[f] === undefined)) {
    throw new AutoStopError("invalid_input", "Değiştirilecek bir eşik belirtilmedi.");
  }
  for (const f of fields) {
    const v = input[f];
    if (v !== undefined && (!Number.isInteger(v) || !Number.isFinite(v))) {
      throw new AutoStopError("invalid_input", "Eşikler tam sayı olmalıdır.");
    }
  }
  return db.transaction(async (tx) => {
    const cur = await getMailboxLimits(tx);
    const next = { ...cur };
    for (const f of fields) {
      const v = input[f];
      if (v === undefined) continue;
      if (v > cur[f])
        throw new AutoStopError("loosening_forbidden", "Eşikler artırılamaz (gevşetme).");
      if (v < MAILBOX_FLOORS[f]) {
        throw new AutoStopError(
          "below_floor",
          "Eşik izin verilen en düşük değerin altına indirilemez.",
        );
      }
      next[f] = v;
    }
    if (fields.every((f) => next[f] === cur[f])) return cur;
    await tx
      .insert(settings)
      .values({ key: SETTING_LIMITS, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } });
    await audit(tx, "mailbox.limits_tightened", "setting", SETTING_LIMITS, { ...next }, now);
    return next;
  });
}

const SETTING_LIMITS = "mail.mailboxLimits";
const SETTING_HALTS = "mail.mailboxHalts";

export interface MailboxStats {
  /** Pencere içinde kampanya iletisi alan farklı alıcılar. */
  recipients: number;
  /** Bunlardan doğrulanmış kalıcı bounce'lu farklı alıcılar. */
  bounced: number;
}

export async function computeMailboxStats(
  db: DbExecutor,
  mailboxId: number,
  now: number,
): Promise<MailboxStats> {
  const [row] = await db
    .select({
      recipients: sql<number>`count(distinct ${messages.peerHash})`,
      bounced: sql<number>`count(distinct case when ${messages.deliveryStatus} = 'bounced_hard' then ${messages.peerHash} end)`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        eq(messages.status, "sent"),
        gte(messages.sentAt, now - MAILBOX_WINDOW_MS),
        lte(messages.sentAt, now),
      ),
    );
  return { recipients: Number(row?.recipients ?? 0), bounced: Number(row?.bounced ?? 0) };
}

export type MailboxHealthState = "insufficient" | "ok" | "exceeded";
export type MailboxExceedReason = "rate" | "small_sample_guard";

export interface MailboxEvaluation {
  state: MailboxHealthState;
  reason: MailboxExceedReason | null;
  /** Örneklem istatistiksel olarak yeterli mi (yalnızca gösterge)? */
  sufficient: boolean;
  /** Oran eşiğin KESİN üzerinde mi? */
  overThreshold: boolean;
}

/** Saf karar işlevi. */
export function evaluateMailbox(stats: MailboxStats, limits: MailboxLimits): MailboxEvaluation {
  const overThreshold =
    stats.recipients > 0 && stats.bounced * 10_000 > limits.bounceBp * stats.recipients;
  const sufficient = stats.recipients >= limits.minRecipients;
  if (overThreshold && sufficient)
    return { state: "exceeded", reason: "rate", sufficient, overThreshold };
  if (overThreshold && stats.bounced >= limits.guardBounces) {
    return { state: "exceeded", reason: "small_sample_guard", sufficient, overThreshold };
  }
  return { state: sufficient ? "ok" : "insufficient", reason: null, sufficient, overThreshold };
}

export interface HaltRecord {
  at: number;
  recipients: number;
  bounced: number;
  reason: string;
}

export async function getHalts(db: DbExecutor): Promise<Record<string, HaltRecord>> {
  return getSetting(db, SETTING_HALTS);
}

async function writeHalts(db: DbExecutor, halts: Record<string, HaltRecord>, now: number) {
  await db
    .insert(settings)
    .values({ key: SETTING_HALTS, value: halts, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: halts, updatedAt: now } });
}

/**
 * Gönderim kapısı için: posta kutusu durdurulmuş mu YA DA oran şu anda eşiği aşıyor mu? Durumsuz kontrol, eşzamanlı
 * bir turun yeni bounce'u kaçırmasını önler.
 */
export async function mailboxSendBlock(
  db: DbExecutor,
  mailboxId: number,
  now: number,
): Promise<{ blocked: boolean; reason: "halted" | "rate" | "small_sample_guard" | null }> {
  const halts = await getHalts(db);
  if (halts[String(mailboxId)]) return { blocked: true, reason: "halted" };
  const ev = evaluateMailbox(
    await computeMailboxStats(db, mailboxId, now),
    await getMailboxLimits(db),
  );
  return ev.state === "exceeded"
    ? { blocked: true, reason: ev.reason }
    : { blocked: false, reason: null };
}

/**
 * Eşik aşıldıysa kutuyu durdurur: aynı işlemde durdurma kaydı yazar, kutudaki çalışan kampanyaları duraklatır ve
 * denetim kaydı bırakır. Daha önce durdurulmuşsa yeniden yazmaz. Durdurulduysa `true` döner.
 */
export async function enforceMailboxHealth(
  tx: DbExecutor,
  mailboxId: number,
  now: number,
): Promise<boolean> {
  const stats = await computeMailboxStats(tx, mailboxId, now);
  const ev = evaluateMailbox(stats, await getMailboxLimits(tx));
  if (ev.state !== "exceeded") return false;
  const halts = await getHalts(tx);
  if (halts[String(mailboxId)]) return false;
  await writeHalts(
    tx,
    { ...halts, [String(mailboxId)]: { at: now, ...stats, reason: ev.reason! } },
    now,
  );
  const paused = await tx
    .update(campaigns)
    .set({
      status: "paused",
      pausedAt: now,
      pauseReason: MAILBOX_HALT_REASON,
      updatedAt: bumpUpdatedAt(now),
    })
    .where(and(eq(campaigns.mailboxId, mailboxId), eq(campaigns.status, "running")))
    .returning({ id: campaigns.id });
  await audit(
    tx,
    "mailbox.halted",
    "mailbox",
    mailboxId,
    {
      reason: ev.reason,
      recipients: stats.recipients,
      bounced: stats.bounced,
      pausedCampaigns: paused.length,
    },
    now,
  );
  return true;
}

export type MailboxHealthErrorKind =
  "not_found" | "not_halted" | "still_exceeded" | "unconfirmed" | "invalid_input";

export class MailboxHealthError extends Error {
  constructor(
    readonly kind: MailboxHealthErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Durdurmayı kaldırır. Açık onay ve en az 10 karakterlik gerekçe ister; oran HÂLÂ eşiğin üzerindeyse REDDEDİLİR
 * (pencere kayana kadar bekler). Duraklatılmış kampanyalar kendiliğinden devam etmez; kullanıcı elle devam ettirir.
 */
export async function reenableMailbox(
  db: Db,
  mailboxId: number,
  input: { confirm: boolean; justification: string },
  now = Date.now(),
): Promise<void> {
  if (input.confirm !== true) throw new MailboxHealthError("unconfirmed", "Açık onay gerekli.");
  const justification = input.justification.trim();
  if (justification.length < 10) {
    throw new MailboxHealthError("invalid_input", "En az 10 karakterlik bir gerekçe yazın.");
  }
  await db.transaction(async (tx) => {
    const halts = await getHalts(tx);
    if (!halts[String(mailboxId)])
      throw new MailboxHealthError("not_halted", "Bu posta kutusu durdurulmamış.");
    const ev = evaluateMailbox(
      await computeMailboxStats(tx, mailboxId, now),
      await getMailboxLimits(tx),
    );
    if (ev.state === "exceeded") {
      throw new MailboxHealthError(
        "still_exceeded",
        "Bounce oranı hâlâ eşiğin üzerinde; gönderim yeniden etkinleştirilemez.",
      );
    }
    const { [String(mailboxId)]: _removed, ...rest } = halts;
    void _removed;
    await writeHalts(tx, rest, now);
    await audit(
      tx,
      "mailbox.reenabled",
      "mailbox",
      mailboxId,
      { justificationLength: justification.length },
      now,
    );
  });
}

export interface MailboxHealthView {
  limits: MailboxLimits;
  floors: typeof MAILBOX_FLOORS;
  defaults: typeof MAILBOX_DEFAULTS;
  windowDays: number;
  stats: MailboxStats;
  /** Bounce oranı baz puan olarak (yuvarlanmamış kesir değil; yalnızca gösterim). */
  rateBp: number;
  evaluation: MailboxEvaluation;
  halted: HaltRecord | null;
  complaint: { status: "not_measurable"; thresholdBp: number; manualRecords: number };
}

export async function getMailboxHealth(
  db: DbExecutor,
  mailboxId: number,
  now = Date.now(),
): Promise<MailboxHealthView> {
  const limits = await getMailboxLimits(db);
  const stats = await computeMailboxStats(db, mailboxId, now);
  const halts = await getHalts(db);
  const [manual] = await db
    .select({ n: sql<number>`count(*)` })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.reason, "complaint"),
        eq(suppressions.source, "manual"),
        sql`${suppressions.liftedAt} IS NULL`,
      ),
    );
  return {
    limits,
    floors: MAILBOX_FLOORS,
    defaults: MAILBOX_DEFAULTS,
    windowDays: MAILBOX_WINDOW_DAYS,
    stats,
    rateBp: stats.recipients > 0 ? Math.round((stats.bounced * 10_000) / stats.recipients) : 0,
    evaluation: evaluateMailbox(stats, limits),
    halted: halts[String(mailboxId)] ?? null,
    complaint: {
      status: "not_measurable",
      thresholdBp: COMPLAINT_THRESHOLD_BP,
      manualRecords: Number(manual?.n ?? 0),
    },
  };
}
