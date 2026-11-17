import { and, asc, eq, gte, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { getDomain } from "tldts";
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
import { isLiveSendingPermitted } from "./live-gate";
import { policyScopeForMailbox, resolveCountryPolicy, type ResolvedPolicy } from "./policies";
import {
  loadRecipientRestriction,
  RESTRICTION_RECHECK_MS,
  type ResolvedRestriction,
} from "./recipient-restriction";
import {
  checkSuppression,
  checkSuppressionBatch,
  hashEmail,
  type SuppressionCheck,
} from "./suppression";

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
 * geçerlidir ve GERÇEK GÖNDERİM İZNİ DEĞİLDİR; demo dışındaki her sağlayıcı `live` sayılır. Canlı gönderim kapısı
 * (`isLiveSendingPermitted`) kapalıysa `live_sending_disabled` ile reddedilir; açıkken (bu sürüm) canlı ülke politikası
 * (kilitli ülke `country_blocked`), bağlı kutu ve `gmail.send` izni ayrıca zorunludur.
 *
 * Bu aşamadaki kararlar: yalnızca doğrulanmış (`verified`) GENEL işletme adreslerine gönderilir (`personal` ve
 * `consumer` hariç); daha önce kampanya iletisi almış bir alıcı, süreler dolsa da elle inceleme gerektirir.
 *
 * İşletme başına sınırlar (SRS 5.6.1 "Aynı işletme veya aynı e-posta adresine", go-live C8): adres sınırlarına EK
 * olarak işletme de sayılır. İşletme = lead kaydı (yer kaydı başına tek lead) VEYA alıcının kayıtlı alan adı
 * (`businessDomainOf`; kişisel posta sağlayıcıları ve genel uzantılar işletme sayılmaz). Kurallar:
 *  - bir kampanyada işletme başına tek dizi (`business_already_in_campaign`; dağıtıcı dışlar),
 *  - başka kampanyada aynı işletmenin başka adresine yapılan temastan sonra adres sınırlarıyla aynı bekleme
 *    (yanıtsız tamamlanan dizide dinlenme, aksi halde kampanyalar arası aralık; `business_contact_cooldown`;
 *    dağıtıcı erteler).
 * Engeller (suppression) ADRES veya açık ALAN ADI kapsamlıdır; bir adresin çıkışı/şikâyeti aynı işletmenin diğer
 * adreslerini kendiliğinden engellemez. İşletme düzeyindeki kesin "iletişim kurma" kararı lead durumudur
 * (`do_not_contact`) ve `lead_status_blocked` ile uygulanır.
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
  | "lead_not_demo"
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
  /** Test alıcı sınırı açık ve adres izinli listede değil: dizi ertelenir (dışlanmaz), bkz. recipient-restriction.ts. */
  | "recipient_not_allowed"
  | "already_in_campaign"
  | "domain_already_in_campaign"
  | "business_already_in_campaign"
  | "active_sequence_elsewhere"
  | "recontact_requires_review"
  | "rest_period"
  | "cross_campaign_gap"
  | "business_contact_cooldown"
  | "unresolved_delivery"
  | "step_out_of_range"
  | "step_missing"
  | "sequence_limit"
  | "already_sent"
  | "previous_step_not_sent"
  | "followup_too_soon"
  | "reply_received"
  | "inbound_review_pending"
  | "domain_daily_cap";

/** İncelemede bekleyen yanıt varken takibin yeniden denetlenme aralığı (6 saat). */
export const INBOUND_REVIEW_RECHECK_MS = 6 * 3_600_000;

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
   * `pending` dizilerin yeniden denetlenmesi için kullanılır; diğer bütün kontroller aynen uygulanır. Bu dizi `pending`
   * ise aynı alan adındaki/işletmedeki büyük kimlikli `pending` kardeş onu engellemez (küçük kimlik kazanır).
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
export const ACTIVE_SEQUENCE: readonly CampaignLeadStatus[] = [
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
  const batch = await prepareEnrollmentBatch(db, input.campaignId, [input.leadId], opts);
  return batch.evaluate({ leadId: input.leadId, ignoreCampaignLeadId: opts.ignoreCampaignLeadId });
}

/** Toplu değerlendirmede bir satır: lead ve (yeniden denetimde) kampanyadaki kendi dizisi. */
export interface EnrollmentRow {
  leadId: number;
  /** `EligibilityOptions.ignoreCampaignLeadId` ile aynı anlam (satır başına). */
  ignoreCampaignLeadId?: number;
}

/** Hedef kampanyadaki dizinin değerlendirmede kullanılan görüntüsü. */
export interface InCampaignSeq {
  id: number;
  leadId: number;
  hash: string | null;
  domain: string | null;
  status: CampaignLeadStatus;
}

type LeadRow = { id: number; status: LeadStatus; countryCode: string | null; source: string };
type PrimaryEmail = typeof leadEmails.$inferSelect;

/**
 * Kampanyaya ekleme/başlatma denetimi için önceden yüklenmiş veri. Sorgular lead sayısından BAĞIMSIZ sayıdadır
 * (500'lük parçalar): ayarlar, kampanya ve kutu bir kez; lead'ler, birincil adresler, engeller, başka kampanyadaki
 * diziler, adres ve işletme geçmişi toplu. `evaluate` saf bellek içi değerlendirmedir ve `evaluateEnrollment` ile
 * AYNI kuralları aynı sırayla uygular.
 *
 * `inCampaign`: hedef kampanyanın dizileri (bir kez yüklenir). Aynı işlemde dizi ekleyen/değiştiren çağıran (ekleme,
 * yeniden denetim) değişikliği buraya da yansıtır; böylece önceki eklemeler sonraki lead'lerin değerlendirmesinde
 * görünür (yeniden sorgu olmadan).
 */
export interface EnrollmentBatch {
  readonly inCampaign: InCampaignSeq[];
  evaluate(row: EnrollmentRow): EligibilityResult;
  /** Önceden yüklenmiş lead (yoksa `undefined`). */
  leadOf(leadId: number): LeadRow | undefined;
  /** Önceden yüklenmiş birincil adres (yoksa `undefined`). */
  primaryOf(leadId: number): PrimaryEmail | undefined;
}

const PREFETCH_CHUNK = 500;
/** Alan adı LIKE ön süzgecinde bir sorgudaki en çok alan adı (her biri bir LIKE terimi). */
const DOMAIN_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Kampanyaya eklenecek/başlatılacak lead'ler için veriyi toplu yükler; bkz. `EnrollmentBatch`. */
export async function prepareEnrollmentBatch(
  db: DbExecutor,
  campaignId: number,
  leadIdsIn: readonly number[],
  opts: EligibilityOptions = {},
): Promise<EnrollmentBatch> {
  const now = opts.now ?? Date.now();
  const global = new Collector();
  const limits = resolveLimits(opts, global);
  let scope: PolicyScope = "live";
  const leadMap = new Map<number, LeadRow>();
  const primaryMap = new Map<number, PrimaryEmail>();
  const policies = new Map<string | null, ResolvedPolicy>();
  let sup = new Map<string, SuppressionCheck>();
  const inCampaign: InCampaignSeq[] = [];
  const contactedInCampaign = new Set<number>();
  const activeHashes = new Set<string>();
  const activeLeads = new Set<number>();
  const sendingBusinesses = new Set<string>();
  const historyByHash = new Map<string, HistoryRow[]>();
  const bizByLead = new Map<number, BusinessRow[]>();
  const bizByDomain = new Map<string, BusinessRow[]>();
  const statuses = new Map<number, CampaignLeadStatus>();
  let campaign: typeof campaigns.$inferSelect | null = null;
  let restriction: ResolvedRestriction | null = null;
  let failure: unknown = null;

  try {
    const s = await getSettings(db, ["consent", "company.profile", "mail.gmailGrants"] as const);
    if (!s.consent) global.add("consent_missing");
    if (!s["company.profile"]) global.add("sender_profile_incomplete");
    campaign = await loadCampaign(db, campaignId, global);
    if (campaign) {
      const [mb] =
        campaign.mailboxId === null
          ? []
          : await db.select().from(mailboxes).where(eq(mailboxes.id, campaign.mailboxId)).limit(1);
      scope = applyMailbox(campaign.mailboxId, mb, s["mail.gmailGrants"], global);
      // Test alıcı sınırı (yalnızca gerçek kapsam). Yüklenemezse toplu hazırlık `evaluation_error` verir (güvenli taraf).
      if (scope === "live") restriction = await loadRecipientRestriction(db);
      if (["completed", "cancelled", "stopped"].includes(campaign.status)) {
        global.add("campaign_closed", { detail: campaign.status });
      }
    }

    const leadIds = [...new Set(leadIdsIn)];
    for (const part of chunks(leadIds, PREFETCH_CHUNK)) {
      const rows = await db
        .select({
          id: leads.id,
          status: leads.status,
          countryCode: leads.countryCode,
          source: leads.source,
        })
        .from(leads)
        .where(inArray(leads.id, part));
      for (const r of rows) leadMap.set(r.id, r);
      const emails = await db
        .select()
        .from(leadEmails)
        .where(and(inArray(leadEmails.leadId, part), eq(leadEmails.isPrimary, true)))
        .orderBy(asc(leadEmails.id));
      for (const e of emails) if (!primaryMap.has(e.leadId)) primaryMap.set(e.leadId, e);
    }

    // Değerlendirilebilecek alıcılar (adres çözümlenebiliyorsa): engel, geçmiş ve işletme sorguları için.
    const recipients: Array<{
      leadId: number;
      email: string;
      hash: string;
      business: string | null;
    }> = [];
    for (const id of leadIds) {
      const lead = leadMap.get(id);
      const primary = primaryMap.get(id);
      if (!lead || !primary) continue;
      if (!policies.has(lead.countryCode))
        policies.set(lead.countryCode, await resolveCountryPolicy(db, scope, lead.countryCode));
      const parsed = parseEmail(primary.email);
      if (!parsed || parsed.email !== primary.email) continue;
      recipients.push({
        leadId: id,
        email: parsed.email,
        hash: hashEmail(parsed.email),
        business: businessDomainOf(parsed.domain),
      });
    }
    sup = await checkSuppressionBatch(
      db,
      recipients.map((r) => r.email),
    );
    const hashes = [...new Set(recipients.map((r) => r.hash))];
    const recLeadIds = [...new Set(recipients.map((r) => r.leadId))];
    const businesses = [
      ...new Set(recipients.map((r) => r.business).filter((d): d is string => d !== null)),
    ];

    // Hedef kampanyanın dizileri (bir kez) ve bu kampanyada ileti gitmiş diziler.
    if (campaign) {
      inCampaign.push(
        ...(await db
          .select({
            id: campaignLeads.id,
            leadId: campaignLeads.leadId,
            hash: campaignLeads.recipientHash,
            domain: campaignLeads.recipientDomain,
            status: campaignLeads.status,
          })
          .from(campaignLeads)
          .where(eq(campaignLeads.campaignId, campaign.id))
          .orderBy(asc(campaignLeads.id))),
      );
      const contacted = await db
        .selectDistinct({ id: messages.campaignLeadId })
        .from(messages)
        .where(
          and(
            eq(messages.campaignId, campaign.id),
            eq(messages.direction, "out"),
            eq(messages.purpose, "campaign"),
            inArray(messages.status, [...CONTACTED]),
          ),
        );
      for (const r of contacted) if (r.id !== null) contactedInCampaign.add(r.id);
    }

    // Başka kampanyada süren diziler: aynı adres / aynı lead; ve gönderimi başlamış aynı işletme alan adı.
    const elsewhere = (cond: SQL | undefined) =>
      db
        .select({ hash: campaignLeads.recipientHash, leadId: campaignLeads.leadId })
        .from(campaignLeads)
        .where(
          and(
            cond,
            ne(campaignLeads.campaignId, campaignId),
            inArray(campaignLeads.status, [...ACTIVE_SEQUENCE]),
          ),
        );
    for (const part of chunks(hashes, PREFETCH_CHUNK))
      for (const r of await elsewhere(inArray(campaignLeads.recipientHash, part)))
        if (r.hash) activeHashes.add(r.hash);
    for (const part of chunks(recLeadIds, PREFETCH_CHUNK))
      for (const r of await elsewhere(inArray(campaignLeads.leadId, part)))
        activeLeads.add(r.leadId);
    for (const part of chunks(businesses, DOMAIN_CHUNK)) {
      const rows = await db
        .select({ domain: campaignLeads.recipientDomain })
        .from(campaignLeads)
        .where(
          and(
            anyDomainMatches(campaignLeads.recipientDomain, part),
            ne(campaignLeads.campaignId, campaignId),
            inArray(campaignLeads.status, [...SENDING_SEQUENCE]),
          ),
        );
      for (const r of rows) {
        const b = businessDomainOf(r.domain);
        if (b) sendingBusinesses.add(b);
      }
    }

    // Adres geçmişi ve işletme geçmişi (başka adresler; lead veya işletme alan adı).
    for (const part of chunks(hashes, PREFETCH_CHUNK)) {
      const rows = await db
        .select(HISTORY_COLS)
        .from(messages)
        .where(
          and(
            inArray(messages.peerHash, part),
            eq(messages.direction, "out"),
            eq(messages.purpose, "campaign"),
            inArray(messages.status, ["queued", ...CONTACTED]),
          ),
        );
      for (const r of rows)
        historyByHash.set(r.peerHash!, [...(historyByHash.get(r.peerHash!) ?? []), r]);
    }
    const bizRows = new Map<number, BusinessRow>();
    const bizWhere = (cond: SQL | undefined) =>
      db
        .select(BUSINESS_COLS)
        .from(messages)
        .where(
          and(
            cond,
            eq(messages.direction, "out"),
            eq(messages.purpose, "campaign"),
            inArray(messages.status, [...CONTACTED]),
          ),
        );
    for (const part of chunks(recLeadIds, PREFETCH_CHUNK))
      for (const r of await bizWhere(inArray(messages.leadId, part))) bizRows.set(r.id, r);
    for (const part of chunks(businesses, DOMAIN_CHUNK))
      for (const r of await bizWhere(anyDomainMatches(messages.peerDomain, part)))
        bizRows.set(r.id, r);
    for (const r of bizRows.values()) {
      if (r.leadId !== null) bizByLead.set(r.leadId, [...(bizByLead.get(r.leadId) ?? []), r]);
      const b = businessDomainOf(r.peerDomain);
      if (b) bizByDomain.set(b, [...(bizByDomain.get(b) ?? []), r]);
    }
    const seqIds = [
      ...new Set(
        [...[...historyByHash.values()].flat(), ...bizRows.values()]
          .map((r) => r.campaignLeadId)
          .filter((x): x is number => x !== null),
      ),
    ];
    for (const part of chunks(seqIds, PREFETCH_CHUNK)) {
      const rows = await db
        .select({ id: campaignLeads.id, status: campaignLeads.status })
        .from(campaignLeads)
        .where(inArray(campaignLeads.id, part));
      for (const r of rows) statuses.set(r.id, r.status);
    }
  } catch (e) {
    failure = e;
  }

  const evaluate = (row: EnrollmentRow): EligibilityResult => {
    const c = new Collector();
    for (const r of global.reasons) c.add(r.code, { ...r });
    if (failure !== null) {
      c.add("evaluation_error", { detail: failure instanceof Error ? failure.name : "unknown" });
      return c.result(scope);
    }
    try {
      const lead = applyLead(leadMap.get(row.leadId), c, scope);
      if (!lead) return c.result(scope);
      const primary = primaryMap.get(lead.id);
      if (!primary) {
        c.add("no_email");
        return c.result(scope);
      }
      const recipient = applyRecipient(
        c,
        primary,
        policies.get(lead.countryCode) ?? { mode: "blocked", reason: "unknown_country" },
        (email) => sup.get(email) ?? { suppressed: true, invalidAddress: true, matches: [] },
        restriction,
        now,
      );
      if (!recipient) return c.result(scope);

      // Aynı kampanyada aynı lead/adres veya aynı alan adı (alan adı başına tek dizi → en çok 3 ileti).
      if (campaign) {
        const inCampaignAll = inCampaign;
        const inCamp = inCampaignAll.filter((r) => r.id !== row.ignoreCampaignLeadId);
        // Başlatma öncesi yeniden denetimde (`pending` dizinin kendisi) eski çift `pending` diziler arasında
        // gönderimdeki kural uygulanır: küçük kimlik işletmeyi tutar; büyük kimlikli `pending` kardeş bu diziyi
        // engellemez (yoksa ikisi de dışlanır ve işletmeye hiç yazılmaz).
        const self = inCampaignAll.find((r) => r.id === row.ignoreCampaignLeadId);
        const siblings =
          self?.status === "pending"
            ? inCamp.filter((r) => !(r.status === "pending" && r.id > self.id))
            : inCamp;
        if (inCamp.some((r) => r.leadId === lead.id || r.hash === recipient.hash)) {
          c.add("already_in_campaign");
        } else if (
          siblings.some(
            (r) =>
              r.domain === recipient.domain &&
              !["excluded", "removed", "cancelled"].includes(r.status),
          )
        ) {
          c.add("domain_already_in_campaign");
        } else {
          applyCampaignBusinessAtEnrollment(
            c,
            businessDomainOf(recipient.domain),
            siblings,
            contactedInCampaign,
          );
        }
      }

      // Başka kampanyada sürmekte olan dizi: aynı adres veya aynı lead (işletme); yoksa aynı işletme alan adında
      // gönderimi başlamış dizi (`pending` sayılmaz: başlatılmamış taslak başka kampanyayı kilitlemez).
      const business = { leadId: lead.id, domain: businessDomainOf(recipient.domain) };
      if (activeHashes.has(recipient.hash) || activeLeads.has(lead.id))
        c.add("active_sequence_elsewhere");
      else if (business.domain && sendingBusinesses.has(business.domain)) {
        c.add("active_sequence_elsewhere", { detail: "business" });
      }

      applyHistory(c, historyByHash.get(recipient.hash) ?? [], statuses, now, limits, null);
      const candidates = new Map<number, BusinessRow>();
      for (const r of bizByLead.get(lead.id) ?? []) candidates.set(r.id, r);
      if (business.domain)
        for (const r of bizByDomain.get(business.domain) ?? []) candidates.set(r.id, r);
      applyBusinessHistory(
        c,
        [...candidates.values()].filter(
          (m) => m.peerHash !== null && m.peerHash !== recipient.hash,
        ),
        { ...business, campaignId },
        statuses,
        now,
        limits,
      );
      return c.result(scope);
    } catch (e) {
      c.add("evaluation_error", { detail: e instanceof Error ? e.name : "unknown" });
      return c.result(scope);
    }
  };

  return {
    inCampaign,
    evaluate,
    leadOf: (id) => leadMap.get(id),
    primaryOf: (id) => primaryMap.get(id),
  };
}

/** Toplu değerlendirme: satırlar sırayla, `evaluateEnrollment` ile aynı sonuçlar (bkz. `prepareEnrollmentBatch`). */
export async function evaluateEnrollmentBatch(
  db: DbExecutor,
  campaignId: number,
  rows: readonly EnrollmentRow[],
  opts: EligibilityOptions = {},
): Promise<EligibilityResult[]> {
  const batch = await prepareEnrollmentBatch(
    db,
    campaignId,
    rows.map((r) => r.leadId),
    opts,
  );
  return rows.map((r) => batch.evaluate(r));
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

    const lead = await loadLead(db, cl.leadId, c, scope);

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
        recipient = await checkRecipient(db, c, scope, lead.countryCode, emailRow, now);
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
        rfcMessageId: messages.rfcMessageId,
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

    // Faz 4 (9a): alıcıdan gelen ve İNCELEMEDE bekleyen (doğrulanmamış yanıt/çıkış veya "olumsuz") ileti varken takip
    // gönderilmez. Bu ileti diziye bağlanmamıştır (kanıt yetersiz), bu yüzden yukarıdaki yanıt denetimi onu görmez.
    // Karar verilince kendiliğinden kalkar: yanıt/çıkış diziyi bitirir, "yok say" takibin sürmesine izin verir.
    if (step > 0 && replies.length === 0) {
      const contacted = own.filter((m) => (CONTACTED as readonly string[]).includes(m.status));
      if (contacted.length > 0) {
        const firstSentAt = Math.min(...contacted.map((m) => m.sentAt ?? m.createdAt));
        const ownIds = contacted
          .map((m) => m.rfcMessageId)
          .filter((x): x is string => typeof x === "string" && x.length > 0);
        const fromRecipient = cl.recipientHash
          ? eq(messages.peerHash, cl.recipientHash)
          : undefined;
        const inThread = ownIds.length > 0 ? inArray(messages.inReplyTo, ownIds) : undefined;
        const match =
          fromRecipient && inThread ? or(fromRecipient, inThread) : (fromRecipient ?? inThread);
        if (match) {
          const pending = await db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.direction, "in"),
                eq(messages.status, "received"),
                gte(sql`coalesce(${messages.receivedAt}, ${messages.createdAt})`, firstSentAt),
                match,
              ),
            )
            .limit(1);
          if (pending.length > 0) {
            c.add("inbound_review_pending", { until: now + INBOUND_REVIEW_RECHECK_MS });
          }
        }
      }
    }

    if (recipient) {
      await checkHistory(db, c, recipient.hash, now, limits, cl.id);
      const businessDomain = businessDomainOf(recipient.domain);
      await checkBusinessHistory(
        db,
        c,
        {
          leadId: cl.leadId,
          domain: businessDomain,
          hash: recipient.hash,
          campaignId: cl.campaignId,
        },
        now,
        limits,
      );
      await checkCampaignBusinessAtSend(db, c, cl, businessDomain, own);
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

/**
 * Posta kutusu kapsamı belirler. Demo dışı her sağlayıcı `live`'dır; canlı kutu yalnızca canlı gönderim kapısı açıkken,
 * bağlıyken ve `gmail.send` izni kayıtlıyken gönderebilir.
 */
async function checkMailbox(
  db: DbExecutor,
  mailboxId: number | null,
  c: Collector,
): Promise<PolicyScope> {
  const [mb] =
    mailboxId === null
      ? []
      : await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  const needsGrants =
    !!mb &&
    mb.status === "connected" &&
    policyScopeForMailbox(mb.provider) === "live" &&
    isLiveSendingPermitted();
  const grants = needsGrants
    ? (await getSettings(db, ["mail.gmailGrants"] as const))["mail.gmailGrants"]
    : {};
  return applyMailbox(mailboxId, mb, grants, c);
}

function applyMailbox(
  mailboxId: number | null,
  mb: typeof mailboxes.$inferSelect | undefined,
  grants: Record<string, { send?: boolean } | undefined>,
  c: Collector,
): PolicyScope {
  if (mailboxId === null || !mb) {
    c.add("mailbox_missing");
    return "live";
  }
  const scope = policyScopeForMailbox(mb.provider);
  if (scope === "live" && !isLiveSendingPermitted()) c.add("live_sending_disabled");
  if (mb.status !== "connected") {
    // Google yetkisi geçersiz/iptal (`invalid_grant`): ayrı ayrıntı; dağıtıcı kampanyayı duraklatmaz, ERTELER.
    const reauth = mb.status === "error" && mb.lastError === "reauthorization_required";
    c.add("mailbox_not_ready", { detail: reauth ? "reauthorization_required" : mb.status });
  } else if (scope === "live" && isLiveSendingPermitted()) {
    // Bağlı ama `gmail.send` izni verilmemiş (yalnızca okuma veya izin geri alındı) kutu gönderemez: sağlayıcıya
    // ulaşmadan kampanya duraklar (aksi halde her dizi sağlayıcıda `scope_missing` ile başarısız sayılırdı).
    if (!grants[String(mb.id)]?.send) c.add("mailbox_not_ready", { detail: "send_grant_missing" });
  }
  return scope;
}

async function loadLead(db: DbExecutor, id: number, c: Collector, scope: PolicyScope) {
  const [row] = await db
    .select({
      id: leads.id,
      status: leads.status,
      countryCode: leads.countryCode,
      source: leads.source,
    })
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  return applyLead(row, c, scope);
}

function applyLead<T extends { status: LeadStatus; source: string }>(
  row: T | undefined,
  c: Collector,
  scope: PolicyScope,
): T | null {
  if (!row) {
    c.add("lead_not_found");
    return null;
  }
  if (BLOCKED_LEAD_STATUSES.has(row.status)) c.add("lead_status_blocked", { detail: row.status });
  // Demo kutusuyla yalnızca demo lead'leri: demo "gönderimi" gerçek bir işletmeyi temas kurulmuş göstermemeli
  // (lead durumu, `last_contacted_at` ve gönderim geçmişi kalıcıdır ve sonraki kampanyaları etkiler).
  if (scope === "demo" && row.source !== "demo") c.add("lead_not_demo");
  return row;
}

/** Adres niteliği, ülke politikası ve suppression. Adres çözümlenemezse null döner. */
async function checkRecipient(
  db: DbExecutor,
  c: Collector,
  scope: PolicyScope,
  countryCode: string | null,
  email: { email: string; kind: string; verifyStatus: string },
  now: number,
): Promise<{ hash: string; domain: string } | null> {
  const parsed = parseEmail(email.email);
  if (!parsed || parsed.email !== email.email) {
    c.add("email_invalid");
    return null;
  }
  const policy = await resolveCountryPolicy(db, scope, countryCode);
  const sup = await checkSuppression(db, parsed.email);
  // Test alıcı sınırı yalnızca gerçek (canlı) kapsamda uygulanır; demo kutusu gerçek kişilere ulaşmaz.
  const restriction = scope === "live" ? await loadRecipientRestriction(db) : null;
  return applyRecipient(c, email, policy, () => sup, restriction, now);
}

function applyRecipient(
  c: Collector,
  email: { email: string; kind: string; verifyStatus: string },
  policy: ResolvedPolicy,
  suppressionOf: (email: string) => SuppressionCheck,
  restriction: ResolvedRestriction | null,
  now: number,
): { hash: string; domain: string } | null {
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

  if (policy.mode === "blocked") c.add("country_blocked", { detail: policy.reason ?? "policy" });
  else if (policy.mode === "generic_only" && !generic) c.add("country_generic_only");

  const sup = suppressionOf(parsed.email);
  if (sup.suppressed) {
    for (const m of sup.matches) c.add("suppressed", { detail: `${m.scope}:${m.reason}` });
    if (sup.matches.length === 0) c.add("suppressed", { detail: "invalid_address" });
  }
  // Test alıcı sınırı (EK ret nedeni; yukarıdaki hiçbir kuralı gevşetmez): açıkken yalnızca listedeki tam adresler.
  // Sürekli bir neden değildir: sınır kalkınca/genişleyince dizi kaldığı yerden devam edebilir, bu yüzden dışlanmaz,
  // ertelenir (dağıtıcı: `EXCLUDE_CODES` dışındaki nedenler `until`e kadar ertelenir).
  if (restriction?.enabled && !restriction.addresses.has(parsed.email)) {
    c.add("recipient_not_allowed", { until: now + RESTRICTION_RECHECK_MS });
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
    .select(HISTORY_COLS)
    .from(messages)
    .where(
      and(
        eq(messages.peerHash, hash),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        inArray(messages.status, ["queued", ...CONTACTED]),
      ),
    );
  const statuses = await loadStatuses(db, history);
  applyHistory(c, history, statuses, now, limits, currentCampaignLeadId);
}

const HISTORY_COLS = {
  peerHash: messages.peerHash,
  campaignLeadId: messages.campaignLeadId,
  status: messages.status,
  sentAt: messages.sentAt,
  createdAt: messages.createdAt,
};
type HistoryRow = {
  peerHash: string | null;
  campaignLeadId: number | null;
  status: string;
  sentAt: number | null;
  createdAt: number;
};

/** İletilerin dizilerinin durumları (geçmiş kurallarında "yanıtsız tamamlandı" ayrımı için). */
async function loadStatuses(
  db: DbExecutor,
  rows: readonly { campaignLeadId: number | null }[],
): Promise<Map<number, CampaignLeadStatus>> {
  const ids = [
    ...new Set(rows.map((r) => r.campaignLeadId).filter((k): k is number => k !== null)),
  ];
  return new Map(
    (ids.length
      ? await db
          .select({ id: campaignLeads.id, status: campaignLeads.status })
          .from(campaignLeads)
          .where(inArray(campaignLeads.id, ids))
      : []
    ).map((r) => [r.id, r.status]),
  );
}

function applyHistory(
  c: Collector,
  history: readonly HistoryRow[],
  statuses: ReadonlyMap<number, CampaignLeadStatus>,
  now: number,
  limits: FrequencyLimits,
  currentCampaignLeadId: number | null,
) {
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

/* ------------------------------------------------------------------------------------------------
 * İşletme başına sınırlar (go-live C8)
 * ---------------------------------------------------------------------------------------------- */

/** Bir kampanyada işletmeyi "tutan" sayılmayan (kapanmış veya hiç başlamamış) dizi durumları. */
const CLOSED_IN_CAMPAIGN: readonly CampaignLeadStatus[] = ["excluded", "removed", "cancelled"];
/** Gönderimi başlamış, sürmekte olan dizi durumları (kampanya içi sıralama için). */
const SENDING_SEQUENCE: readonly CampaignLeadStatus[] = ["scheduled", "in_flight", "waiting_next"];

/**
 * Adresin işletme alan adı: kayıtlı alan adı (eTLD+1, Public Suffix List, özel uzantılar dahil; ör.
 * `shop.firma.de` → `firma.de`). Kişisel posta sağlayıcıları (gmail.com…) ve genel uzantının kendisi bir işletmeyi
 * temsil etmediği için `null` döner (bu adresler zaten gönderilemez; yine de alan adı eşleşmesine katılmaz).
 */
export function businessDomainOf(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (isConsumerDomain(d)) return null;
  const reg = getDomain(d, { allowPrivateDomains: true });
  if (!reg || isConsumerDomain(reg)) return null;
  return reg;
}

/** SQL ön süzgeci: alan adı `reg` veya onun alt alan adı. Kesin eşleşme `businessDomainOf` ile ayrıca yapılır. */
function domainMatches(
  column: typeof messages.peerDomain | typeof campaignLeads.recipientDomain,
  reg: string,
) {
  return or(eq(column, reg), like(column, `%.${reg}`));
}

/** `domainMatches`'in çok alan adlı ön süzgeci (toplu değerlendirme; kesin eşleşme yine `businessDomainOf`). */
function anyDomainMatches(
  column: typeof messages.peerDomain | typeof campaignLeads.recipientDomain,
  regs: readonly string[],
) {
  return or(inArray(column, [...regs]), ...regs.map((r) => like(column, `%.${r}`)));
}

/**
 * Eklemede kampanya içi işletme kontrolü (aynı lead/adres/tam alan adı kontrolleri tetiklenmediyse): aynı işletme alan
 * adında açık bir dizi VARSA veya kapanmış olsa bile bu kampanyada o işletmeye ileti GİTMİŞSE eklenmez.
 */
function applyCampaignBusinessAtEnrollment(
  c: Collector,
  businessDomain: string | null,
  inCampaign: readonly { id: number; domain: string | null; status: CampaignLeadStatus }[],
  contactedInCampaign: ReadonlySet<number>,
) {
  if (!businessDomain) return;
  const same = inCampaign.filter((r) => businessDomainOf(r.domain) === businessDomain);
  if (same.length === 0) return;
  if (same.some((r) => !CLOSED_IN_CAMPAIGN.includes(r.status))) {
    c.add("business_already_in_campaign");
    return;
  }
  if (same.some((r) => contactedInCampaign.has(r.id))) c.add("business_already_in_campaign");
}

/**
 * Gönderimde kampanya içi işletme kontrolü: aynı kampanyada aynı işletme alan adına giden BAŞKA bir dizi varsa
 * yalnızca biri gönderebilir. Sahip: işletmeye ilk iletisi gitmiş dizi (eşitlikte küçük kimlik); hiçbirine gitmemişse
 * gönderimi başlamış diziler arasında en küçük kimlik. Diğerleri `business_already_in_campaign` alır (dışlanır).
 * Normalde eklemedeki kontrol bunu önler; bu, eski veya yarışla oluşmuş kayıtlar için son savunmadır.
 */
async function checkCampaignBusinessAtSend(
  db: DbExecutor,
  c: Collector,
  cl: { id: number; campaignId: number },
  businessDomain: string | null,
  own: readonly { status: string; createdAt: number }[],
) {
  if (!businessDomain) return;
  const rows = await db
    .select({
      id: campaignLeads.id,
      domain: campaignLeads.recipientDomain,
      status: campaignLeads.status,
    })
    .from(campaignLeads)
    .where(
      and(
        eq(campaignLeads.campaignId, cl.campaignId),
        ne(campaignLeads.id, cl.id),
        domainMatches(campaignLeads.recipientDomain, businessDomain),
      ),
    );
  const same = rows.filter((r) => businessDomainOf(r.domain) === businessDomain);
  if (same.length === 0) return;
  const sent = await db
    .select({ campaignLeadId: messages.campaignLeadId, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        inArray(
          messages.campaignLeadId,
          same.map((r) => r.id),
        ),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        inArray(messages.status, [...CONTACTED]),
      ),
    );
  const firstOther = new Map<number, number>();
  for (const m of sent) {
    if (m.campaignLeadId === null) continue;
    const prev = firstOther.get(m.campaignLeadId);
    if (prev === undefined || m.createdAt < prev) firstOther.set(m.campaignLeadId, m.createdAt);
  }
  const ownTimes = own
    .filter((m) => (CONTACTED as readonly string[]).includes(m.status))
    .map((m) => m.createdAt);
  let blocked: boolean;
  if (ownTimes.length > 0) {
    const ownFirst = Math.min(...ownTimes);
    blocked = [...firstOther].some(([id, at]) => at < ownFirst || (at === ownFirst && id < cl.id));
  } else {
    blocked =
      firstOther.size > 0 || same.some((r) => r.id < cl.id && SENDING_SEQUENCE.includes(r.status));
  }
  if (blocked) c.add("business_already_in_campaign");
}

/**
 * Aynı işletmenin BAŞKA adreslerine (aynı lead veya aynı işletme alan adı) BAŞKA kampanyalarda yapılan temas.
 * Adresin kendi geçmişi `checkHistory`'dedir; burada adres sınırlarıyla aynı bekleme uygulanır: yanıtsız tamamlanan
 * dizide dinlenme süresi, aksi halde kampanyalar arası aralık (hangisi geç biterse). Belirsiz ileti
 * `unresolved_delivery` verir. Elle inceleme (`recontact_requires_review`) yalnızca adres düzeyindedir.
 */
async function checkBusinessHistory(
  db: DbExecutor,
  c: Collector,
  b: { leadId: number; domain: string | null; hash: string; campaignId: number },
  now: number,
  limits: FrequencyLimits,
) {
  const match = b.domain
    ? or(eq(messages.leadId, b.leadId), domainMatches(messages.peerDomain, b.domain))
    : eq(messages.leadId, b.leadId);
  const rows = await db
    .select(BUSINESS_COLS)
    .from(messages)
    .where(
      and(
        match,
        ne(messages.peerHash, b.hash),
        eq(messages.direction, "out"),
        eq(messages.purpose, "campaign"),
        inArray(messages.status, [...CONTACTED]),
      ),
    );
  applyBusinessHistory(c, rows, b, await loadStatuses(db, rows), now, limits);
}

const BUSINESS_COLS = {
  id: messages.id,
  campaignId: messages.campaignId,
  campaignLeadId: messages.campaignLeadId,
  leadId: messages.leadId,
  peerDomain: messages.peerDomain,
  peerHash: messages.peerHash,
  status: messages.status,
  sentAt: messages.sentAt,
  createdAt: messages.createdAt,
};
type BusinessRow = {
  id: number;
  campaignId: number | null;
  campaignLeadId: number | null;
  leadId: number | null;
  peerDomain: string | null;
  peerHash: string | null;
  status: string;
  sentAt: number | null;
  createdAt: number;
};

/** `rows`: bu işletmenin başka adreslerine giden aday iletiler (adresin kendi özeti hariç). */
function applyBusinessHistory(
  c: Collector,
  rows: readonly BusinessRow[],
  b: { leadId: number; domain: string | null; campaignId: number },
  statuses: ReadonlyMap<number, CampaignLeadStatus>,
  now: number,
  limits: FrequencyLimits,
) {
  const others = rows.filter(
    (m) =>
      m.campaignId !== b.campaignId &&
      (m.leadId === b.leadId || (b.domain !== null && businessDomainOf(m.peerDomain) === b.domain)),
  );
  if (others.length === 0) return;
  if (others.some((m) => (UNRESOLVED as readonly string[]).includes(m.status)))
    c.add("unresolved_delivery");

  const bySequence = new Map<number | null, number>();
  for (const m of others) {
    const at = Math.max(m.sentAt ?? 0, m.createdAt);
    bySequence.set(m.campaignLeadId, Math.max(bySequence.get(m.campaignLeadId) ?? 0, at));
  }
  let until = 0;
  for (const [seq, lastAt] of bySequence) {
    const status = seq === null ? undefined : statuses.get(seq);
    const completedNoReply = status === undefined || status === "completed";
    until = Math.max(until, addDays(lastAt, limits.crossCampaignGapDays));
    if (completedNoReply) until = Math.max(until, addDays(lastAt, limits.restAfterSequenceDays));
  }
  if (now < until) c.add("business_contact_cooldown", { until });
}
