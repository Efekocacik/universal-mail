import { database, json, route } from "@/lib/api/http";
import { parseLeadFilters, parseSort } from "@/lib/api/filters";
import { queryLeads } from "@/lib/leads/query";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(sp.get("offset")) || 0, 0);
  const result = await queryLeads(db, parseLeadFilters(sp), { sort: parseSort(sp), limit, offset });
  return json({ ...result, limit, offset });
});
