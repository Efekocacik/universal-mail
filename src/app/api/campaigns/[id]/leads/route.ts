import { body, database, intParam, json, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import {
  addLeadsToCampaign,
  listCampaignQueue,
  MAX_ADD_BATCH,
  type AddLeadsByFilterResult,
} from "@/lib/campaigns/enrollment";
import { CampaignError } from "@/lib/campaigns/errors";
import { countLeadIds, queryLeadIds } from "@/lib/leads/query";
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

/**
 * Lead ekleme: kimlik listesiyle veya leads ekranının filtre sorgusuyla (eklendiği andaki görüntü).
 *
 * Süzgeçle eklemede sayfalama: kampanyada zaten bulunan lead'ler atlanır (`excluded` olanlar yeniden
 * değerlendirilmek üzere en sona bırakılır), en fazla {@link MAX_ADD_BATCH} tanesi alınır. Yanıtta
 * `matched` (bu istekte aday olan), `taken` (alınan) ve `remaining` (ekleme SONRASI kampanyaya hiç eklenmemiş, süzgece
 * uyan) sayıları döner; `remaining > 0` iken aynı istek tekrarlandıkça sıradaki lead'ler eklenir.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, addLeadsSchema);
  await requireConsent(db);
  if ("leadIds" in input) {
    const leadIds = input.leadIds;
    return json(
      await addLeadsToCampaign(db, id, leadIds, {
        selection: { kind: "ids", count: leadIds.length },
      }),
    );
  }
  const filters = parseLeadFilters(new URLSearchParams(input.filterQuery));
  const page = { notInCampaignId: id };
  const matched = await countLeadIds(db, filters, page);
  const leadIds = await queryLeadIds(db, filters, MAX_ADD_BATCH, page);
  if (leadIds.length === 0) {
    throw new CampaignError(
      "invalid_input",
      "Süzgece uyan ve bu kampanyada henüz bulunmayan işletme kalmadı.",
      { matched: 0, taken: 0, remaining: 0 },
    );
  }
  const result = await addLeadsToCampaign(db, id, leadIds, {
    selection: { kind: "filter", filters, count: leadIds.length },
  });
  const remaining = await countLeadIds(db, filters, { ...page, includeExcluded: false });
  return json({
    ...result,
    matched,
    taken: leadIds.length,
    remaining,
  } satisfies AddLeadsByFilterResult);
});
