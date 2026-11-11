import { desc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  type CampaignLeadStatus,
  type CampaignStatus,
} from "@/lib/db/schema";

/**
 * Bir lead'in kampanyalardaki durumu ve hariç tutulma gerekçeleri (SRS Bölüm 13, madde 12: "hariç tutulma gerekçesi
 * ilgili lead üzerinde görüntülenir"). SALT OKUNUR; alıcı adresi döndürülmez.
 */
export interface LeadCampaignItem {
  campaignId: number;
  campaignName: string;
  campaignStatus: CampaignStatus;
  sequenceId: number;
  sequenceStatus: CampaignLeadStatus;
  exclusionReasons: string[];
  lastError: string | null;
  addedAt: number;
}

export async function listLeadCampaigns(
  db: DbExecutor,
  leadId: number,
): Promise<LeadCampaignItem[]> {
  const rows = await db
    .select({
      campaignId: campaigns.id,
      campaignName: campaigns.name,
      campaignStatus: campaigns.status,
      sequenceId: campaignLeads.id,
      sequenceStatus: campaignLeads.status,
      exclusionReasons: campaignLeads.exclusionReasons,
      lastError: campaignLeads.lastError,
      addedAt: campaignLeads.addedAt,
    })
    .from(campaignLeads)
    .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
    .where(eq(campaignLeads.leadId, leadId))
    .orderBy(desc(campaignLeads.id))
    .limit(50);
  return rows;
}
