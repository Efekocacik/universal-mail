import { eq } from "drizzle-orm";
import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import { categorySets } from "@/lib/db/schema";
import { isValidPlaceType } from "@/lib/scan/queries";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    placeTypes: z
      .array(z.string().trim().refine(isValidPlaceType, "Geçersiz tür adı"))
      .max(20)
      .optional(),
  })
  .strict();

export const PATCH = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const patch = await body(req, patchSchema);
  const existing = await db.select().from(categorySets).where(eq(categorySets.id, id)).limit(1);
  if (!existing[0]) throw new HttpError(404, "Kategori bulunamadı.");
  await db
    .update(categorySets)
    .set({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.keywords ? { keywords: [...new Set(patch.keywords)] } : {}),
      ...(patch.placeTypes ? { placeTypes: [...new Set(patch.placeTypes)] } : {}),
    })
    .where(eq(categorySets.id, id));
  const row = (await db.select().from(categorySets).where(eq(categorySets.id, id)).limit(1))[0];
  return json({ category: row });
});
