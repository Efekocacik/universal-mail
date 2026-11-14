import { database, intParam, json, route } from "@/lib/api/http";
import { getCampaignStats } from "@/lib/campaigns/stats";

export const dynamic = "force-dynamic";

/** Faz 5: A/B konu varyantı ve açılma özeti (salt okunur, kişisel veri yok). */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  return json(await getCampaignStats(db, intParam((await ctx.params).id)));
});
