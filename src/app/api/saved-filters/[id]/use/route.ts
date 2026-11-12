import { database, HttpError, intParam, route } from "@/lib/api/http";
import { touchSavedFilter } from "@/lib/leads/saved-filters";

export const dynamic = "force-dynamic";

/** "Uygula" anında son kullanım zamanını işler (liste sırası için). 204; kayıt yoksa 404. */
export const POST = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  if (!(await touchSavedFilter(db, intParam((await ctx.params).id))))
    throw new HttpError(404, "Kayıtlı süzgeç bulunamadı.", { code: "SAVED_FILTER_NOT_FOUND" });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
