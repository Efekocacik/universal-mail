import { database, intParam, json } from "@/lib/api/http";
import { setBatchArchived } from "@/lib/import/service";
import { importRoute } from "../../http";

export const dynamic = "force-dynamic";

/**
 * İçe aktarmayı geri al: partinin lead'leri arşivlenir (keşiften kalkar; "Geri getir" ile döner). Etkin kampanya
 * dizisindekiler arşivlenmez. İdempotent. 200 `{batch, changed, skippedActive, skippedDuplicate: 0}`; 404 NOT_FOUND.
 */
export const POST = importRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  return json(await setBatchArchived(db, id, true));
});
