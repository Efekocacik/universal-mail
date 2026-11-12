import crypto from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { evaluateEnrollment, type IneligibleCode } from "@/lib/compliance/eligibility";
import { DEFAULT_FREQUENCY_LIMITS, type FrequencyLimits } from "@/lib/compliance/frequency";
import { maskEmail } from "@/lib/compliance/suppression";
import type { DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leadEmails,
  mailboxes,
  templates,
} from "@/lib/db/schema";
import { pickTemplateLanguage, suggestLanguage } from "@/lib/mail/language";
import { isMailSchedulerEnabled } from "@/lib/mail/scheduler/job";
import { effectiveMailboxCap } from "@/lib/mail/scheduler/throttle";
import { effectiveWindow, nextWindowStart, timeZonesForCountry } from "@/lib/mail/scheduler/window";
import { composeEmail } from "@/lib/mail/template-service";
import { getSetting, getSettings } from "@/lib/settings";
import { CampaignError } from "./errors";
import { assertSendableMailbox } from "./service";

/**
 * Başlatma öncesi denetim ve özet (FR-CMP-04). Veritabanına YAZMAZ, ileti göndermez.
 *
 * - Kampanya geneli engeller: kullanım onayı, gönderen profili, gönderime uygun posta kutusu (demo; canlı kapı açıksa
 *   gönderim izinli Gmail), adımlar, pencere, zamanlayıcı (demo bayrağı veya canlı kapı), en az bir uygun dizi.
 * - Her `pending` dizi `evaluateEnrollment` ile yeniden denetlenir (dizinin kendisi "zaten kampanyada" sayılmaz);
 *   alıcı adresi eklendiği andan sonra değiştiyse dizi uygun sayılmaz.
 * - `confirmToken`: kampanyanın sürümü, adımlar ve uygun/uygunsuz dizilerden türetilir. Başlatma bu belirteci ister;
 *   arada herhangi biri değiştiyse başlatma reddedilir ve özet yeniden alınmalıdır.
 */

export type BlockerCode =
  | "consent_missing"
  | "sender_profile_incomplete"
  | "mailbox_missing"
  | "live_disabled"
  | "mailbox_not_ready"
  | "steps_missing"
  | "steps_invalid"
  | "invalid_send_window"
  | "scheduler_disabled"
  | "no_eligible_leads"
  | "campaign_not_startable";

/** Kampanya geneline ait uygunluk kodları: tek tek dizileri dışlamaz, engel olarak raporlanır. */
const GLOBAL_CODES: ReadonlySet<IneligibleCode> = new Set<IneligibleCode>([
  "consent_missing",
  "sender_profile_incomplete",
  "mailbox_missing",
  "mailbox_not_ready",
  "live_sending_disabled",
  "campaign_closed",
  "campaign_not_found",
  "invalid_limits",
]);

export interface StartPlan {
  campaignId: number;
  updatedAt: number;
  blockers: BlockerCode[];
  eligible: { id: number; leadId: number; language: string }[];
  ineligible: { id: number; reasons: string[] }[];
  token: string;
}

type Env = Record<string, string | undefined>;

/** Kampanya geneli engeller (dizileri değerlendirmeden). Devam ettirmede de kullanılır. */
export async function campaignBlockers(
  db: DbExecutor,
  c: typeof campaigns.$inferSelect,
  env: Env,
): Promise<BlockerCode[]> {
  const out: BlockerCode[] = [];
  const s = await getSettings(db, ["consent", "company.profile"] as const);
  if (!s.consent) out.push("consent_missing");
  if (!s["company.profile"]) out.push("sender_profile_incomplete");
  if (c.mailboxId === null) out.push("mailbox_missing");
  else {
    try {
      await assertSendableMailbox(db, c.mailboxId);
    } catch (e) {
      if (!(e instanceof CampaignError)) throw e;
      out.push(
        e.code === "live_disabled"
          ? "live_disabled"
          : e.code === "not_found"
            ? "mailbox_missing"
            : "mailbox_not_ready",
      );
    }
  }
  const step0 = await db
    .select({ language: campaignSteps.language })
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, c.id), eq(campaignSteps.stepIndex, 0)));
  if (step0.length === 0) out.push("steps_missing");
  else if (!(await stepsStillValid(db, c.id))) out.push("steps_invalid");
  if (!effectiveWindow(c.sendWindow)) out.push("invalid_send_window");
  if (!isMailSchedulerEnabled(env)) out.push("scheduler_disabled");
  return out;
}

/**
 * Adımlara bağlı şablonlar hâlâ kullanılabilir mi? Taslak kampanyanın şablonu kilitli değildir: adımlar
 * kaydedildikten sonra arşivlenebilir, dili veya türü değişebilir. Hazır/başlat/sürdür bu yüzden yeniden denetler;
 * aksi halde her gönderim `compose_failed` verir ya da yanlış dilde/türde şablon gider.
 */
async function stepsStillValid(db: DbExecutor, campaignId: number): Promise<boolean> {
  const rows = await db
    .select({
      stepIndex: campaignSteps.stepIndex,
      language: campaignSteps.language,
      tLanguage: templates.language,
      tKind: templates.kind,
      tArchivedAt: templates.archivedAt,
    })
    .from(campaignSteps)
    .leftJoin(templates, eq(templates.id, campaignSteps.templateId))
    .where(eq(campaignSteps.campaignId, campaignId));
  return rows.every(
    (r) =>
      r.tLanguage !== null &&
      r.tArchivedAt === null &&
      r.tLanguage === r.language &&
      r.tKind === (r.stepIndex === 0 ? "initial" : "followup"),
  );
}

export async function computeStartPlan(
  db: DbExecutor,
  campaignId: number,
  opts: { now: number; env: Env; limits?: FrequencyLimits },
): Promise<StartPlan> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  const blockers = await campaignBlockers(db, c, opts.env);
  if (!["draft", "ready"].includes(c.status)) blockers.push("campaign_not_startable");

  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(asc(campaignSteps.stepIndex), asc(campaignSteps.language));
  const languages = [...new Set(steps.filter((s) => s.stepIndex === 0).map((s) => s.language))];

  const pending = await db
    .select()
    .from(campaignLeads)
    .where(and(eq(campaignLeads.campaignId, campaignId), eq(campaignLeads.status, "pending")))
    .orderBy(asc(campaignLeads.id));

  const eligible: StartPlan["eligible"] = [];
  const ineligible: StartPlan["ineligible"] = [];
  for (const row of pending) {
    const verdict = await evaluateEnrollment(
      db,
      { campaignId, leadId: row.leadId },
      { now: opts.now, limits: opts.limits, ignoreCampaignLeadId: row.id },
    );
    const reasons = new Set(
      verdict.reasons.map((r) => r.code).filter((code) => !GLOBAL_CODES.has(code)),
    ) as Set<string>;
    // Alıcı, eklendiği andaki görüntüyle aynı olmalı (gönderim anında da aynı denetim yapılır).
    const [primary] = await db
      .select()
      .from(leadEmails)
      .where(and(eq(leadEmails.leadId, row.leadId), eq(leadEmails.isPrimary, true)))
      .limit(1);
    if (!primary || primary.id !== row.emailId || primary.email !== row.recipientEmail) {
      reasons.add("recipient_mismatch");
    }
    const language = pickTemplateLanguage(suggestLanguage(row.countryCode), languages);
    if (!language) reasons.add("step_missing");
    if (reasons.size > 0) ineligible.push({ id: row.id, reasons: [...reasons].sort() });
    else eligible.push({ id: row.id, leadId: row.leadId, language: language! });
  }
  if (eligible.length === 0) blockers.push("no_eligible_leads");

  // Onaylanan içerik: kullanılan şablonların SÜRÜMLERİ ve gönderen profili (alt bilgiyi belirler). Bunlar
  // başlatma özeti alındıktan sonra değişirse belirteç eskir ve başlatma `preflight_stale` ile reddedilir.
  const templateIds = [...new Set(steps.map((s) => s.templateId))].sort((a, b) => a - b);
  const templateVersions =
    templateIds.length === 0
      ? []
      : await db
          .select({ id: templates.id, version: templates.version })
          .from(templates)
          .where(inArray(templates.id, templateIds))
          .orderBy(asc(templates.id));
  const profile = (await getSettings(db, ["company.profile"] as const))["company.profile"];
  const profileDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify(profile ?? null))
    .digest("hex")
    .slice(0, 16);

  const token = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        c.id,
        c.updatedAt,
        steps.map((s) => [s.stepIndex, s.language, s.templateId, s.delayDays]),
        templateVersions.map((t) => [t.id, t.version]),
        profileDigest,
        eligible.map((e) => [e.id, e.language]),
        ineligible.map((i) => [i.id, i.reasons]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return { campaignId, updatedAt: c.updatedAt, blockers, eligible, ineligible, token };
}

export interface PreflightStepPreview {
  stepIndex: number;
  /** Önceki adımdan sonra en az kaç gün (takip adımları; ilk adımda 0). */
  delayDays: number;
  subject: string;
  text: string;
  html: string;
  missing: string[];
  warnings: string[];
  /** Birleştirme hataları (ör. `content_blocked`); gönderimde bu adım `compose_failed` olurdu. */
  errors: string[];
}

export interface PreflightPreview {
  campaignLeadId: number;
  language: string;
  recipientMasked: string | null;
  /** İlk adımın konusu/gövdesi (geriye dönük uyum: `steps[0]` ile aynı). */
  subject: string;
  text: string;
  html: string;
  missing: string[];
  warnings: string[];
  /** Faz 4 (9c): bu alıcıya gidecek BÜTÜN adımlar (ilk e-posta + takipler), gönderimdeki konu devamıyla. */
  steps: PreflightStepPreview[];
}

export interface PreflightReport {
  campaignId: number;
  status: string;
  updatedAt: number;
  ready: boolean;
  blockers: BlockerCode[];
  counts: { pending: number; eligible: number; ineligible: number };
  exclusions: Record<string, number>;
  estimate: PreflightEstimate;
  previews: PreflightPreview[];
  /**
   * Engellemeyen uyarılar. `tr_identifiers_missing`: kampanyada Türkiye alıcıları var ama profilde MERSİS ve ticaret
   * sicil numaralarının ikisi de yok (gerekliliği hukuki değerlendirme bekler; gönderim engellenmez).
   * `followup_missing_variables` / `followup_compose_error` (9c): önizlenen alıcılardan `count` tanesinin takip
   * adımında eksik değişken veya birleştirme hatası var; gönderimde o dizinin takibi `compose_failed` ile biter.
   */
  advisories: {
    code: "tr_identifiers_missing" | "followup_missing_variables" | "followup_compose_error";
    count: number;
  }[];
  confirmToken: string;
}

export const PREVIEW_COUNT = 5;

export interface PreflightEstimate {
  /** Günlük geçerli tavan (kampanya ve posta kutusu/ısınma). */
  perDay: number;
  /** İlk e-postaların tamamlanacağı gün sayısı (geriye dönük uyum). */
  days: number;
  earliestSendAt: number | null;
  /** Faz 4 (9c): adım sayısı (1 + takip). */
  stepCount: number;
  /** En çok gönderilecek e-posta (uygun alıcı × adım; yanıt gelenler için takip gitmez, gerçek sayı daha az olur). */
  totalMessages: number;
  /** Son takibin ilk e-postadan en az kaç gün sonra gideceği (takip aralıklarının toplamı). */
  lastFollowupAfterDays: number;
  /** Bütün adımlarla yaklaşık toplam süre (gün). */
  totalDays: number;
}

/**
 * Süre tahmini (saf): ilk e-postalar `ceil(uygun / günlük)` günde biter; takipler aynı günlük tavanı paylaşır ve her
 * biri önceki adımdan en az `max(gecikme, en kısa takip aralığı)` gün sonra gider. Toplam süre, toplam hacmin
 * gerektirdiği gün ile "son ilk e-posta + takip aralıkları" değerinin büyüğüdür. Pencere ve hafta sonu dışarıda
 * tutulmuştur (alıcıya göre değişir); arayüz bunu "yaklaşık" olarak gösterir.
 */
export function estimateDuration(input: {
  eligible: number;
  perDay: number;
  /** Takip adımlarının gecikmeleri (adım sırasıyla; ilk adım hariç). */
  followupDelays: readonly number[];
  minFollowupGapDays: number;
  earliestSendAt: number | null;
}): PreflightEstimate {
  const { eligible, perDay } = input;
  const stepCount = 1 + input.followupDelays.length;
  const gaps = input.followupDelays.map((d) => Math.max(d, input.minFollowupGapDays));
  const lastFollowupAfterDays = gaps.reduce((a, b) => a + b, 0);
  const totalMessages = eligible * stepCount;
  const days = perDay > 0 ? Math.ceil(eligible / perDay) : 0;
  const totalDays =
    perDay > 0 && eligible > 0
      ? Math.max(Math.ceil(totalMessages / perDay), days + lastFollowupAfterDays)
      : 0;
  return {
    perDay,
    days,
    earliestSendAt: input.earliestSendAt,
    stepCount,
    totalMessages,
    lastFollowupAfterDays,
    totalDays,
  };
}

async function computeAdvisories(
  db: DbExecutor,
  campaignId: number,
): Promise<PreflightReport["advisories"]> {
  const profile = await getSetting(db, "company.profile");
  const hasTrId = !!(profile?.mersisNo?.trim() || profile?.tradeRegistryNo?.trim());
  if (hasTrId) return [];
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(campaignLeads)
    .where(
      and(
        eq(campaignLeads.campaignId, campaignId),
        eq(campaignLeads.countryCode, "TR"),
        inArray(campaignLeads.status, ["pending", "scheduled", "waiting_next"]),
      ),
    );
  const count = Number(row?.n ?? 0);
  return count > 0 ? [{ code: "tr_identifiers_missing", count }] : [];
}

export async function runPreflight(
  db: DbExecutor,
  campaignId: number,
  opts: { now?: number; env?: Env; limits?: FrequencyLimits } = {},
): Promise<PreflightReport> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const plan = await computeStartPlan(db, campaignId, { now, env, limits: opts.limits });
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);

  const exclusions: Record<string, number> = {};
  for (const i of plan.ineligible)
    for (const r of i.reasons) exclusions[r] = (exclusions[r] ?? 0) + 1;

  // Tahmin: günlük geçerli tavan (kampanya ve posta kutusu/ısınma) ve en erken pencere açılışı.
  let perDay = c!.dailyCap;
  if (c!.mailboxId !== null) {
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, c!.mailboxId)).limit(1);
    if (mb) perDay = Math.min(perDay, effectiveMailboxCap(mb, now));
  }
  const window = effectiveWindow(c!.sendWindow);
  let earliestSendAt: number | null = null;
  if (window && plan.eligible.length > 0) {
    const rows = await db
      .select({ id: campaignLeads.id, countryCode: campaignLeads.countryCode })
      .from(campaignLeads)
      .where(eq(campaignLeads.campaignId, campaignId));
    const ids = new Set(plan.eligible.map((e) => e.id));
    for (const cc of new Set(rows.filter((r) => ids.has(r.id)).map((r) => r.countryCode))) {
      const zones = timeZonesForCountry(cc);
      const at = zones ? nextWindowStart(now, window, zones) : null;
      if (at !== null && (earliestSendAt === null || at < earliestSendAt)) earliestSendAt = at;
    }
  }

  // İlk 5 uygun dizinin BÜTÜN adımlarının önizlemesi (yazma yok; demo alt bilgisi). Takip adımları gönderimdeki gibi
  // ilk e-postanın konusunu devralır (şablon izin veriyorsa "Re: …").
  const previews: PreflightPreview[] = [];
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, campaignId))
    .orderBy(asc(campaignSteps.stepIndex));
  let followupMissing = 0;
  let followupErrors = 0;
  for (const e of plan.eligible.slice(0, PREVIEW_COUNT)) {
    const own = steps.filter((s) => s.language === e.language);
    const step = own.find((s) => s.stepIndex === 0);
    if (!step) continue;
    const composed = await composeEmail(db, {
      templateId: step.templateId,
      leadId: e.leadId,
      mode: "demo",
      purpose: "preview",
    });
    const stepPreviews: PreflightStepPreview[] = [
      {
        stepIndex: 0,
        delayDays: 0,
        subject: composed.subject,
        text: composed.text,
        html: composed.html,
        missing: composed.missing,
        warnings: composed.warnings.map((w) => w.code),
        errors: composed.errors.map((x) => x.code).filter((c) => c !== "missing_variables"),
      },
    ];
    let hasMissing = false;
    let hasError = false;
    for (const f of own.filter((s) => s.stepIndex > 0)) {
      const fc = await composeEmail(db, {
        templateId: f.templateId,
        leadId: e.leadId,
        mode: "demo",
        purpose: "preview",
        threadSubject: composed.subject,
      });
      const errors = fc.errors.map((x) => x.code).filter((c) => c !== "missing_variables");
      if (fc.missing.length > 0) hasMissing = true;
      if (errors.length > 0) hasError = true;
      stepPreviews.push({
        stepIndex: f.stepIndex,
        delayDays: f.delayDays,
        subject: fc.subject,
        text: fc.text,
        html: fc.html,
        missing: fc.missing,
        warnings: fc.warnings.map((w) => w.code),
        errors,
      });
    }
    if (hasMissing) followupMissing++;
    if (hasError) followupErrors++;
    const [row] = await db
      .select({ email: campaignLeads.recipientEmail })
      .from(campaignLeads)
      .where(eq(campaignLeads.id, e.id))
      .limit(1);
    const at = row?.email?.lastIndexOf("@") ?? -1;
    previews.push({
      campaignLeadId: e.id,
      language: e.language,
      recipientMasked:
        row?.email && at > 0 ? maskEmail(row.email.slice(0, at), row.email.slice(at + 1)) : null,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      missing: composed.missing,
      warnings: composed.warnings.map((w) => w.code),
      steps: stepPreviews,
    });
  }
  const followupAdvisories: PreflightReport["advisories"] = [
    ...(followupMissing > 0
      ? [{ code: "followup_missing_variables" as const, count: followupMissing }]
      : []),
    ...(followupErrors > 0
      ? [{ code: "followup_compose_error" as const, count: followupErrors }]
      : []),
  ];

  // Adım gecikmeleri: diller aynı adım yapısını kullanır (servis doğrular); ilk dilin takipleri yeterlidir.
  const firstLanguage = steps.find((s) => s.stepIndex === 0)?.language;
  const followupDelays = steps
    .filter((s) => s.stepIndex > 0 && s.language === firstLanguage)
    .map((s) => s.delayDays);

  return {
    campaignId,
    status: c!.status,
    updatedAt: plan.updatedAt,
    ready: plan.blockers.length === 0,
    blockers: plan.blockers,
    counts: {
      pending: plan.eligible.length + plan.ineligible.length,
      eligible: plan.eligible.length,
      ineligible: plan.ineligible.length,
    },
    exclusions,
    estimate: estimateDuration({
      eligible: plan.eligible.length,
      perDay,
      followupDelays,
      minFollowupGapDays: (opts.limits ?? DEFAULT_FREQUENCY_LIMITS).minFollowupGapDays,
      earliestSendAt,
    }),
    previews,
    advisories: [...(await computeAdvisories(db, campaignId)), ...followupAdvisories],
    confirmToken: plan.token,
  };
}
