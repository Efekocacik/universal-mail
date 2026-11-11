import { body, database, json, route } from "@/lib/api/http";
import { createCampaign, listCampaigns } from "@/lib/campaigns/service";
import { campaignStatusSchema, createCampaignSchema, queryInt, requireConsent } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ? campaignStatusSchema.parse(sp.get("status")) : undefined;
  const limit = Math.min(Math.max(queryInt(sp, "limit", 50), 1), 200);
  const offset = queryInt(sp, "offset", 0);
  return json({ items: await listCampaigns(db, { status, limit, offset }), limit, offset });
});

export const POST = route(async (req: Request) => {
  const db = await database();
  const input = await body(req, createCampaignSchema);
  await requireConsent(db);
  return json(await createCampaign(db, input), { status: 201 });
});
