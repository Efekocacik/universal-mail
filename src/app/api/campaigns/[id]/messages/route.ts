import { database, intParam, json, route } from "@/lib/api/http";
import { listCampaignMessages } from "@/lib/campaigns/messages";
import { queryInt } from "../../schema";

export const dynamic = "force-dynamic";

/** Gönderim günlüğü (salt okunur): maskeli alıcı, maskeli konu, durum ve hata kodu. Gövde döndürülmez. */
export const GET = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const sp = new URL(req.url).searchParams;
  return json(
    await listCampaignMessages(db, id, {
      beforeId: queryInt(sp, "beforeId", 0),
      limit: Math.min(Math.max(queryInt(sp, "limit", 100), 1), 500),
    }),
  );
});
