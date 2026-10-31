import { body, database, intParam, json, route } from "@/lib/api/http";
import { setCampaignSteps } from "@/lib/campaigns/service";
import { requireConsent, stepsSchema } from "../../schema";

export const dynamic = "force-dynamic";

export const PUT = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { expectedUpdatedAt, steps } = await body(req, stepsSchema);
  await requireConsent(db);
  return json(await setCampaignSteps(db, id, steps, { expectedUpdatedAt }));
});
