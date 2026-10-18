import { asc } from "drizzle-orm";
import { json, route, database } from "@/lib/api/http";
import { categorySets } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const db = await database();
  const rows = await db
    .select()
    .from(categorySets)
    .orderBy(asc(categorySets.sortOrder), asc(categorySets.id));
  return json({ categories: rows });
});
