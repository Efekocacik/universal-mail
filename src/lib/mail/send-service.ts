import { and, asc, count, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { evaluateSend, type IneligibleReason } from "@/lib/compliance/eligibility";
import { DEFAULT_FREQUENCY_LIMITS, utcDay, type FrequencyLimits } from "@/lib/compliance/frequency";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
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
import { composeEmail, type ComposeIssue } from "./template-service";

/**
 * Tek kampanya adımının gönderimi (TEK deneme). Zamanlama, yeniden deneme zamanı/sayısı ve işçi entegrasyonu
 * Aşama 9'dadır.
 *
 * 1. AYIRMA (tek işlem; libsql'in varsayılan işlem modu `BEGIN IMMEDIATE`: yazma kilidi baştan alınır, eşzamanlı ikinci
 *    çağrı bekler ve sonra güncel durumu görür): uygunluk kontrolü → posta kutusu günlük tavanı → içerik → MIME →
 *    `messages` kaydı `sending` + dizi `in_flight`. İşlem başarısızsa sağlayıcı ÇAĞRILMAZ.
 * 2. GÖNDERİM: işlem DIŞINDA, zaman aşımıyla. Çağrı başladıktan sonraki her beklenmeyen hata, iptal ve zaman aşımı
 *    `unknown` sayılır.
 * 3. KAYIT (ayrı işlem): accepted → `sent`; rejected → `failed` (yalnızca bu yeniden denenebilir); unknown → `unknown`.
 *    Bu işlem başarısız olursa ileti YENİDEN GÖNDERİLMEZ: kayıt `sending` kalır, uzlaştırma onu `unknown` yapar.
 *
 * Gerçek gönderim kapalıdır: yalnızca demo posta kutusu ve demo sağlayıcısı çalışır. Ham ileti kalıcı saklanmaz.
 */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
/** Bu süreden eski `sending` kayıtları uzlaştırmada `unknown` olur. */
export const STALE_SENDING_MS = 10 * 60_000;

export type NotSendableCode =
  | "provider_unavailable"
  | "mailbox_daily_cap"
  | "step_template_missing"
  | "compose_failed"
  | "build_failed";

export type SendStepOutcome =
  | { outcome: "ineligible"; reasons: IneligibleReason[] }
  | { outcome: "not_sendable"; code: NotSendableCode; detail?: string; errors?: ComposeIssue[] }
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

      // Posta kutusu günlük tavanı (son güvence; planlama Aşama 9'da).
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailbox.id),
            eq(messages.direction, "out"),
            eq(messages.purpose, "campaign"),
            eq(messages.sendDay, utcDay(now)),
            inArray(messages.status, [...CONTACTED]),
          ),
        );
      if (n >= mailbox.dailyCap) {
        throw new Abort({ outcome: "not_sendable", code: "mailbox_daily_cap" });
      }

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
  const result = await callProvider(r, opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);

  /* 3. Kayıt ------------------------------------------------------------------------------------- */
  const base = { messageRowId: r.rowId, rfcMessageId: r.rfcMessageId };
  const outcome: SendStepOutcome =
    result.status === "accepted"
      ? { outcome: "sent", ...base, providerMessageId: result.providerMessageId }
      : result.status === "rejected"
        ? { outcome: "failed", ...base, code: result.code }
        : { outcome: "unknown", ...base, code: result.code };
  // Yalnızca veritabanı KAYDI yeniden denenir (meşgulse); ileti asla yeniden gönderilmez.
  for (let attempt = 0; ; attempt++) {
    try {
      await recordResult(db, r, input, result, clock(), limits);
      return outcome;
    } catch (e) {
      if (!isBusy(e) || attempt >= RECORD_RETRIES) return { ...outcome, recordError: true };
      await new Promise((res) => setTimeout(res, 25 * (attempt + 1)));
    }
  }
}

const RECORD_RETRIES = 8;

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
  r: Reservation,
  input: { campaignLeadId: number; stepIndex: number },
  result: ProviderResult,
  now: number,
  limits: FrequencyLimits,
): Promise<void> {
  await db.transaction(async (tx) => {
    const own = and(eq(messages.id, r.rowId), eq(messages.status, "sending"));
    const inFlight = and(
      eq(campaignLeads.id, input.campaignLeadId),
      eq(campaignLeads.status, "in_flight"),
    );

    if (result.status === "accepted") {
      const updated = await tx
        .update(messages)
        .set({ status: "sent", sentAt: now, providerMessageId: result.providerMessageId })
        .where(own)
        .returning({ id: messages.id });
      // Arada uzlaştırma kaydı `unknown` yaptıysa ona dokunulmaz.
      if (updated.length === 0) return;
      const [cl] = await tx
        .select({ campaignId: campaignLeads.campaignId, leadId: campaignLeads.leadId })
        .from(campaignLeads)
        .where(eq(campaignLeads.id, input.campaignLeadId));
      const [{ steps } = { steps: 0 }] = await tx
        .select({ steps: sql<number>`count(distinct ${campaignSteps.stepIndex})` })
        .from(campaignSteps)
        .where(eq(campaignSteps.campaignId, cl!.campaignId));
      const total = Math.min(Number(steps), limits.maxMessagesPerSequence);
      const nextStep = input.stepIndex + 1;
      await tx
        .update(campaignLeads)
        .set({
          nextStep,
          status: nextStep >= total ? "completed" : "waiting_next",
          lastSentAt: now,
          nextSendAt: null,
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
      await tx
        .update(campaignLeads)
        .set({
          status: r.previousStatus,
          attempts: sql`${campaignLeads.attempts} + 1`,
          lastError: result.code,
          updatedAt: now,
        })
        .where(inFlight);
      return;
    }

    // unknown: dizi `in_flight` kalır; insan değerlendirmesi/uzlaştırma gerekir.
    await tx.update(messages).set({ status: "unknown", errorCode: result.code }).where(own);
    await tx.update(campaignLeads).set({ lastError: result.code, updatedAt: now }).where(inFlight);
  });
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
