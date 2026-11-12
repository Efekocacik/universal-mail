import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  gt,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { evaluateSend, type IneligibleReason } from "@/lib/compliance/eligibility";
import {
  DAY_MS,
  DEFAULT_FREQUENCY_LIMITS,
  utcDay,
  type FrequencyLimits,
} from "@/lib/compliance/frequency";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
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
import { evaluateDrainGate } from "@/lib/unsubscribe/delivery-alert";
import { evaluateDnsReadiness } from "./dns-store";
import { EndpointError, prepareLiveUnsubscribe } from "@/lib/unsubscribe/endpoint";
import { getLiveProvider } from "./gmail/provider";
import {
  MAILBOX_PERMANENT_DEFER_MS,
  MAILBOX_PERMANENT_REJECT_CODES,
  MAILBOX_SCOPED_REJECT_CODES,
  RECENT_UNKNOWN_COOLDOWN_MS,
  extendMailboxBackoff,
  getMailboxBackoff,
  mailboxBackoffUntil,
  pauseMailboxCampaigns,
} from "./mailbox-backoff";
import { mailboxSendBlock } from "./mailbox-health";
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
 * Canlı gönderim kapısı (`isLiveSendingPermitted`) kapalıyken yalnızca demo posta kutusu ve demo sağlayıcısı çalışır;
 * canlı kapsamdaki kutu ilk kapıda `provider_unavailable` ile durur. Kapı açıkken canlı yol şunları ÇALIŞMA ANINDA
 * ZORUNLU kılar: uygunluk/kilidi açılmış canlı ülke politikası, doğrulanmış HTTPS çıkış uç noktası ve iletiye özgü
 * imzalı çıkış bağlantısı (`unsubscribe_unavailable`), sağlıklı çıkış çekme işi (`unsubscribe_drain_unhealthy`),
 * kutunun alan adı için taze ve üçü de geçen DNS denetimi (`dns_not_verified`), Gmail sağlayıcısının kendi kapıları
 * (bağlı kutu, `gmail.send`). Ham ileti kalıcı saklanmaz.
 */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
/** Bu süreden eski `sending` kayıtları uzlaştırmada `unknown` olur. */
export const STALE_SENDING_MS = 10 * 60_000;
/**
 * Sağlayıcı zaman aşımı üst sınırı. Uzlaştırma eşiğinin yarısından kısa tutulur: süren bir gönderim hiçbir zaman
 * eşik dolmadan bitmemiş olamaz, yani aktif bir gönderim yanlışlıkla `unknown` yapılmaz.
 */
export const MAX_PROVIDER_TIMEOUT_MS = STALE_SENDING_MS / 2;
/** Çekme kapısı kapalıyken (`unsubscribe_drain_unhealthy`) dizinin yeniden deneneceği süre. */
export const DRAIN_GATE_RETRY_MS = 15 * 60_000;
/** DNS kapısı kapalıyken (`dns_not_verified`) dizinin yeniden deneneceği süre. */
export const DNS_GATE_RETRY_MS = 15 * 60_000;
/**
 * Gönderen kutunun Google yetkisi geçersiz/iptal (`invalid_grant`; ör. "Testing" durumundaki OAuth projesinde 7 günlük
 * yenileme belirteci süresi doldu): dizi bu kadar sonra yeniden denenir. Kampanya DURAKLATILMAZ, dizi başarısız
 * SAYILMAZ ve deneme hakkından düşülmez; kullanıcı "Yeniden bağlan" ile kutuyu bağlayınca gönderim kendiliğinden sürer.
 */
export const REAUTH_DEFER_MS = 30 * 60_000;
/**
 * Sağlayıcının, iletiyi göndermeden (ağ isteğinden önce) kutunun yetkisi olmadığı için verdiği ret kodları. Kutu
 * düzeyinde ve kullanıcı eylemiyle düzelir: dizi ertelenir, başarısız sayılmaz.
 */
const MAILBOX_AUTH_REJECT_CODES: ReadonlySet<string> = new Set([
  "reauthorization_required",
  "not_connected",
]);

export type NotSendableCode =
  | "provider_unavailable"
  | "mailbox_daily_cap"
  | "campaign_daily_cap"
  | "mailbox_gap"
  | "mailbox_halted"
  | "not_due"
  | "outside_window"
  | "invalid_send_window"
  | "timezone_unknown"
  | "step_template_missing"
  | "compose_failed"
  | "build_failed"
  /** Canlı ileti için doğrulanmış çıkış uç noktası/bağlantısı hazırlanamadı: gönderim YOK. */
  | "unsubscribe_unavailable"
  /**
   * Canlı ileti: çıkış talepleri çekilmiyor (çekme işi kapalı, son sağlık kaydı kötü ya da 24 saatten eski).
   * Gönderim YOK; dizi ERTELENİR (dışlanmaz, başarısız sayılmaz). `detail`: `DrainGateCode`.
   */
  | "unsubscribe_drain_unhealthy"
  /**
   * Canlı ileti: kutunun alan adı için taze (30 gün) ve SPF/DKIM/DMARC üçü de `pass` olan saklı bir DNS denetimi yok
   * (hiç denetlenmedi, bayat, uyarı veya hata). Gönderim YOK; dizi ERTELENİR. `detail`: `unknown` | `blocked`.
   * Kişisel Gmail (`gmail.com`, `googlemail.com`) kutusunda DNS Google tarafından yönetildiği için bu kapı geçer.
   */
  | "dns_not_verified";

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
  /** Yalnızca testte: canlı gönderim kilidini geçersiz kılar (üretimde yok sayılmaz, HATA verir). */
  liveEnabled?: () => boolean;
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

/**
 * "Temas kuruldu" sayılan giden ileti durumları (günlük üst sınır ve alan adı/gün kuralı bunlarla sayar). Faz 4: gösterge
 * paneli sayaçları üst sınır denetimiyle AYNI tanımı kullansın diye dışa açıktır.
 */
export const CONTACTED = ["sending", "sent", "unknown"] as const;

/**
 * Takip iletisinin konuşma bilgisi (saf; 9d). Yalnızca bu dizinin `sent` iletilerinden (adım sırasıyla) türetilir:
 * `references` bütün önceki Message-ID'ler, `threadId` en son bilinen sağlayıcı konuşması, `subject` ilk adımın
 * gönderilen konusu (yalnızca adım > 0 için). Adım 0'da hepsi boştur.
 */
export function followupThread(
  previous: readonly {
    rfc: string | null;
    stepIndex: number | null;
    threadId: string | null;
    subject: string | null;
  }[],
  stepIndex: number,
): { references: string[]; threadId: string | null; subject: string | null } {
  if (stepIndex <= 0) return { references: [], threadId: null, subject: null };
  const earlier = previous.filter((p) => p.rfc && (p.stepIndex ?? 0) < stepIndex);
  const first = earlier.find((p) => p.stepIndex === 0);
  const threadId = [...earlier].reverse().find((p) => p.threadId)?.threadId ?? null;
  return {
    references: earlier.map((p) => p.rfc!),
    threadId,
    subject: first?.subject?.trim() ? first.subject.trim() : null,
  };
}

interface Reservation {
  rowId: number;
  raw: string;
  from: string;
  to: string;
  rfcMessageId: string;
  previousStatus: CampaignLeadStatus;
  provider: MailProvider;
  /** Takip iletisinin sağlayıcı konuşması (9d); yoksa `undefined`. */
  threadId?: string;
}

export async function sendCampaignStep(
  db: Db,
  input: { campaignLeadId: number; stepIndex: number },
  opts: SendStepOptions = {},
): Promise<SendStepOutcome> {
  const clock = opts.now ?? Date.now;
  const limits = opts.limits ?? DEFAULT_FREQUENCY_LIMITS;
  if (opts.liveEnabled && process.env.NODE_ENV !== "test") {
    throw new Error("liveEnabled yalnızca testte kullanılabilir.");
  }
  const liveEnabled = opts.liveEnabled ?? isLiveSendingPermitted;

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

      // Sağlayıcı seçimi. Canlı kapsam: ÖNCE canlı gönderim kilidi (kapalıyken HİÇBİR şey yapılmaz: belirteç basılmaz,
      // anahtar/gizli depo okunmaz, sağlayıcı kurulmaz); sonra sağlayıcı; çıkış bağlantısı yalnızca doğrulanmış uç noktayla.
      const mode = policyScopeForMailbox(mailbox.provider);
      let provider: MailProvider;
      let unsubscribe: { url: string; oneClick: boolean } | undefined;
      try {
        if (mode === "live") {
          if (!liveEnabled()) throw new ProviderUnavailableError(mailbox.provider);
          provider = opts.provider ?? getLiveProvider(db, mailbox);
        } else {
          provider = opts.provider ?? getProvider(mailbox);
        }
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

      if (mode === "live") {
        try {
          unsubscribe = await prepareLiveUnsubscribe(tx, { campaignLeadId: cl.id, now });
        } catch (e) {
          if (!(e instanceof EndpointError)) throw e;
          throw new Abort({
            outcome: "not_sendable",
            code: "unsubscribe_unavailable",
            detail: e.code,
          });
        }
      }

      // Çıkış talepleri gerçekten çekiliyor mu? Çekme kapalı/sağlıksız/bayatken canlı kampanya ERTELENİR: aksi halde
      // gerçek çıkış tıklamaları aktarıcıda birikirken gönderim sürerdi. (Uç nokta eksikliği ise yapılandırma
      // hatasıdır ve yukarıda kampanyayı duraklatır; bu geçici bir işletim durumudur.)
      if (mode === "live") {
        const drain = await evaluateDrainGate(tx, { now });
        if (!drain.ok) {
          throw new Abort({
            outcome: "not_sendable",
            code: "unsubscribe_drain_unhealthy",
            detail: drain.code,
            retryAt: now + DRAIN_GATE_RETRY_MS,
          });
        }
        // Gönderen alan adının kimlik doğrulaması (SPF/DKIM/DMARC): yalnızca kullanıcının "Kontrol et" ile kaydettiği
        // taze ve üçü de geçen sonuç kabul edilir (hazırlık ekranındaki `dns_auth` maddesiyle aynı ölçüt). Ağ yok.
        // İstisna: kişisel Gmail adresi (sağlayıcı yönetimli alan adı) kayıt aranmadan geçer (`isDnsProviderManaged`).
        const dns = await evaluateDnsReadiness(tx, [mailbox], now);
        if (dns !== "ok") {
          throw new Abort({
            outcome: "not_sendable",
            code: "dns_not_verified",
            detail: dns,
            retryAt: now + DNS_GATE_RETRY_MS,
          });
        }
      }

      // Takip iletisi: aynı dizinin gönderilmiş adımlarına zincirlenir (In-Reply-To/References, Gmail threadId ve
      // şablon izin veriyorsa ilk e-postanın konusu "Re:" ile; 9d).
      const previous = await tx
        .select({
          rfc: messages.rfcMessageId,
          stepIndex: messages.stepIndex,
          threadId: messages.threadId,
          subject: messages.subjectLogged,
        })
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
      const thread = followupThread(previous, input.stepIndex);

      const composed = await composeEmail(tx, {
        templateId: step.templateId,
        leadId: cl.leadId,
        mode,
        purpose: "send",
        ...(unsubscribe ? { unsubscribeUrl: unsubscribe.url } : {}),
        ...(thread.subject ? { threadSubject: thread.subject } : {}),
      });
      if (!composed.sendable) {
        throw new Abort({
          outcome: "not_sendable",
          code: "compose_failed",
          errors: composed.errors,
        });
      }

      const references = thread.references;

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
          ...(unsubscribe
            ? {
                unsubscribe: {
                  url: unsubscribe.url,
                  oneClickEndpointVerified: unsubscribe.oneClick,
                },
              }
            : {}),
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
        ...(thread.threadId ? { threadId: thread.threadId } : {}),
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

/** Sonuç kaydı meşgul veritabanında en çok bu kadar yeniden denenir (ileti asla yeniden gönderilmez). */
export const RECORD_RETRIES = 8;

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

  // Posta kutusu düzeyi sağlık (SRS 5.6.1): durdurulmuş veya oranı eşiği aşan kutudan gönderilmez.
  if ((await mailboxSendBlock(tx, mailbox.id, now)).blocked)
    return ns("mailbox_halted", now + 5 * 60_000);

  // Kutu düzeyi bekleme (Gmail kotası/429, yetki uç noktası veya ağ erişilemez): kalıcıdır, yeniden başlatmada da geçerli.
  const backoff = await getMailboxBackoff(tx, mailbox.id, now);
  if (backoff) return ns("mailbox_halted", backoff.until, backoff.code);

  // Devre kesici: kutunun son belirsiz (`unknown`) kampanya iletisinden sonra bir süre başka dizi GÖNDERİLMEZ. Bağlantı
  // kesintisi veya sağlayıcı arızasında her aralıkta yeni bir dizinin belirsiz sonuca (ve elle incelemeye) düşmesi önlenir.
  const [recentUnknown] = await tx
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailbox.id),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        eq(messages.status, "unknown"),
        gt(messages.createdAt, now - RECENT_UNKNOWN_COOLDOWN_MS),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (recentUnknown) {
    return ns(
      "mailbox_halted",
      recentUnknown.createdAt + RECENT_UNKNOWN_COOLDOWN_MS,
      "recent_unknown",
    );
  }

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
        .send({
          raw: r.raw,
          from: r.from,
          to: r.to,
          messageId: r.rfcMessageId,
          signal: ac.signal,
          ...(r.threadId ? { threadId: r.threadId } : {}),
        })
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
  if (o.status === "accepted") {
    return (
      typeof o.providerMessageId === "string" &&
      (o.threadId === undefined || typeof o.threadId === "string")
    );
  }
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
        .set({
          status: "sent",
          sentAt: now,
          providerMessageId: result.providerMessageId,
          // Sağlayıcının konuşma kimliği (yanıt eşleştirme için; yoksa değişmez).
          ...(result.threadId ? { threadId: result.threadId } : {}),
        })
        .where(own)
        .returning({ id: messages.id, mailboxId: messages.mailboxId });
      // Arada uzlaştırma kaydı `unknown` yaptıysa ona dokunulmaz.
      if (updated.length === 0) return;
      await advanceAfterSent(
        tx,
        {
          campaignLeadId: p.campaignLeadId,
          stepIndex: p.stepIndex,
          mailboxId: updated[0]!.mailboxId,
          sentAt: now,
        },
        now,
        limits,
      );
      return;
    }

    if (result.status === "rejected" && MAILBOX_AUTH_REJECT_CODES.has(result.code)) {
      // Kutunun yetkisi yok (iptal/süresi dolmuş yenileme belirteci): ileti GÖNDERİLMEDİ (istek atılmadı). Kayıt
      // `failed` olur ama dizi başarısız sayılmaz ve deneme hakkı tüketilmez; yeniden bağlanana kadar ertelenir.
      const updated = await tx
        .update(messages)
        .set({ status: "failed", errorCode: result.code, errorMessage: "mailbox_auth" })
        .where(own)
        .returning({ id: messages.id });
      if (updated.length === 0) return;
      await tx
        .update(campaignLeads)
        .set({
          status: p.previousStatus,
          nextSendAt: now + REAUTH_DEFER_MS,
          lastError: "reauthorization_required",
          updatedAt: now,
        })
        .where(inFlight);
      await settleIfCancelled(tx, p.campaignLeadId, now);
      return;
    }

    if (result.status === "rejected" && MAILBOX_SCOPED_REJECT_CODES.has(result.code)) {
      // Kutu düzeyi ret (kota/429, yetki uç noktası veya ağ erişilemez, Google 403): alıcıya özgü değildir. Dizinin deneme
      // hakkı TÜKETİLMEZ; dizi önceki durumuna döner ve kutu beklemesinin sonuna ertelenir. Kalıcı kutu retinde
      // kutunun çalışan kampanyaları duraklatılır (kullanıcı düzeltip sürdürür).
      const updated = await tx
        .update(messages)
        .set({ status: "failed", errorCode: result.code, errorMessage: "mailbox_scope" })
        .where(own)
        .returning({ id: messages.id, mailboxId: messages.mailboxId });
      if (updated.length === 0) return;
      const mailboxId = updated[0]!.mailboxId;
      let until: number;
      if (MAILBOX_PERMANENT_REJECT_CODES.has(result.code)) {
        until = now + MAILBOX_PERMANENT_DEFER_MS;
        if (mailboxId !== null) await pauseMailboxCampaigns(tx, mailboxId, result.code, now);
      } else {
        until = mailboxBackoffUntil(result.code, result.retryAfterMs, now);
        if (mailboxId !== null)
          until = await extendMailboxBackoff(tx, mailboxId, result.code, until, now);
      }
      await tx
        .update(campaignLeads)
        .set({
          status: p.previousStatus,
          nextSendAt: until,
          lastError: result.code,
          updatedAt: now,
        })
        .where(inFlight);
      await settleIfCancelled(tx, p.campaignLeadId, now);
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
      // Kutu yetkisi veya kutu düzeyi ret nedeniyle düşen kayıtlar deneme hakkından sayılmaz.
      const [{ n: failedAttempts } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.idempotencyKey, `cl:${p.campaignLeadId}:s:${p.stepIndex}`),
            eq(messages.status, "failed"),
            or(
              isNull(messages.errorMessage),
              notInArray(messages.errorMessage, ["mailbox_auth", "mailbox_scope"]),
            ),
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
 * Gönderildiği kesinleşen adımdan sonra diziyi ilerletir: sonraki adım ve zamanı (son adımsa `completed`), lead'in son
 * temas zamanı, iptal edilmiş kampanyada diziyi kapatma ve posta kutusu ısınmasının başlangıcı. Yalnızca `in_flight`
 * dizi ilerler. Kabul edilen gönderimin kaydında ve incelemedeki "gönderildi" kararında (`scheduler/resolve-review.ts`)
 * AYNI kurallarla kullanılır. `sentAt`: iletinin gönderildiği an (kabulde `now`); `now`: kaydın yazıldığı an.
 */
export async function advanceAfterSent(
  tx: DbExecutor,
  p: { campaignLeadId: number; stepIndex: number; mailboxId: number; sentAt: number },
  now: number,
  limits: FrequencyLimits,
): Promise<void> {
  const inFlight = and(
    eq(campaignLeads.id, p.campaignLeadId),
    eq(campaignLeads.status, "in_flight"),
  );
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
      lastSentAt: p.sentAt,
      nextSendAt: done ? null : p.sentAt + delayDays * DAY_MS,
      attempts: 0,
      lastError: null,
      updatedAt: now,
    })
    .where(inFlight);
  await tx
    .update(leads)
    .set({
      lastContactedAt: p.sentAt,
      status: sql`CASE WHEN ${leads.status} IN ('new', 'enriched', 'queued') THEN 'sent' ELSE ${leads.status} END`,
      updatedAt: now,
    })
    .where(eq(leads.id, cl!.leadId));
  await settleIfCancelled(tx, p.campaignLeadId, now);
  // Isınma, kutunun ilk başarılı gönderimiyle başlar.
  await tx
    .update(mailboxes)
    .set({ warmupStartedAt: p.sentAt, updatedAt: now })
    .where(and(eq(mailboxes.id, p.mailboxId), isNull(mailboxes.warmupStartedAt)));
}

/**
 * Gönderim sürerken kampanya iptal edildiyse (ayrılmış ileti tamamlanabilir; bkz. campaigns/lifecycle.ts), sonucu
 * kaydedilen dizi bekleyen durumda kalmaz, `cancelled` olur. Tamamlanmış dizi (`completed`) olduğu gibi kalır.
 */
export async function settleIfCancelled(tx: DbExecutor, campaignLeadId: number, now: number) {
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
  return db.transaction((tx) => reconcileStaleSendingIn(tx, now, opts.olderThanMs));
}

/** `reconcileStaleSending`'in açık bir işlem içinde çalışan gövdesi (inceleme kararı aynı işlemde uzlaştırır). */
export async function reconcileStaleSendingIn(
  tx: DbExecutor,
  now: number,
  olderThanMs: number = STALE_SENDING_MS,
): Promise<number> {
  const cutoff = now - olderThanMs;
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
}
