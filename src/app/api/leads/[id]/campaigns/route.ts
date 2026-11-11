import { database, intParam, json, route } from "@/lib/api/http";
import { listLeadCampaigns } from "@/lib/campaigns/lead-campaigns";

export const dynamic = "force-dynamic";

/** Bir lead'in kampanyalardaki durumu ve varsa hariç tutulma gerekçeleri (salt okunur; alıcı adresi yok). */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  return json({ items: await listLeadCampaigns(db, intParam((await ctx.params).id)) });
});
