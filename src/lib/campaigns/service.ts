import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  mailboxes,
  templates,
  type CampaignLeadStatus,
  type CampaignStatus,
  type SendWindow,
} from "@/lib/db/schema";
import { isSupportedLanguage } from "@/lib/mail/language";
import { MIN_GAP_S } from "@/lib/mail/scheduler/throttle";
import { DEFAULT_SEND_WINDOW, effectiveWindow } from "@/lib/mail/scheduler/window";
import { bumpUpdatedAt, CampaignError } from "./errors";

/**
 * Kampanya oluşturma, listeleme, detay ve düzenleme (Aşama 10).
 *
 * - Kampanya her zaman `draft` olarak oluşturulur; durum yalnızca `lifecycle.ts` geçişleriyle değişir.
 * - Ayarlar, adımlar ve posta kutusu yalnızca `draft` durumunda değiştirilebilir.
 * - Eşzamanlı düzenlemeler `updated_at` iyimser kilidiyle yakalanır (bkz. `bumpUpdatedAt`).
 * - Yalnızca bağlı DEMO posta kutusu atanabilir; gerçek gönderim bu sürümde kapalıdır.
 */

export const MAX_STEPS = 3;
export const MAX_FOLLOWUP_DELAY_DAYS = 90;
export const MAX_GAP_S = 3600;

export interface CampaignSettingsInput {
  name?: string;
  mailboxId?: number | null;
  sendWindow?: SendWindow;
  dailyCap?: number;
  minGapS?: number;
  maxGapS?: number;
}

export interface StepInput {
  stepIndex: number;
  language: string;
  templateId: number;
  delayDays: number;
}

type CampaignRow = typeof campaigns.$inferSelect;

/** Bağlı demo posta kutusu mu? Değilse ayrıntılı hata. */
export async function assertDemoMailbox(db: DbExecutor, mailboxId: number): Promise<void> {
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (!mb) throw new CampaignError("not_found", "Posta kutusu bulunamadı.");
  if (policyScopeForMailbox(mb.provider) !== "demo") {
    throw new CampaignError(
      "live_disabled",
      "Gerçek posta kutusuyla gönderim bu sürümde kapalıdır; yalnızca demo posta kutusu kullanılabilir.",
    );
  }
  if (mb.status !== "connected") {
    throw new CampaignError("invalid_input", "Posta kutusu hazır değil.", {
      mailboxStatus: mb.status,
    });
  }
}

function validateSettings(input: CampaignSettingsInput, base: CampaignRow | null) {
  const name = input.name !== undefined ? input.name.trim() : base?.name;
  if (!name || name.length > 120) {
    throw new CampaignError("invalid_input", "Kampanya adı 1–120 karakter olmalıdır.");
  }
  const sendWindow = input.sendWindow ??
    base?.sendWindow ?? { ...DEFAULT_SEND_WINDOW, days: [...DEFAULT_SEND_WINDOW.days] };
  if (!effectiveWindow(sendWindow)) {
    throw new CampaignError(
      "invalid_input",
      "Gönderim penceresi geçersiz veya varsayılanın (hafta içi 09.00–17.00) dışında.",
    );
  }
  const dailyCap = input.dailyCap ?? base?.dailyCap ?? 20;
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 80) {
    throw new CampaignError("invalid_input", "Günlük tavan 1–80 arasında olmalıdır.");
  }
  const minGapS = input.minGapS ?? base?.minGapS ?? MIN_GAP_S;
  const maxGapS = input.maxGapS ?? base?.maxGapS ?? 240;
  if (
    !Number.isInteger(minGapS) ||
    !Number.isInteger(maxGapS) ||
    minGapS < MIN_GAP_S ||
    maxGapS < minGapS ||
    maxGapS > MAX_GAP_S
  ) {
    throw new CampaignError(
      "invalid_input",
      `Gönderim aralığı en az ${MIN_GAP_S} sn olmalı ve üst sınır alt sınırdan küçük olmamalıdır.`,
    );
  }
  return {
    name,
    sendWindow: {
      days: [...sendWindow.days].sort((a, b) => a - b),
      start: sendWindow.start,
      end: sendWindow.end,
    },
    dailyCap,
    minGapS,
    maxGapS,
  };
}

export async function createCampaign(
  db: Db,
  input: CampaignSettingsInput & { name: string },
  opts: { now?: number } = {},
): Promise<{ id: number; updatedAt: number }> {
  const now = opts.now ?? Date.now();
  const s = validateSettings(input, null);
  return db.transaction(async (tx) => {
    if (input.mailboxId != null) await assertDemoMailbox(tx, input.mailboxId);
    const [row] = await tx
      .insert(campaigns)
      .values({
        ...s,
        status: "draft",
        mailboxId: input.mailboxId ?? null,
        selection: {},
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: campaigns.id, updatedAt: campaigns.updatedAt });
    await audit(
      tx,
      "campaign.created",
      "campaign",
      row!.id,
      { mailboxId: input.mailboxId ?? null },
      now,
    );
    return row!;
  });
}

/**
 * Taslak kampanyanın satırını karşılaştırmalı günceller. Başarısızsa nedeni ayırt eder: bulunamadı, düzenlenemez
 * durum veya eşzamanlı değişiklik.
 */
async function casDraft(
  tx: DbExecutor,
  id: number,
  expectedUpdatedAt: number,
  values: Partial<typeof campaigns.$inferInsert>,
  now: number,
): Promise<number> {
  const rows = await tx
    .update(campaigns)
    .set({ ...values, updatedAt: bumpUpdatedAt(now) })
    .where(
      and(
        eq(campaigns.id, id),
        eq(campaigns.status, "draft"),
        eq(campaigns.updatedAt, expectedUpdatedAt),
      ),
    )
    .returning({ updatedAt: campaigns.updatedAt });
  if (rows[0]) return rows[0].updatedAt;
  const [cur] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!cur) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  if (cur.status !== "draft") {
    throw new CampaignError("not_editable", "Kampanya yalnızca taslak durumunda düzenlenebilir.", {
      status: cur.status,
    });
  }
  throw new CampaignError(
    "conflict",
    "Kampanya başka bir işlemle değiştirildi; yeniden yükleyin.",
    {
      updatedAt: cur.updatedAt,
    },
  );
}

export async function updateCampaign(
  db: Db,
  id: number,
  patch: CampaignSettingsInput,
  opts: { expectedUpdatedAt: number; now?: number },
): Promise<{ updatedAt: number }> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!cur) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    const s = validateSettings(patch, cur);
    if (patch.mailboxId != null) await assertDemoMailbox(tx, patch.mailboxId);
    const updatedAt = await casDraft(
      tx,
      id,
      opts.expectedUpdatedAt,
      { ...s, ...(patch.mailboxId !== undefined ? { mailboxId: patch.mailboxId } : {}) },
      now,
    );
    await audit(tx, "campaign.updated", "campaign", id, { fields: Object.keys(patch).sort() }, now);
    return { updatedAt };
  });
}

/** Adım tanımlarını doğrular: 0. adım zorunlu, en fazla 3 adım, her dilde aynı adımlar, uygun şablon türü. */
async function validateSteps(db: DbExecutor, steps: readonly StepInput[]): Promise<void> {
  const fail = (message: string, detail: Record<string, unknown> = {}) => {
    throw new CampaignError("invalid_steps", message, detail);
  };
  if (steps.length === 0) fail("En az bir adım (ilk e-posta) gereklidir.");
  const byLang = new Map<string, Set<number>>();
  for (const s of steps) {
    if (!Number.isInteger(s.stepIndex) || s.stepIndex < 0 || s.stepIndex >= MAX_STEPS) {
      fail(`Adım numarası 0–${MAX_STEPS - 1} arasında olmalıdır.`);
    }
    if (!isSupportedLanguage(s.language)) fail("Desteklenmeyen dil.", { language: s.language });
    const set = byLang.get(s.language) ?? new Set<number>();
    if (set.has(s.stepIndex)) fail("Aynı dilde aynı adım iki kez tanımlanamaz.");
    set.add(s.stepIndex);
    byLang.set(s.language, set);
    if (s.stepIndex === 0 && s.delayDays !== 0) fail("İlk e-postanın gecikmesi 0 olmalıdır.");
    if (
      s.stepIndex > 0 &&
      (!Number.isInteger(s.delayDays) || s.delayDays < 5 || s.delayDays > MAX_FOLLOWUP_DELAY_DAYS)
    ) {
      fail(`Takip adımları arasında en az 5, en fazla ${MAX_FOLLOWUP_DELAY_DAYS} gün olmalıdır.`);
    }
  }
  const sets = [...byLang.values()];
  for (const set of sets) {
    for (let i = 0; i < set.size; i++) {
      if (!set.has(i)) fail("Adımlar 0'dan başlayıp ardışık olmalıdır.");
    }
    if (set.size !== sets[0]!.size) fail("Her dilde aynı adımlar tanımlanmalıdır.");
  }
  const ids = [...new Set(steps.map((s) => s.templateId))];
  const rows = await db.select().from(templates).where(inArray(templates.id, ids));
  for (const s of steps) {
    const t = rows.find((r) => r.id === s.templateId);
    if (!t) fail("Şablon bulunamadı.", { templateId: s.templateId });
    if (t!.archivedAt !== null) fail("Arşivlenmiş şablon kullanılamaz.", { templateId: t!.id });
    if (t!.language !== s.language)
      fail("Şablon dili adım diliyle aynı olmalıdır.", { templateId: t!.id });
    const kind = s.stepIndex === 0 ? "initial" : "followup";
    if (t!.kind !== kind)
      fail("İlk adım için ilk e-posta, takipler için takip şablonu gerekir.", {
        templateId: t!.id,
      });
  }
}

export async function setCampaignSteps(
  db: Db,
  id: number,
  steps: readonly StepInput[],
  opts: { expectedUpdatedAt: number; now?: number },
): Promise<{ updatedAt: number }> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    await validateSteps(tx, steps);
    const updatedAt = await casDraft(tx, id, opts.expectedUpdatedAt, {}, now);
    await tx.delete(campaignSteps).where(eq(campaignSteps.campaignId, id));
    await tx.insert(campaignSteps).values(
      steps.map((s) => ({
        campaignId: id,
        stepIndex: s.stepIndex,
        language: s.language,
        templateId: s.templateId,
        delayDays: s.delayDays,
      })),
    );
    await audit(
      tx,
      "campaign.steps_set",
      "campaign",
      id,
      { steps: steps.map((s) => [s.stepIndex, s.language, s.templateId, s.delayDays]) },
      now,
    );
    return { updatedAt };
  });
}

export type SequenceCounts = Partial<Record<CampaignLeadStatus, number>>;

async function countsFor(db: DbExecutor, ids: number[]): Promise<Map<number, SequenceCounts>> {
  const out = new Map<number, SequenceCounts>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ campaignId: campaignLeads.campaignId, status: campaignLeads.status, n: count() })
    .from(campaignLeads)
    .where(inArray(campaignLeads.campaignId, ids))
    .groupBy(campaignLeads.campaignId, campaignLeads.status);
  for (const r of rows) {
    const c = out.get(r.campaignId) ?? {};
    c[r.status] = Number(r.n);
    out.set(r.campaignId, c);
  }
  return out;
}

export interface CampaignSummary {
  id: number;
  name: string;
  status: CampaignStatus;
  mailboxId: number | null;
  dailyCap: number;
  pauseReason: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  counts: SequenceCounts;
}

function summary(c: CampaignRow, counts: SequenceCounts | undefined): CampaignSummary {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    mailboxId: c.mailboxId,
    dailyCap: c.dailyCap,
    pauseReason: c.pauseReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    counts: counts ?? {},
  };
}

export async function listCampaigns(
  db: DbExecutor,
  opts: { status?: CampaignStatus; limit?: number; offset?: number } = {},
): Promise<CampaignSummary[]> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(opts.status ? eq(campaigns.status, opts.status) : undefined)
    .orderBy(desc(campaigns.updatedAt), desc(campaigns.id))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
    .offset(Math.max(opts.offset ?? 0, 0));
  const counts = await countsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => summary(r, counts.get(r.id)));
}

export interface CampaignDetail extends CampaignSummary {
  sendWindow: SendWindow;
  minGapS: number;
  maxGapS: number;
  startConfirmedAt: number | null;
  pausedAt: number | null;
  steps: StepInput[];
}

export async function getCampaign(db: DbExecutor, id: number): Promise<CampaignDetail> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  const steps = await db
    .select()
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, id))
    .orderBy(asc(campaignSteps.stepIndex), asc(campaignSteps.language));
  const counts = await countsFor(db, [id]);
  return {
    ...summary(c, counts.get(id)),
    sendWindow: c.sendWindow,
    minGapS: c.minGapS,
    maxGapS: c.maxGapS,
    startConfirmedAt: c.startConfirmedAt,
    pausedAt: c.pausedAt,
    steps: steps.map((s) => ({
      stepIndex: s.stepIndex,
      language: s.language,
      templateId: s.templateId,
      delayDays: s.delayDays,
    })),
  };
}
