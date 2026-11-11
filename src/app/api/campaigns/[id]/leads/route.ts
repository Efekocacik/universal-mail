import { body, database, intParam, json, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import { addLeadsToCampaign, listCampaignQueue, MAX_ADD_BATCH } from "@/lib/campaigns/enrollment";
import { queryLeadIds } from "@/lib/leads/query";
import { addLeadsSchema, queryInt, queueStatusSchema, requireConsent } from "../../schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Kuyruk görünümü (FR-CMP-05). Alıcı adresi maskelidir. */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const sp = new URL(req.url).searchParams;
  const status = sp.get("status") ? queueStatusSchema.parse(sp.get("status")) : undefined;
  return json(
    await listCampaignQueue(db, id, {
      status,
      afterId: queryInt(sp, "afterId", 0),
      limit: Math.min(Math.max(queryInt(sp, "limit", 100), 1), 500),
    }),
  );
});

/** Lead ekleme: kimlik listesiyle veya leads ekranının filtre sorgusuyla (eklendiği andaki görüntü). */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, addLeadsSchema);
  await requireConsent(db);
  let leadIds: number[];
  let selection: unknown;
  if ("leadIds" in input) {
    leadIds = input.leadIds;
    selection = { kind: "ids", count: leadIds.length };
  } else {
    const filters = parseLeadFilters(new URLSearchParams(input.filterQuery));
    leadIds = await queryLeadIds(db, filters, MAX_ADD_BATCH);
    selection = { kind: "filter", filters, count: leadIds.length };
  }
  return json(await addLeadsToCampaign(db, id, leadIds, { selection }));
});
