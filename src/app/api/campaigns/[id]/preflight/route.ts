import { database, intParam, json, route } from "@/lib/api/http";
import { runPreflight } from "@/lib/campaigns/preflight";

export const dynamic = "force-dynamic";

/** Başlatma öncesi özet: engeller, sayılar, tahmin, ilk 5 önizleme ve başlatma belirteci. Yazma yapmaz. */
export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  return json(await runPreflight(db, intParam((await ctx.params).id)));
});
