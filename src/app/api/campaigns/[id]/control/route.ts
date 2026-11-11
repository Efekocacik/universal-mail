import { body, database, intParam, json, route } from "@/lib/api/http";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { controlSchema, requireConsent } from "../../schema";

export const dynamic = "force-dynamic";

/**
 * Durum geçişleri: ready, draft, start (başlatma belirteci zorunlu), pause, resume, cancel.
 * Not: geçiş kaydedilmeden önce ayrılmış en fazla bir ileti yine de tamamlanabilir (bkz. campaigns/lifecycle.ts).
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { action, confirmToken } = await body(req, controlSchema);
  await requireConsent(db);
  return json(await transitionCampaign(db, id, action, { confirmToken }));
});
