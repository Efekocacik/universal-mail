import { database, intParam, json } from "@/lib/api/http";
import { setBatchArchived } from "@/lib/import/service";
import { importRoute } from "../../http";

export const dynamic = "force-dynamic";

/**
 * Geri alınan içe aktarmanın (yalnızca "Geri al" ile arşivlenmiş) lead'lerini arşivden çıkarır; listede artık aynı işletme
 * varsa o lead arşivde kalır. İdempotent. 200 `{batch, changed, skippedActive: 0, skippedDuplicate}`; 404.
 */
export const POST = importRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  return json(await setBatchArchived(db, id, false));
});
