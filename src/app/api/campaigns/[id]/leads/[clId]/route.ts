import { database, intParam, json, route } from "@/lib/api/http";
import { removeCampaignLead } from "@/lib/campaigns/enrollment";
import { requireConsent } from "../../../schema";

export const dynamic = "force-dynamic";

/** Henüz gönderimde olmayan diziyi kampanyadan çıkarır (FR-CMP-05). */
export const DELETE = route(
  async (_req: Request, ctx: { params: Promise<{ id: string; clId: string }> }) => {
    const db = await database();
    const p = await ctx.params;
    const id = intParam(p.id);
    const clId = intParam(p.clId, "dizi");
    await requireConsent(db);
    return json(await removeCampaignLead(db, id, clId));
  },
);
