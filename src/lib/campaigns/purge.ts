import { and, count, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  leads,
  mailboxes,
  messages,
  suppressions,
} from "@/lib/db/schema";
import { CampaignError } from "./errors";

/**
 * Demo kampanya verilerinin temizlenmesi (`purgeDemoData` öncesinde, tek işlemde).
 *
 * Demo kampanya: posta kutusu DEMO sağlayıcılı kampanya. Silinenler YALNIZCA: demo kampanyaların iletileri, dizileri ve
 * adımları ile kampanyaların kendileri. Lead, şablon, posta kutusu, suppression ve audit kaydı burada silinmez.
 *
 * Güvenli ayrım yapılamıyorsa HİÇBİR ŞEY silinmez ve `conflict` hatası verilir:
 *  - demo lead, demo olmayan (veya posta kutusu atanmamış) bir kampanyada ya da demo dışı bir iletide geçiyorsa,
 *  - demo kampanyada demo olmayan bir lead varsa,
 *  - demo kampanyanın bir iletisi demo dışı posta kutusundan kaydedilmişse,
 *  - bir suppression kaydı silinecek bir iletiye bağlıysa.
 */

export type DemoPurgeBlocker =
  | "demo_lead_in_non_demo_campaign"
  | "non_demo_lead_in_demo_campaign"
  | "demo_lead_in_non_demo_message"
  | "non_demo_mailbox_message_in_demo_campaign"
  | "suppression_references_demo_message";

export async function purgeDemoCampaignData(
  db: Db,
): Promise<{ campaigns: number; sequences: number; messages: number }> {
  return db.transaction(async (tx) => {
    const demoMailboxIds = (
      await tx.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.provider, "demo"))
    ).map((r) => r.id);
    const demoCampaignIds =
      demoMailboxIds.length === 0
        ? []
        : (
            await tx
              .select({ id: campaigns.id })
              .from(campaigns)
              .where(inArray(campaigns.mailboxId, demoMailboxIds))
          ).map((r) => r.id);
    const demoLeadIds = tx.select({ id: leads.id }).from(leads).where(eq(leads.source, "demo"));
    const isDemoCampaign = (col: typeof campaignLeads.campaignId | typeof messages.campaignId) =>
      demoCampaignIds.length > 0 ? inArray(col, demoCampaignIds) : undefined;
    const notDemoCampaign = (col: typeof campaignLeads.campaignId) =>
      demoCampaignIds.length > 0 ? notInArray(col, demoCampaignIds) : undefined;

    const blockers: DemoPurgeBlocker[] = [];
    const exists = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0) > 0;

    if (
      await exists(
        tx
          .select({ n: count() })
          .from(campaignLeads)
          .where(
            and(
              inArray(campaignLeads.leadId, demoLeadIds),
              notDemoCampaign(campaignLeads.campaignId),
            ),
          ),
      )
    ) {
      blockers.push("demo_lead_in_non_demo_campaign");
    }
    if (
      demoCampaignIds.length > 0 &&
      (await exists(
        tx
          .select({ n: count() })
          .from(campaignLeads)
          .innerJoin(leads, eq(leads.id, campaignLeads.leadId))
          .where(and(isDemoCampaign(campaignLeads.campaignId), ne(leads.source, "demo"))),
      ))
    ) {
      blockers.push("non_demo_lead_in_demo_campaign");
    }
    if (
      await exists(
        tx
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              inArray(messages.leadId, demoLeadIds),
              or(
                isNull(messages.campaignId),
                demoCampaignIds.length > 0
                  ? notInArray(messages.campaignId, demoCampaignIds)
                  : isNotNull(messages.campaignId),
                demoMailboxIds.length > 0
                  ? notInArray(messages.mailboxId, demoMailboxIds)
                  : isNotNull(messages.mailboxId),
              ),
            ),
          ),
      )
    ) {
      blockers.push("demo_lead_in_non_demo_message");
    }
    if (
      demoCampaignIds.length > 0 &&
      (await exists(
        tx
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              isDemoCampaign(messages.campaignId),
              notInArray(messages.mailboxId, demoMailboxIds),
            ),
          ),
      ))
    ) {
      blockers.push("non_demo_mailbox_message_in_demo_campaign");
    }
    if (
      demoCampaignIds.length > 0 &&
      (await exists(
        tx
          .select({ n: count() })
          .from(suppressions)
          .where(
            inArray(
              suppressions.messageId,
              tx
                .select({ id: messages.id })
                .from(messages)
                .where(isDemoCampaign(messages.campaignId)),
            ),
          ),
      ))
    ) {
      blockers.push("suppression_references_demo_message");
    }

    if (blockers.length > 0) {
      throw new CampaignError(
        "conflict",
        "Demo ve gerçek kayıtlar birbirine bağlı; güvenli ayrım yapılamadığı için hiçbir şey silinmedi.",
        { blockers },
      );
    }
    if (demoCampaignIds.length === 0) return { campaigns: 0, sequences: 0, messages: 0 };

    const deletedMessages = await tx
      .delete(messages)
      .where(isDemoCampaign(messages.campaignId))
      .returning({ id: messages.id });
    const deletedSequences = await tx
      .delete(campaignLeads)
      .where(isDemoCampaign(campaignLeads.campaignId))
      .returning({ id: campaignLeads.id });
    // Adımlar ON DELETE CASCADE ile silinir.
    const deletedCampaigns = await tx
      .delete(campaigns)
      .where(inArray(campaigns.id, demoCampaignIds))
      .returning({ id: campaigns.id });
    return {
      campaigns: deletedCampaigns.length,
      sequences: deletedSequences.length,
      messages: deletedMessages.length,
    };
  });
}
