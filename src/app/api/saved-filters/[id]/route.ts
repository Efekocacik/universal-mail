import { body, database, intParam, json, route } from "@/lib/api/http";
import {
  deleteSavedFilter,
  patchSavedFilterSchema,
  updateSavedFilter,
} from "@/lib/leads/saved-filters";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Ad, süzgeç veya sıralama değiştirme. 404 `SAVED_FILTER_NOT_FOUND`; ad çakışması 409 `SAVED_FILTER_EXISTS`. */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const patch = await body(req, patchSavedFilterSchema);
  return json({ item: await updateSavedFilter(db, id, patch) });
});

/** Silme idempotenttir: kayıt zaten yoksa da 204. */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  await deleteSavedFilter(db, intParam((await ctx.params).id));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
