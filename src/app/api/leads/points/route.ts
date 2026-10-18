import { database, json, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import { queryPoints } from "@/lib/leads/query";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const db = await database();
  return json(await queryPoints(db, parseLeadFilters(new URL(req.url).searchParams)));
});
