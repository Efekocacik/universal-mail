import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import { evaluateEnrollment, type IneligibleCode } from "@/lib/compliance/eligibility";
import type { FrequencyLimits } from "@/lib/compliance/frequency";
import { hashEmail, maskEmail } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  leadEmails,
  leads,
  type CampaignLeadStatus,
} from "@/lib/db/schema";
import { suggestLanguage } from "@/lib/mail/language";
import { bumpUpdatedAt, CampaignError } from "./errors";

/**
 * Kampanyaya lead ekleme ve çıkarma (FR-CMP-02, FR-CMP-05).
 *
 * - Ekleme yalnızca `draft`/`ready` kampanyada yapılır. Her lead `evaluateEnrollment` ile denetlenir: uygun olanlar
 *   alıcının o anki görüntüsüyle `pending`, olmayanlar gerekçe kodlarıyla `excluded` eklenir.
 * - Aynı lead aynı kampanyaya ikinci kez eklenemez (çıkarılmış olsa bile): benzersiz dizin + `already_in_campaign`.
 * - Filtreyle seçim eklendiği andaki görüntüdür; sonradan oluşan lead'ler kampanyaya kendiliğinden girmez.
 * - Çıkarma, henüz gönderimde olmayan diziler içindir (`in_flight` çıkarılamaz); dağıtıcının ayırmasıyla aynı
 *   karşılaştırmalı güncelleme kullanıldığı için çıkarılan dizi gönderilmez.
 */

export const MAX_ADD_BATCH = 500;
const ADDABLE: readonly string[] = ["draft", "ready"];
const REMOVABLE: readonly CampaignLeadStatus[] = [
  "pending",
  "excluded",
  "scheduled",
  "waiting_next",
];

export interface AddLeadsResult {
  added: number;
  excluded: { leadId: number; reasons: IneligibleCode[] }[];
  duplicates: number[];
  updatedAt: number;
}

export async function addLeadsToCampaign(
  db: Db,
  campaignId: number,
  leadIds: readonly number[],
  opts: { now?: number; limits?: FrequencyLimits; selection?: unknown } = {},
): Promise<AddLeadsResult> {
  const now = opts.now ?? Date.now();
  const ids = [...new Set(leadIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new CampaignError("invalid_input", "Eklenecek lead seçilmedi.");
  if (ids.length > MAX_ADD_BATCH) {
    throw new CampaignError(
      "invalid_input",
      `Tek seferde en fazla ${MAX_ADD_BATCH} lead eklenebilir.`,
    );
  }

  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    if (!ADDABLE.includes(c.status)) {
      throw new CampaignError(
        "not_editable",
        "Lead yalnızca taslak veya hazır kampanyaya eklenebilir.",
        {
          status: c.status,
        },
      );
    }
    const existing = new Set(
      (
        await tx
          .select({ leadId: campaignLeads.leadId })
          .from(campaignLeads)
          .where(and(eq(campaignLeads.campaignId, campaignId), inArray(campaignLeads.leadId, ids)))
      ).map((r) => r.leadId),
    );

    const res: AddLeadsResult = { added: 0, excluded: [], duplicates: [], updatedAt: c.updatedAt };
    for (const leadId of ids) {
      if (existing.has(leadId)) {
        res.duplicates.push(leadId);
        continue;
      }
      const [lead] = await tx
        .select({ id: leads.id, countryCode: leads.countryCode })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (!lead) {
        res.excluded.push({ leadId, reasons: ["lead_not_found"] });
        continue; // olmayan lead için satır açılamaz (yabancı anahtar)
      }
      // Aynı işlemde: önceki eklemeler (ör. aynı alan adı) sonraki lead'lerin değerlendirmesinde görünür.
      const verdict = await evaluateEnrollment(
        tx,
        { campaignId, leadId },
        { now, limits: opts.limits },
      );
      const [primary] = verdict.eligible
        ? await tx
            .select()
            .from(leadEmails)
            .where(and(eq(leadEmails.leadId, leadId), eq(leadEmails.isPrimary, true)))
            .limit(1)
        : [];
      if (verdict.eligible && primary) {
        await tx.insert(campaignLeads).values({
          campaignId,
          leadId,
          emailId: primary.id,
          recipientEmail: primary.email,
          recipientHash: hashEmail(primary.email),
          recipientDomain: primary.domain,
          countryCode: lead.countryCode,
          language: suggestLanguage(lead.countryCode),
          status: "pending",
          addedAt: now,
          updatedAt: now,
        });
        res.added++;
      } else {
        const reasons = verdict.eligible
          ? (["no_email"] as IneligibleCode[])
          : [...new Set(verdict.reasons.map((r) => r.code))];
        await tx.insert(campaignLeads).values({
          campaignId,
          leadId,
          countryCode: lead.countryCode,
          status: "excluded",
          exclusionReasons: reasons,
          addedAt: now,
          updatedAt: now,
        });
        res.excluded.push({ leadId, reasons });
      }
    }

    const [bumped] = await tx
      .update(campaigns)
      .set({
        updatedAt: bumpUpdatedAt(now),
        ...(opts.selection !== undefined ? { selection: opts.selection } : {}),
      })
      .where(eq(campaigns.id, campaignId))
      .returning({ updatedAt: campaigns.updatedAt });
    res.updatedAt = bumped!.updatedAt;
    await audit(
      tx,
      "campaign.leads_added",
      "campaign",
      campaignId,
      {
        added: res.added,
        excluded: res.excluded.length,
        duplicates: res.duplicates.length,
        selection: opts.selection ?? null,
      },
      now,
    );
    return res;
  });
}

export async function removeCampaignLead(
  db: Db,
  campaignId: number,
  campaignLeadId: number,
  opts: { now?: number } = {},
): Promise<{ removed: true }> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    if (["completed", "cancelled", "stopped"].includes(c.status)) {
      throw new CampaignError("not_editable", "Kapanmış kampanyadan lead çıkarılamaz.", {
        status: c.status,
      });
    }
    const rows = await tx
      .update(campaignLeads)
      .set({ status: "removed", nextSendAt: null, lastError: "removed_by_user", updatedAt: now })
      .where(
        and(
          eq(campaignLeads.id, campaignLeadId),
          eq(campaignLeads.campaignId, campaignId),
          inArray(campaignLeads.status, [...REMOVABLE]),
        ),
      )
      .returning({ id: campaignLeads.id });
    if (rows.length === 0) {
      const [cur] = await tx
        .select({ status: campaignLeads.status })
        .from(campaignLeads)
        .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId)))
        .limit(1);
      if (!cur) throw new CampaignError("not_found", "Kampanya dizisi bulunamadı.");
      if (cur.status === "in_flight") {
        throw new CampaignError(
          "in_flight",
          "Bu dizinin gönderimi sürüyor veya sonucu inceleme bekliyor; çıkarılamaz.",
        );
      }
      throw new CampaignError("not_editable", "Bu dizi artık çıkarılamaz.", { status: cur.status });
    }
    await tx
      .update(campaigns)
      .set({ updatedAt: bumpUpdatedAt(now) })
      .where(eq(campaigns.id, campaignId));
    await audit(tx, "campaign.lead_removed", "campaign_lead", campaignLeadId, { campaignId }, now);
    return { removed: true as const };
  });
}

export interface QueueItem {
  id: number;
  leadId: number;
  status: CampaignLeadStatus;
  recipientMasked: string | null;
  recipientDomain: string | null;
  countryCode: string | null;
  language: string | null;
  nextStep: number;
  nextSendAt: number | null;
  lastSentAt: number | null;
  attempts: number;
  lastError: string | null;
  exclusionReasons: string[];
}

/** Kuyruk görünümü (FR-CMP-05): sayfalı; alıcı adresi maskelenir. */
export async function listCampaignQueue(
  db: DbExecutor,
  campaignId: number,
  opts: { status?: CampaignLeadStatus; afterId?: number; limit?: number } = {},
): Promise<{ items: QueueItem[]; total: number }> {
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  const base = and(
    eq(campaignLeads.campaignId, campaignId),
    opts.status ? eq(campaignLeads.status, opts.status) : undefined,
  );
  const rows = await db
    .select()
    .from(campaignLeads)
    .where(and(base, opts.afterId ? gt(campaignLeads.id, opts.afterId) : undefined))
    .orderBy(asc(campaignLeads.id))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(campaignLeads).where(base);
  return {
    total: Number(n),
    items: rows.map((r) => {
      const at = r.recipientEmail?.lastIndexOf("@") ?? -1;
      return {
        id: r.id,
        leadId: r.leadId,
        status: r.status,
        recipientMasked:
          r.recipientEmail && at > 0
            ? maskEmail(r.recipientEmail.slice(0, at), r.recipientEmail.slice(at + 1))
            : null,
        recipientDomain: r.recipientDomain,
        countryCode: r.countryCode,
        language: r.language,
        nextStep: r.nextStep,
        nextSendAt: r.nextSendAt,
        lastSentAt: r.lastSentAt,
        attempts: r.attempts,
        lastError: r.lastError,
        exclusionReasons: r.exclusionReasons,
      };
    }),
  };
}
