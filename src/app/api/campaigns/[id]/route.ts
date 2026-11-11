import { body, database, intParam, json, route } from "@/lib/api/http";
import { getCampaign, updateCampaign } from "@/lib/campaigns/service";
import { requireConsent, updateCampaignSchema } from "../schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  return json(await getCampaign(db, intParam((await ctx.params).id)));
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { expectedUpdatedAt, ...patch } = await body(req, updateCampaignSchema);
  await requireConsent(db);
  return json(await updateCampaign(db, id, patch, { expectedUpdatedAt }));
});
