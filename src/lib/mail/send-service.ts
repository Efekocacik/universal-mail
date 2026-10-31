import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { evaluateSend, type IneligibleReason } from "@/lib/compliance/eligibility";
import {
  DAY_MS,
  DEFAULT_FREQUENCY_LIMITS,
  utcDay,
  type FrequencyLimits,
} from "@/lib/compliance/frequency";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leads,
  mailboxes,
  messages,
  type CampaignLeadStatus,
} from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { buildEmailMessage, MessageBuildError } from "./mime/message-builder";
import {
  getProvider,
  ProviderUnavailableError,
  type MailProvider,
  type ProviderResult,
} from "./provider/provider";
import { retryDelayMs } from "./scheduler/retry";
import { effectiveMailboxCap, gapMs, nextUtcDayStart, warmupCeiling } from "./scheduler/throttle";
import {
  effectiveWindow,
  isInWindow,
  nextWindowStart,
  timeZonesForCountry,
} from "./scheduler/window";
import { composeEmail, type ComposeIssue } from "./template-service";

/**
 * Tek kampanya adımının gönderimi (TEK deneme).
 *
 * 1. AYIRMA (tek işlem; libsql'in varsayılan işlem modu `BEGIN IMMEDIATE`: yazma kilidi baştan alınır, eşzamanlı ikinci
 *    çağrı (aynı veya başka süreçten) bekler ve sonra güncel durumu görür): uygunluk kontrolü → zamanlama kapısı
 *    (planlanan zaman, alıcının yerel saat penceresi, posta kutusu/ısınma ve kampanya günlük tavanları, gönderimler
 *    arası bekleme) → içerik → MIME → `messages` kaydı `sending` + dizi `in_flight`. İşlem başarısızsa sağlayıcı
 *    ÇAĞRILMAZ.
 * 2. GÖNDERİM: işlem DIŞINDA, zaman aşımıyla. Çağrı başladıktan sonraki her beklenmeyen hata, iptal ve zaman aşımı
 *    `unknown` sayılır.
 * 3. KAYIT (ayrı işlem): accepted → `sent` ve sonraki adımın zamanı; rejected → `failed` ve yeniden deneme planı
 *    (yalnızca geçici retler, sınırlı sayıda); unknown → `unknown`. Bu işlem başarısız olursa ileti YENİDEN
 *    GÖNDERİLMEZ: yalnızca kayıt yeniden denenir (`retryPendingRecord`); olmazsa kayıt `sending` kalır ve uzlaştırma
 *    onu `unknown` yapar.
 *
 * Gerçek gönderim kapalıdır: yalnızca demo posta kutusu ve demo sağlayıcısı çalışır. Ham ileti kalıcı saklanmaz.
 */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
/** Bu süreden eski `sending` kayıtları uzlaştırmada `unknown` olur. */
export const STALE_SENDING_MS = 10 * 60_000;
/**
 * Sağlayıcı zaman aşımı üst sınırı. Uzlaştırma eşiğinin yarısından kısa tutulur: süren bir gönderim hiçbir zaman
 * eşik dolmadan bitmemiş olamaz, yani aktif bir gönderim yanlışlıkla `unknown` yapılmaz.
 */
export const MAX_PROVIDER_TIMEOUT_MS = STALE_SENDING_MS / 2;

export type NotSendableCode =
  | "provider_unavailable"
  | "mailbox_daily_cap"
  | "campaign_daily_cap"
  | "mailbox_gap"
  | "not_due"
  | "outside_window"
  | "invalid_send_window"
  | "timezone_unknown"
  | "step_template_missing"
  | "compose_failed"
  | "build_failed";

/** Gönderim kaydı yazılamadığında yeniden denemek için gereken asgari bilgi (ham ileti ve alıcı İÇERMEZ). */
export interface PendingRecord {
  rowId: number;
  campaignLeadId: number;
  stepIndex: number;
  previousStatus: CampaignLeadStatus;
  result: ProviderResult;
}

export type SendStepOutcome =
  | { outcome: "ineligible"; reasons: IneligibleReason[] }
  | {
      outcome: "not_sendable";
      code: NotSendableCode;
      detail?: string;
      errors?: ComposeIssue[];
      /** Kapının tekrar açılabileceği en erken an (zamanlama kodlarında). */
      retryAt?: number;
    }
  /** Aynı adım için kayıt başka bir çağrı tarafından açılmış. Gönderim yok. */
  | { outcome: "already_reserved" }
  /**
   * Veritabanı başka bir işlemle meşgul (aynı süreçte açık işlem: libsql `TRANSACTION_ACTIVE`; başka süreç:
   * `SQLITE_BUSY`). Hiçbir kayıt açılmadı, gönderim yok; çağıran daha sonra yeniden dener.
   */
  | { outcome: "busy" }
  | {
      outcome: "sent" | "failed" | "unknown";
      messageRowId: number;
      rfcMessageId: string;
      providerMessageId?: string;
      code?: string;
      /** Sonuç kaydedilemedi: kayıt `sending` kaldı, uzlaştırmada `unknown` olacak. Yeniden gönderilmez. */
      recordError?: boolean;
      /** `recordError` ise: yalnızca kaydı yeniden denemek için (`retryPendingRecord`). */
      pendingRecord?: PendingRecord;
    };

export interface SendStepOptions {
  now?: () => number;
  /** Testler için; verilmezse posta kutusuna göre seçilir (yalnızca demo). */
  provider?: MailProvider;
  timeoutMs?: number;
  limits?: FrequencyLimits;
}

/** Ayırma işlemini geri alıp sonucu döndürmek için. */
class Abort extends Error {
  constructor(readonly result: SendStepOutcome) {
    super("abort");
  }
}

/** Hata (veya `cause` zincirindeki bir hata) verilen kalıba uyuyor mu? */
function errorMatches(e: unknown, pattern: RegExp): boolean {
  let cur: unknown = e;
  for (let i = 0; cur && i < 5; i++) {
    const err = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (pattern.test(`${String(err.code ?? "")} ${String(err.message ?? cur)}`)) return true;
    cur = err.cause;
  }
  return false;
}

const isUniqueViolation = (e: unknown) => errorMatches(e, /UNIQUE constraint failed/i);
const isBusy = (e: unknown) =>
  errorMatches(e, /TRANSACTION_ACTIVE|SQLITE_BUSY|database is locked/i);
/** Veritabanı başka bir işlemle meşgul mü (aynı süreç: `TRANSACTION_ACTIVE`, başka süreç: `SQLITE_BUSY`)? */
export const isBusyError = isBusy;

const CONTACTED = ["sending", "sent", "unknown"] as const;

interface Reservation {
  rowId: number;
  raw: string;
  from: string;
  to: string;
  rfcMessageId: string;
  previousStatus: CampaignLeadStatus;
  provider: MailProvider;
}

export async function sendCampaignStep(
  db: Db,
  input: { campaignLeadId: number; stepIndex: number },
  opts: SendStepOptions = {},
): Promise<SendStepOutcome> {
  const clock = opts.now ?? Date.now;
  const limits = opts.limits ?? DEFAULT_FREQUENCY_LIMITS;

  /* 1. Ayırma ----------------------------------------------------------------------------------- */
  let r: Reservation;
  try {
    r = await db.transaction(async (tx) => {
      const now = clock();
      const eligibility = await evaluateSend(tx, input, { now, limits: opts.limits });
      if (!eligibility.eligible) {
        throw new Abort({ outcome: "ineligible", reasons: eligibility.reasons });
      }

      const [cl] = await tx
        .select()
        .from(campaignLeads)
        .where(eq(campaignLeads.id, input.campaignLeadId));
      const [campaign] = cl
        ? await tx.select().from(campaigns).where(eq(campaigns.id, cl.campaignId))
        : [];
      const [mailbox] =
        campaign?.mailboxId != null
          ? await tx.select().from(mailboxes).where(eq(mailboxes.id, campaign.mailboxId))
          : [];
      if (!cl || !campaign || !mailbox || !cl.recipientEmail) {
        throw new Abort({ outcome: "ineligible", reasons: [{ code: "evaluation_error" }] });
      }

      // Yalnızca demo kapsamı; gerçek sağlayıcı yoktur.
      const mode = policyScopeForMailbox(mailbox.provider);
      let provider: MailProvider;
      try {
        if (mode !== "demo") throw new ProviderUnavailableError(mailbox.provider);
        provider = opts.provider ?? getProvider(mailbox);
      } catch (e) {
        if (!(e instanceof ProviderUnavailableError)) throw e;
        throw new Abort({ outcome: "not_sendable", code: "provider_unavailable" });
      }

      // Zamanlama kapısı: aynı işlemde (eşzamanlı ikinci çağrı sınırı aşamaz).
      const gate = await checkPacing(tx, { cl, campaign, mailbox, now });
      if (gate) throw new Abort(gate);

      // Adımın şablonu (dizinin dili).
      const steps = await tx
        .select()
        .from(campaignSteps)
        .where(
          and(
            eq(campaignSteps.campaignId, campaign.id),
            eq(campaignSteps.stepIndex, input.stepIndex),
          ),
        );
      const step = steps.find((s) => s.language === cl.language) ?? (cl.language ? null : steps[0]);
      if (!step) throw new Abort({ outcome: "not_sendable", code: "step_template_missing" });

      const composed = await composeEmail(tx, {
        templateId: step.templateId,
        leadId: cl.leadId,
        mode,
        purpose: "send",
      });
      if (!composed.sendable) {
        throw new Abort({
          outcome: "not_sendable",
          code: "compose_failed",
          errors: composed.errors,
        });
      }

      // Takip iletisi: aynı dizinin gönderilmiş adımlarına zincirlenir.
      const previous = await tx
        .select({ rfc: messages.rfcMessageId })
        .from(messages)
        .where(
          and(
            eq(messages.campaignLeadId, cl.id),
            eq(messages.direction, "out"),
            eq(messages.status, "sent"),
            isNotNull(messages.rfcMessageId),
          ),
        )
        .orderBy(asc(messages.stepIndex));
      const references = previous.map((p) => p.rfc!);

      const profile = await getSetting(tx, "company.profile");
      let built;
      try {
        built = buildEmailMessage({
          composed,
          mailbox: { provider: mailbox.provider, address: mailbox.address, status: mailbox.status },
          profile,
          recipient: cl.recipientEmail,
          mode,
          now,
          inReplyTo: references.at(-1) ?? null,
          references,
        });
      } catch (e) {
        if (!(e instanceof MessageBuildError)) throw e;
        throw new Abort({ outcome: "not_sendable", code: "build_failed", detail: e.kind });
      }

      const [row] = await tx
        .insert(messages)
        .values({
          direction: "out",
          purpose: "campaign",
          campaignId: campaign.id,
          campaignLeadId: cl.id,
          leadId: cl.leadId,
          mailboxId: mailbox.id,
          templateId: composed.templateId,
          templateVersion: composed.templateVersion,
          stepIndex: input.stepIndex,
          idempotencyKey: `cl:${cl.id}:s:${input.stepIndex}`,
          rfcMessageId: built.messageId,
          inReplyTo: references.at(-1) ?? null,
          references: references.length > 0 ? references : null,
          fromAddress: built.from,
          toAddress: built.to,
          peerHash: hashEmail(built.to),
          peerDomain: built.to.slice(built.to.lastIndexOf("@") + 1),
          sendDay: utcDay(now),
          subjectLogged: composed.subjectLogged,
          bodySha256: composed.bodySha256,
          status: "sending",
          createdAt: now,
        })
        .returning({ id: messages.id });

      const claimed = await tx
        .update(campaignLeads)
        .set({ status: "in_flight", updatedAt: now })
        .where(
          and(
            eq(campaignLeads.id, cl.id),
            inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
          ),
        )
        .returning({ id: campaignLeads.id });
      if (claimed.length !== 1) throw new Abort({ outcome: "already_reserved" });

      return {
        rowId: row!.id,
        raw: built.raw,
        from: built.from,
        to: built.to,
        rfcMessageId: built.messageId,
        previousStatus: cl.status,
        provider,
      };
    });
  } catch (e) {
    if (e instanceof Abort) return e.result;
    if (isUniqueViolation(e)) return { outcome: "already_reserved" };
    if (isBusy(e)) return { outcome: "busy" };
    throw e;
  }

  /* 2. Gönderim (işlem dışında) ------------------------------------------------------------------ */
  const timeoutMs = Math.min(
    opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    MAX_PROVIDER_TIMEOUT_MS,
  );
  const result = await callProvider(r, timeoutMs);

  /* 3. Kayıt ------------------------------------------------------------------------------------- */
  const base = { messageRowId: r.rowId, rfcMessageId: r.rfcMessageId };
  const outcome: SendStepOutcome =
    result.status === "accepted"
      ? { outcome: "sent", ...base, providerMessageId: result.providerMessageId }
      : result.status === "rejected"
        ? { outcome: "failed", ...base, code: result.code }
        : { outcome: "unknown", ...base, code: result.code };
  const pending: PendingRecord = {
    rowId: r.rowId,
    campaignLeadId: input.campaignLeadId,
    stepIndex: input.stepIndex,
    previousStatus: r.previousStatus,
    result,
  };
  // Yalnızca veritabanı KAYDI yeniden denenir (meşgulse); ileti asla yeniden gönderilmez.
  for (let attempt = 0; ; attempt++) {
    try {
      await recordResult(db, pending, clock(), limits);
      return outcome;
    } catch (e) {
      if (!isBusy(e) || attempt >= RECORD_RETRIES) {
        return { ...outcome, recordError: true, pendingRecord: pending };
      }
      await new Promise((res) => setTimeout(res, 25 * (attempt + 1)));
    }
  }
}

const RECORD_RETRIES = 8;

/**
 * Yazılamamış bir gönderim sonucunu YALNIZCA veritabanına yeniden kaydetmeyi dener; sağlayıcıyı çağırmaz.
 * Kayıt bu arada uzlaştırmayla `unknown` olduysa hiçbir şey değişmez (sonuç inceleme akışında kalır).
 */
export async function retryPendingRecord(
  db: Db,
  pending: PendingRecord,
  opts: { now?: number; limits?: FrequencyLimits } = {},
): Promise<"recorded" | "busy" | "error"> {
  try {
    await recordResult(
      db,
      pending,
      opts.now ?? Date.now(),
      opts.limits ?? DEFAULT_FREQUENCY_LIMITS,
    );
    return "recorded";
  } catch (e) {
    return isBusy(e) ? "busy" : "error";
  }
}

type GateInput = {
  cl: typeof campaignLeads.$inferSelect;
  campaign: typeof campaigns.$inferSelect;
  mailbox: typeof mailboxes.$inferSelect;
  now: number;
};

/**
 * Gönderimden hemen önceki zamanlama kapısı (ayırma işleminin içinde). Gönderime izin varsa `null`, yoksa kodu ve
 * kapının en erken açılacağı anı döndürür.
 */
async function checkPacing(
  tx: DbExecutor,
  { cl, campaign, mailbox, now }: GateInput,
): Promise<Extract<SendStepOutcome, { outcome: "not_sendable" }> | null> {
  const ns = (code: NotSendableCode, retryAt?: number, detail?: string) => ({
    outcome: "not_sendable" as const,
    code,
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });

  // Planlanan zaman (takip aralığı, yeniden deneme beklemesi).
  if (cl.nextSendAt !== null && cl.nextSendAt > now) return ns("not_due", cl.nextSendAt);

  // Alıcının yerel saat penceresi.
  const window = effectiveWindow(campaign.sendWindow);
  if (!window) return ns("invalid_send_window");
  const [lead] = await tx
    .select({ countryCode: leads.countryCode })
    .from(leads)
    .where(eq(leads.id, cl.leadId));
  const zones = timeZonesForCountry(lead?.countryCode ?? cl.countryCode);
  if (!zones) return ns("timezone_unknown");
  if (!isInWindow(now, window, zones)) {
    return ns("outside_window", nextWindowStart(now, window, zones) ?? now + DAY_MS);
  }

  // Günlük tavanlar (UTC günü): posta kutusu (ısınma dahil, tüm kampanyalar) ve kampanya.
  const today = utcDay(now);
  const contactedToday = and(
    eq(messages.direction, "out"),
    eq(messages.purpose, "campaign"),
    eq(messages.sendDay, today),
    inArray(messages.status, [...CONTACTED]),
  );
  const [{ n: mailboxToday } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailbox.id), contactedToday));
  if (mailboxToday >= effectiveMailboxCap(mailbox, now)) {
    const warm = warmupCeiling(mailbox, now) < mailbox.dailyCap;
    return ns("mailbox_daily_cap", nextUtcDayStart(now), warm ? "warmup" : undefined);
  }
  const [{ n: campaignToday } = { n: 0 }] = await tx
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.campaignId, campaign.id), contactedToday));
  if (campaignToday >= campaign.dailyCap) {
    return ns("campaign_daily_cap", nextUtcDayStart(now));
  }

  // Aynı kutudan gönderimler arası bekleme (başarısız denemeler de sağlayıcıya ulaştığı için sayılır).
  const [last] = await tx
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailbox.id),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (last) {
    const until = last.createdAt + gapMs(last.id, campaign.minGapS, campaign.maxGapS);
    if (now < until) return ns("mailbox_gap", until);
  }
  return null;
}

/** Sağlayıcıyı zaman aşımıyla çağırır. Çağrı başladıktan sonraki her beklenmeyen durum `unknown`'dur. */
async function callProvider(r: Reservation, timeoutMs: number): Promise<ProviderResult> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderResult>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ status: "unknown", code: "timeout" });
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      r.provider
        .send({ raw: r.raw, from: r.from, to: r.to, messageId: r.rfcMessageId, signal: ac.signal })
        .catch((): ProviderResult => ({
          status: "unknown",
          code: ac.signal.aborted ? "timeout" : "provider_exception",
        })),
      timeout,
    ]);
    return isProviderResult(res) ? res : { status: "unknown", code: "invalid_provider_result" };
  } finally {
    clearTimeout(timer);
  }
}

function isProviderResult(v: unknown): v is ProviderResult {
  const o = v as ProviderResult | null;
  if (!o || typeof o !== "object") return false;
  if (o.status === "accepted") return typeof o.providerMessageId === "string";
  if (o.status === "rejected")
    return typeof o.code === "string" && typeof o.permanent === "boolean";
  return o.status === "unknown" && typeof o.code === "string";
}

async function recordResult(
  db: Db,
  p: PendingRecord,
  now: number,
  limits: FrequencyLimits,
): Promise<void> {
  const { result } = p;
  await db.transaction(async (tx) => {
    const own = and(eq(messages.id, p.rowId), eq(messages.status, "sending"));
    const inFlight = and(
      eq(campaignLeads.id, p.campaignLeadId),
      eq(campaignLeads.status, "in_flight"),
    );

    if (result.status === "accepted") {
      const updated = await tx
        .update(messages)
        .set({ status: "sent", sentAt: now, providerMessageId: result.providerMessageId })
        .where(own)
        .returning({ id: messages.id, mailboxId: messages.mailboxId });
      // Arada uzlaştırma kaydı `unknown` yaptıysa ona dokunulmaz.
      if (updated.length === 0) return;
      const [cl] = await tx
        .select({ campaignId: campaignLeads.campaignId, leadId: campaignLeads.leadId })
        .from(campaignLeads)
        .where(eq(campaignLeads.id, p.campaignLeadId));
      const stepRows = await tx
        .select({ stepIndex: campaignSteps.stepIndex, delayDays: campaignSteps.delayDays })
        .from(campaignSteps)
        .where(eq(campaignSteps.campaignId, cl!.campaignId));
      const total = Math.min(
        new Set(stepRows.map((s) => s.stepIndex)).size,
        limits.maxMessagesPerSequence,
      );
      const nextStep = p.stepIndex + 1;
      // Sonraki adımın en erken zamanı: adım gecikmesi ve takip aralığı alt sınırının büyüğü. Pencereye kaydırma
      // gönderim anında yapılır.
      const delayDays = Math.max(
        limits.minFollowupGapDays,
        ...stepRows.filter((s) => s.stepIndex === nextStep).map((s) => s.delayDays),
      );
      const done = nextStep >= total;
      await tx
        .update(campaignLeads)
        .set({
          nextStep,
          status: done ? "completed" : "waiting_next",
          lastSentAt: now,
          nextSendAt: done ? null : now + delayDays * DAY_MS,
          attempts: 0,
          lastError: null,
          updatedAt: now,
        })
        .where(inFlight);
      await tx
        .update(leads)
        .set({
          lastContactedAt: now,
          status: sql`CASE WHEN ${leads.status} IN ('new', 'enriched', 'queued') THEN 'sent' ELSE ${leads.status} END`,
          updatedAt: now,
        })
        .where(eq(leads.id, cl!.leadId));
      await settleIfCancelled(tx, p.campaignLeadId, now);
      // Isınma, kutunun ilk başarılı gönderimiyle başlar.
      await tx
        .update(mailboxes)
        .set({ warmupStartedAt: now, updatedAt: now })
        .where(and(eq(mailboxes.id, updated[0]!.mailboxId), isNull(mailboxes.warmupStartedAt)));
      return;
    }

    if (result.status === "rejected") {
      const updated = await tx
        .update(messages)
        .set({
          status: "failed",
          errorCode: result.code,
          errorMessage: result.permanent ? "permanent" : "transient",
        })
        .where(own)
        .returning({ id: messages.id });
      if (updated.length === 0) return;
      // Bu adımın başarısız deneme sayısı (az önceki dahil). Kalıcı ret veya hak bitti: dizi `failed`.
      const [{ n: failedAttempts } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.idempotencyKey, `cl:${p.campaignLeadId}:s:${p.stepIndex}`),
            eq(messages.status, "failed"),
          ),
        );
      const delay = retryDelayMs(failedAttempts, result.permanent, result.retryAfterMs);
      await tx
        .update(campaignLeads)
        .set({
          status: delay === null ? "failed" : p.previousStatus,
          nextSendAt: delay === null ? null : now + delay,
          attempts: failedAttempts,
          lastError: result.code,
          updatedAt: now,
        })
        .where(inFlight);
      await settleIfCancelled(tx, p.campaignLeadId, now);
      return;
    }

    // unknown: dizi `in_flight` kalır; insan değerlendirmesi gerekir (otomatik yeniden gönderim yok).
    await tx.update(messages).set({ status: "unknown", errorCode: result.code }).where(own);
    await tx.update(campaignLeads).set({ lastError: result.code, updatedAt: now }).where(inFlight);
  });
}

/**
 * Gönderim sürerken kampanya iptal edildiyse (ayrılmış ileti tamamlanabilir; bkz. campaigns/lifecycle.ts), sonucu
 * kaydedilen dizi bekleyen durumda kalmaz, `cancelled` olur. Tamamlanmış dizi (`completed`) olduğu gibi kalır.
 */
async function settleIfCancelled(tx: DbExecutor, campaignLeadId: number, now: number) {
  await tx
    .update(campaignLeads)
    .set({ status: "cancelled", nextSendAt: null, updatedAt: now })
    .where(
      and(
        eq(campaignLeads.id, campaignLeadId),
        inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
        inArray(
          campaignLeads.campaignId,
          tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, "cancelled")),
        ),
      ),
    );
}

/**
 * Çökme sonrası uzlaştırma: `olderThanMs`'den eski `sending` kayıtlarını `unknown` yapar. Hiçbir şeyi yeniden
 * GÖNDERMEZ. Tekrar çalıştırılabilir (ikinci çalıştırmada değişecek kayıt kalmaz). Değişen kayıt sayısını döndürür.
 */
export async function reconcileStaleSending(
  db: Db,
  opts: { now?: number; olderThanMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? STALE_SENDING_MS);
  return db.transaction(async (tx) => {
    const stale = await tx
      .update(messages)
      .set({ status: "unknown", errorCode: "stale_sending" })
      .where(
        and(
          eq(messages.direction, "out"),
          eq(messages.status, "sending"),
          lt(messages.createdAt, cutoff),
        ),
      )
      .returning({ campaignLeadId: messages.campaignLeadId });
    const ids = [
      ...new Set(stale.map((s) => s.campaignLeadId).filter((x): x is number => x !== null)),
    ];
    if (ids.length > 0) {
      await tx
        .update(campaignLeads)
        .set({ lastError: "stale_sending", updatedAt: now })
        .where(and(inArray(campaignLeads.id, ids), eq(campaignLeads.status, "in_flight")));
    }
    return stale.length;
  });
}
