import { database, HttpError, intParam, json, route, body } from "@/lib/api/http";
import { getLeadDetail } from "@/lib/leads/query";
import { leadPatchSchema, patchLead } from "@/lib/leads/mutations";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

async function detail(id: number) {
  const db = await database();
  const row = await getLeadDetail(db, id);
  if (!row) throw new HttpError(404, "Lead bulunamadı.");
  const cacheDays = await getSetting(db, "google.cacheDays");
  const fetched = row.place?.googleFetchedAt ?? null;
  const stale = fetched !== null && Date.now() - fetched > cacheDays * 86_400_000;
  return { lead: row.lead, place: row.place, googleDataStale: stale, googleCacheDays: cacheDays };
}

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  return json(await detail(intParam((await ctx.params).id)));
});

export const PATCH = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const patch = await body(req, leadPatchSchema);
  if (!(await patchLead(db, id, patch))) throw new HttpError(404, "Lead bulunamadı.");
  return json(await detail(id));
});
