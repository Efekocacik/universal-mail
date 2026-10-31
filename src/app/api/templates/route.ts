import { asc } from "drizzle-orm";
import { database, json, route } from "@/lib/api/http";
import { templates } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Kampanya adımları için şablon listesi (salt okunur; gövde döndürülmez). Düzenleme uçları Aşama 11'dedir. */
export const GET = route(async (req: Request) => {
  const db = await database();
  const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
  const rows = await db
    .select()
    .from(templates)
    .orderBy(asc(templates.language), asc(templates.kind), asc(templates.id));
  return json({
    items: rows
      .filter((t) => includeArchived || t.archivedAt === null)
      .map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        kind: t.kind,
        categoryKey: t.categoryKey,
        builtIn: t.builtIn,
        version: t.version,
        subject: t.subject,
        archived: t.archivedAt !== null,
      })),
  });
});
