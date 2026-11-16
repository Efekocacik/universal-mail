import { database, json } from "@/lib/api/http";
import { cancelStage } from "@/lib/backup/restore";
import { lifecycleRoute } from "../../http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ stageId: string }> };

/** Hazırlığı (ve ona bağlı bekleyen geri yüklemeyi) iptal eder. İdempotent: 200 `{cancelled:true}`. */
export const DELETE = lifecycleRoute(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  await cancelStage(db, (await ctx.params).stageId);
  return json({ cancelled: true });
});
