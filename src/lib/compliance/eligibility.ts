import { and, eq, inArray, ne } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leadEmails,
  leads,
  mailboxes,
  messages,
  type CampaignLeadStatus,
  type LeadStatus,
  type PolicyScope,
} from "@/lib/db/schema";
import { classifyKind, isConsumerDomain, parseEmail } from "@/lib/email/address";
import { getSettings } from "@/lib/settings";
import {
  addDays,
  DAY_MS,
  DEFAULT_FREQUENCY_LIMITS,
  isAtLeastAsStrict,
  utcDay,
  type FrequencyLimits,
} from "./frequency";
import { LIVE_SENDING_ENABLED, policyScopeForMailbox, resolveCountryPolicy } from "./policies";
import { checkSuppression, hashEmail } from "./suppression";

/**
 * Merkezi gönderim uygunluğu (FR-CMP-02, FR-CMP-11, FR-CMPL-01/07/08, SRS 5.6.1).
 *
 * İki giriş noktası aynı kontrolleri kullanır:
 *  - `evaluateEnrollment`: lead kampanyaya eklenmeden önce,
 *  - `evaluateSend`: bir adım sağlayıcıya verilmeden HEMEN önce (veri bu arada değişmiş olabilir).
 *
 * Güvenli varsayılan: eksik, bozuk veya çelişkili veri, beklenmeyen hata ve gevşetilmiş sınır her zaman
 * "uygun değil" sonucunu verir. Sonuç makine tarafından işlenebilir ret nedenleri listesidir.
 *
 * Kapsam (`scope`) kampanyanın posta kutusundan gelir. `demo` sonucu yalnızca ağa çıkmayan demo posta kutusu için
 * geçerlidir ve GERÇEK GÖNDERİM İZNİ DEĞİLDİR; demo dışındaki her sağlayıcı `live` sayılır ve bu sürümde
 * (`LIVE_SENDING_ENABLED = false`) her zaman `live_sending_disabled` ile reddedilir.
 *
 * Bu aşamadaki kararlar: yalnızca doğrulanmış (`verified`) GENEL işletme adreslerine gönderilir (`personal` ve
 * `consumer` hariç); daha önce kampanya iletisi almış bir alıcı, süreler dolsa da elle inceleme gerektirir.
 */

export type IneligibleCode =
  | "evaluation_error"
  | "invalid_limits"
  | "consent_missing"
  | "sender_profile_incomplete"
  | "campaign_not_found"
  | "campaign_not_active"
  | "campaign_closed"
  | "mailbox_missing"
  | "mailbox_not_ready"
  | "live_sending_disabled"
  | "lead_not_found"
  | "lead_status_blocked"
  | "campaign_lead_not_found"
  | "campaign_lead_not_sendable"
  | "no_email"
  | "email_removed"
  | "recipient_mismatch"
  | "recipient_redacted"
  | "email_invalid"
  | "email_not_verified"
  | "email_consumer"
  | "email_personal"
  | "country_blocked"
  | "country_generic_only"
  | "suppressed"
  | "already_in_campaign"
  | "domain_already_in_campaign"
  | "active_sequence_elsewhere"
  | "recontact_requires_review"
  | "rest_period"
  | "cross_campaign_gap"
  | "unresolved_delivery"
  | "step_out_of_range"
  | "step_missing"
  | "sequence_limit"
  | "already_sent"
  | "previous_step_not_sent"
  | "followup_too_soon"
  | "reply_received"
  | "domain_daily_cap";

export interface IneligibleReason {
  code: IneligibleCode;
  /** Engel bir süre sonra kalkacaksa (ör. dinlenme, takip aralığı) en erken zaman. */
  until?: number;
  /** Ek makine bilgisi (ör. politika nedeni, lead durumu). Kişisel veri İÇERMEZ. */
  detail?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Değerlendirmenin yapıldığı kapsam. `demo` sonucu gerçek gönderim izni anlamına gelmez. */
  scope: PolicyScope;
  reasons: IneligibleReason[];
}

export interface EligibilityOptions {
  now?: number;
  /** `tightenFrequencyLimits` ile üretilmiş, varsayılandan gevşek olmayan sınırlar. */
  limits?: FrequencyLimits;
  /**
   * Yalnızca `evaluateEnrollment`: kampanyadaki bu dizinin KENDİSİ "zaten kampanyada" sayılmaz. Kampanya başlatılırken
   * `pending` dizilerin yeniden denetlenmesi için kullanılır; diğer bütün kontroller aynen uygulanır.
   */
  ignoreCampaignLeadId?: number;
}

/** Bu lead durumlarında yeni temas yapılmaz. */
const BLOCKED_LEAD_STATUSES: ReadonlySet<LeadStatus> = new Set([
  "replied",
  "not_interested",
  "customer",
  "do_not_contact",
]);

/** Sürmekte olan (henüz bitmemiş) dizi durumları. */
const ACTIVE_SEQUENCE: readonly CampaignLeadStatus[] = [
  "pending",
  "scheduled",
  "in_flight",
  "waiting_next",
];

/** Gönderilmiş veya gönderilmiş olabilecek iletiler. `failed` sağlayıcıya ulaşmamıştır, sayılmaz. */
const CONTACTED = ["sending", "sent", "unknown"] as const;
/** Sonucu belirsiz iletiler: otomatik devam veya yeniden gönderim yapılmaz. */
const UNRESOLVED = ["sending", "unknown"] as const;

class Collector {
  readonly reasons: IneligibleReason[] = [];
  /** Aynı neden bir kez listelenir; süreli nedenlerde en geç bitiş zamanı tutulur. */
  add(code: IneligibleCode, extra: Omit<IneligibleReason, "code"> = {}) {
    const existing = this.reasons.find((r) => r.code === code && r.detail === extra.detail);
    if (!existing) this.reasons.push({ code, ...extra });
    else if (extra.until !== undefined && (existing.until ?? 0) < extra.until)
      existing.until = extra.until;
  }
  result(scope: PolicyScope): EligibilityResult {
    return { eligible: this.reasons.length === 0, scope, reasons: this.reasons };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Giriş noktaları
 * ---------------------------------------------------------------------------------------------- */

/** Bir lead bu kampanyaya eklenebilir mi? Lead'in birincil e-posta adresi değerlendirilir. */
export async function evaluateEnrollment(
  db: DbExecutor,
  input: { campaignId: number; leadId: number },
  opts: EligibilityOptions = {},
): Promise<EligibilityResult> {
  const c = new Collector();
  let scope: PolicyScope = "live";
  try {
    const now = opts.now ?? Date.now();
    const limits = resolveLimits(opts, c);
    await checkSender(db, c);

    const campaign = await loadCampaign(db, input.campaignId, c);
    if (campaign) {
      scope = await checkMailbox(db, campaign.mailboxId, c);
      if (["completed", "cancelled", "stopped"].includes(campaign.status)) {
        c.add("campaign_closed", { detail: campaign.status });
      }
    }

    const lead = await loadLead(db, input.leadId, c);
    if (!lead) return c.result(scope);
    const [primary] = await db
      .select()
      .from(leadEmails)
      .where(and(eq(leadEmails.leadId, lead.id), eq(leadEmails.isPrimary, true)))
      .limit(1);
    if (!primary) {
      c.add("no_email");
      return c.result(scope);
    }
    const recipient = await checkRecipient(db, c, scope, lead.countryCode, primary);
    if (!recipient) return c.result(scope);

    // Aynı kampanyada aynı lead/adres veya aynı alan adı (alan adı başına tek dizi → en çok 3 ileti).
    if (campaign) {
      const inCampaignAll = await db
        .select({
          id: campaignLeads.id,
          leadId: campaignLeads.leadId,
          hash: campaignLeads.recipientHash,
          domain: campaignLeads.recipientDomain,
          status: campaignLeads.status,
        })
        .from(campaignLeads)
        .where(eq(campaignLeads.campaignId, campaign.id));
      const inCampaign = inCampaignAll.filter((r) => r.id !== opts.ignoreCampaignLeadId);
      if (inCampaign.some((r) => r.leadId === lead.id || r.hash === recipient.hash)) {
        c.add("already_in_campaign");
      } else if (
        inCampaign.some(
          (r) =>
            r.domain === recipient.domain &&
            !["excluded", "removed", "cancelled"].includes(r.status),
        )
      ) {
        c.add("domain_already_in_campaign");
      }
    }

    // Başka kampanyada sürmekte olan dizi.
    const active = await db
      .select({ id: campaignLeads.id })
      .from(campaignLeads)
      .where(
        and(
          eq(campaignLeads.recipientHash, recipient.hash),
          ne(campaignLeads.campaignId, input.campaignId),
          inArray(campaignLeads.status, [...ACTIVE_SEQUENCE]),
        ),
      )
      .limit(1);
    if (active.length > 0) c.add("active_sequence_elsewhere");

    await checkHistory(db, c, recipient.hash, now, limits, null);
    return c.result(scope);
  } catch (e) {
    c.add("evaluation_error", { detail: e instanceof Error ? e.name : "unknown" });
    return c.result(scope);
  }
}

/** Bir kampanya dizisinin `stepIndex` adımı ŞU AN gönderilebilir mi? Sağlayıcı çağrısından hemen önce çağrılır. */
export async function evaluateSend(
  db: DbExecutor,
  input: { campaignLeadId: number; stepIndex: number },
  opts: EligibilityOptions = {},
): Promise<EligibilityResult> {
  const c = new Collector();
  let scope: PolicyScope = "live";
  try {
    const now = opts.now ?? Date.now();
    const limits = resolveLimits(opts, c);
    await checkSender(db, c);

    const [cl] = await db
      .select()
      .from(campaignLeads)
      .where(eq(campaignLeads.id, input.campaignLeadId))
      .limit(1);
    if (!cl) {
      c.add("campaign_lead_not_found");
      return c.result(scope);
    }
    const campaign = await loadCampaign(db, cl.campaignId, c);
    if (campaign) {
      scope = await checkMailbox(db, campaign.mailboxId, c);
      if (campaign.status !== "running" || campaign.startConfirmedAt === null) {
        c.add("campaign_not_active", { detail: campaign.status });
      }
    }

    if (cl.status === "replied") c.add("reply_received");
    else if (cl.status !== "scheduled" && cl.status !== "waiting_next") {
      c.add("campaign_lead_not_sendable", { detail: cl.status });
    }

    const step = input.stepIndex;
    if (!Number.isInteger(step) || step < 0 || step >= limits.maxMessagesPerSequence) {
      c.add("step_out_of_range");
    } else if (step !== cl.nextStep) {
      c.add("step_out_of_range", { detail: `expected:${cl.nextStep}` });
    }

    const lead = await loadLead(db, cl.leadId, c);

    // Alıcı: dizinin anlık görüntüsü ile lead e-posta kaydı birebir tutmalı.
    let recipient: { hash: string; domain: string } | null = null;
    if (cl.redactedAt !== null || !cl.recipientEmail) c.add("recipient_redacted");
    else if (cl.emailId === null) c.add("email_removed");
    else {
      const [emailRow] = await db
        .select()
        .from(leadEmails)
        .where(eq(leadEmails.id, cl.emailId))
        .limit(1);
      if (!emailRow) c.add("email_removed");
      else if (
        emailRow.leadId !== cl.leadId ||
        emailRow.email !== cl.recipientEmail ||
        cl.recipientHash !== hashEmail(emailRow.email) ||
        cl.recipientDomain !== emailRow.domain
      ) {
        c.add("recipient_mismatch");
      } else if (lead) {
        recipient = await checkRecipient(db, c, scope, lead.countryCode, emailRow);
      }
    }

    // Adım tanımı ve takip aralığı.
    const stepRows = await db
      .select({ language: campaignSteps.language, delayDays: campaignSteps.delayDays })
      .from(campaignSteps)
      .where(and(eq(campaignSteps.campaignId, cl.campaignId), eq(campaignSteps.stepIndex, step)));
    const stepDef =
      stepRows.find((s) => s.language === cl.language) ?? (cl.language ? undefined : stepRows[0]);
    if (!stepDef) c.add("step_missing");

    // Bu dizinin iletileri.
    const own = await db
      .select({
        stepIndex: messages.stepIndex,
        status: messages.status,
        idempotencyKey: messages.idempotencyKey,
        sentAt: messages.sentAt,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.campaignLeadId, cl.id),
          eq(messages.direction, "out"),
          eq(messages.purpose, "campaign"),
        ),
      );
    const key = `cl:${cl.id}:s:${step}`;
    if (
      own.some(
        (m) => m.idempotencyKey === key && (CONTACTED as readonly string[]).includes(m.status),
      )
    ) {
      c.add("already_sent");
    }
    if (own.some((m) => (UNRESOLVED as readonly string[]).includes(m.status)))
      c.add("unresolved_delivery");
    const counted = own.filter(
      (m) =>
        (CONTACTED as readonly string[]).includes(m.status) ||
        (m.status === "queued" && m.idempotencyKey !== key),
    );
    if (counted.length >= limits.maxMessagesPerSequence) c.add("sequence_limit");

    if (step > 0) {
      const prev = own.find(
        (m) => m.stepIndex === step - 1 && m.status === "sent" && m.sentAt !== null,
      );
      if (!prev) c.add("previous_step_not_sent");
      else {
        const gapDays = Math.max(limits.minFollowupGapDays, stepDef?.delayDays ?? 0);
        const until = addDays(prev.sentAt!, gapDays);
        if (now < until) c.add("followup_too_soon", { until });
      }
    }

    // Bu diziye gelen yanıt (otomatik takip durur).
    const replies = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "in"),
          eq(messages.campaignLeadId, cl.id),
          inArray(messages.classification, ["reply", "negative", "unsubscribe"]),
        ),
      )
      .limit(1);
    if (replies.length > 0) c.add("reply_received");

    if (recipient) {
      await checkHistory(db, c, recipient.hash, now, limits, cl.id);
      // Alan adı başına günlük sınır (UTC günü; veritabanı dizini de zorlar).
      const day = utcDay(now);
      const sameDay = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.peerDomain, recipient.domain),
            eq(messages.sendDay, day),
            eq(messages.direction, "out"),
            eq(messages.purpose, "campaign"),
            inArray(messages.status, [...CONTACTED]),
          ),
        );
      if (sameDay.length >= limits.maxDomainMessagesPerDay) {
        c.add("domain_daily_cap", { until: Date.parse(`${day}T00:00:00.000Z`) + DAY_MS });
      }
    }
    return c.result(scope);
  } catch (e) {
    c.add("evaluation_error", { detail: e instanceof Error ? e.name : "unknown" });
    return c.result(scope);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Ortak kontroller
 * ---------------------------------------------------------------------------------------------- */

function resolveLimits(opts: EligibilityOptions, c: Collector): FrequencyLimits {
  if (!opts.limits) return { ...DEFAULT_FREQUENCY_LIMITS };
  if (!isAtLeastAsStrict(opts.limits)) {
    c.add("invalid_limits");
    return { ...DEFAULT_FREQUENCY_LIMITS };
  }
  return opts.limits;
}

/** Kullanım onayı ve eksiksiz gönderen firma profili olmadan ticari ileti olmaz (FR-SET-07/08, FR-CMPL-08). */
async function checkSender(db: DbExecutor, c: Collector) {
  const s = await getSettings(db, ["consent", "company.profile"] as const);
  if (!s.consent) c.add("consent_missing");
  if (!s["company.profile"]) c.add("sender_profile_incomplete");
}

async function loadCampaign(db: DbExecutor, id: number, c: Collector) {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!row) c.add("campaign_not_found");
  return row ?? null;
}

/** Posta kutusu kapsamı belirler. Demo dışı her sağlayıcı `live`'dır ve bu sürümde gönderemez. */
async function checkMailbox(
  db: DbExecutor,
  mailboxId: number | null,
  c: Collector,
): Promise<PolicyScope> {
  if (mailboxId === null) {
    c.add("mailbox_missing");
    return "live";
  }
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (!mb) {
    c.add("mailbox_missing");
    return "live";
  }
  const scope = policyScopeForMailbox(mb.provider);
  if (scope === "live" && !LIVE_SENDING_ENABLED) c.add("live_sending_disabled");
  if (mb.status !== "connected") c.add("mailbox_not_ready", { detail: mb.status });
  return scope;
}

async function loadLead(db: DbExecutor, id: number, c: Collector) {
  const [row] = await db
    .select({ id: leads.id, status: leads.status, countryCode: leads.countryCode })
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  if (!row) {
    c.add("lead_not_found");
    return null;
  }
  if (BLOCKED_LEAD_STATUSES.has(row.status)) c.add("lead_status_blocked", { detail: row.status });
  return row;
}

/** Adres niteliği, ülke politikası ve suppression. Adres çözümlenemezse null döner. */
async function checkRecipient(
  db: DbExecutor,
  c: Collector,
  scope: PolicyScope,
  countryCode: string | null,
  email: { email: string; kind: string; verifyStatus: string },
): Promise<{ hash: string; domain: string } | null> {
  const parsed = parseEmail(email.email);
  if (!parsed || parsed.email !== email.email) {
    c.add("email_invalid");
    return null;
  }
  if (email.verifyStatus !== "verified")
    c.add("email_not_verified", { detail: email.verifyStatus });
  // Kayıtlı tür ile yeniden hesaplanan tür birlikte "generic" olmalı (çelişkide sıkı olan geçerli).
  const computed = classifyKind(parsed);
  const generic = email.kind === "generic" && computed === "generic";
  if (email.kind === "consumer" || computed === "consumer" || isConsumerDomain(parsed.domain)) {
    c.add("email_consumer");
  } else if (!generic) {
    c.add("email_personal");
  }

  const policy = await resolveCountryPolicy(db, scope, countryCode);
  if (policy.mode === "blocked") c.add("country_blocked", { detail: policy.reason ?? "policy" });
  else if (policy.mode === "generic_only" && !generic) c.add("country_generic_only");

  const sup = await checkSuppression(db, parsed.email);
  if (sup.suppressed) {
    for (const m of sup.matches) c.add("suppressed", { detail: `${m.scope}:${m.reason}` });
    if (sup.matches.length === 0) c.add("suppressed", { detail: "invalid_address" });
  }
  return { hash: hashEmail(parsed.email), domain: parsed.domain };
}

/**
 * Bu adrese daha önce (başka dizilerde) gönderilmiş kampanya iletileri:
 *  - belirsiz ileti varsa: `unresolved_delivery`,
 *  - herhangi bir önceki temas: `recontact_requires_review` (yalnızca kampanyaya eklemede),
 *  - yanıtsız tamamlanan dizi: son temastan itibaren `rest_period` (180 gün),
 *  - diğer bitmiş/iptal diziler: son temastan itibaren `cross_campaign_gap` (30 gün).
 * Dizi kaydı bulunamayan veya çelişkili geçmiş, güvenli tarafta "yanıtsız tamamlandı" sayılır.
 */
async function checkHistory(
  db: DbExecutor,
  c: Collector,
  hash: string,
  now: number,
  limits: FrequencyLimits,
  currentCampaignLeadId: number | null,
) {
  const history = await db
    .select({
      campaignLeadId: messages.campaignLeadId,
      status: messages.status,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.peerHash, hash),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        inArray(messages.status, ["queued", ...CONTACTED]),
      ),
    );
  const others = history.filter((m) => m.campaignLeadId !== currentCampaignLeadId);
  if (others.some((m) => (UNRESOLVED as readonly string[]).includes(m.status)))
    c.add("unresolved_delivery");

  const contacted = others.filter((m) => (CONTACTED as readonly string[]).includes(m.status));
  if (contacted.length === 0) return;
  if (currentCampaignLeadId === null) c.add("recontact_requires_review");

  const bySequence = new Map<number | null, number>();
  for (const m of contacted) {
    const at = Math.max(m.sentAt ?? 0, m.createdAt);
    bySequence.set(m.campaignLeadId, Math.max(bySequence.get(m.campaignLeadId) ?? 0, at));
  }
  const ids = [...bySequence.keys()].filter((k): k is number => k !== null);
  const statuses = new Map(
    (ids.length
      ? await db
          .select({ id: campaignLeads.id, status: campaignLeads.status })
          .from(campaignLeads)
          .where(inArray(campaignLeads.id, ids))
      : []
    ).map((r) => [r.id, r.status]),
  );
  for (const [seq, lastAt] of bySequence) {
    const status = seq === null ? undefined : statuses.get(seq);
    const completedNoReply = status === undefined || status === "completed";
    if (completedNoReply) {
      const until = addDays(lastAt, limits.restAfterSequenceDays);
      if (now < until) c.add("rest_period", { until });
    }
    const gapUntil = addDays(lastAt, limits.crossCampaignGapDays);
    if (now < gapUntil) c.add("cross_campaign_gap", { until: gapUntil });
  }
}
