import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { evaluateEnrollment, type IneligibleCode } from "@/lib/compliance/eligibility";
import type { FrequencyLimits } from "@/lib/compliance/frequency";
import { maskEmail } from "@/lib/compliance/suppression";
import type { DbExecutor } from "@/lib/db/client";
import { campaignLeads, campaigns, campaignSteps, leadEmails, mailboxes } from "@/lib/db/schema";
import { pickTemplateLanguage, suggestLanguage } from "@/lib/mail/language";
import { isDemoSchedulerEnabled } from "@/lib/mail/scheduler/job";
import { effectiveMailboxCap } from "@/lib/mail/scheduler/throttle";
import { effectiveWindow, nextWindowStart, timeZonesForCountry } from "@/lib/mail/scheduler/window";
import { composeEmail } from "@/lib/mail/template-service";
import { getSettings } from "@/lib/settings";
import { CampaignError } from "./errors";
import { assertDemoMailbox } from "./service";

/**
 * Başlatma öncesi denetim ve özet (FR-CMP-04). Veritabanına YAZMAZ, ileti göndermez.
 *
 * - Kampanya geneli engeller: kullanım onayı, gönderen profili, demo posta kutusu, adımlar, pencere, zamanlayıcı
 *   bayrağı, en az bir uygun dizi.
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
      await assertDemoMailbox(db, c.mailboxId);
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
  if (!effectiveWindow(c.sendWindow)) out.push("invalid_send_window");
  if (!isDemoSchedulerEnabled(env)) out.push("scheduler_disabled");
  return out;
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

  const token = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        c.id,
        c.updatedAt,
        steps.map((s) => [s.stepIndex, s.language, s.templateId, s.delayDays]),
        eligible.map((e) => [e.id, e.language]),
        ineligible.map((i) => [i.id, i.reasons]),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return { campaignId, updatedAt: c.updatedAt, blockers, eligible, ineligible, token };
}

export interface PreflightPreview {
  campaignLeadId: number;
  language: string;
  recipientMasked: string | null;
  subject: string;
  text: string;
  html: string;
  missing: string[];
  warnings: string[];
}

export interface PreflightReport {
  campaignId: number;
  status: string;
  updatedAt: number;
  ready: boolean;
  blockers: BlockerCode[];
  counts: { pending: number; eligible: number; ineligible: number };
  exclusions: Record<string, number>;
  estimate: { perDay: number; days: number; earliestSendAt: number | null };
  previews: PreflightPreview[];
  confirmToken: string;
}

export const PREVIEW_COUNT = 5;

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

  // İlk 5 uygun dizinin önizlemesi (yazma yok; demo alt bilgisi).
  const previews: PreflightPreview[] = [];
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepIndex, 0)));
  for (const e of plan.eligible.slice(0, PREVIEW_COUNT)) {
    const step = steps.find((s) => s.language === e.language);
    if (!step) continue;
    const composed = await composeEmail(db, {
      templateId: step.templateId,
      leadId: e.leadId,
      mode: "demo",
      purpose: "preview",
    });
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
    });
  }

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
    estimate: {
      perDay,
      days: perDay > 0 ? Math.ceil(plan.eligible.length / perDay) : 0,
      earliestSendAt,
    },
    previews,
    confirmToken: plan.token,
  };
}
