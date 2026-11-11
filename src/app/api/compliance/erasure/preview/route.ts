import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { previewErasure } from "@/lib/compliance/erasure";
import { erasurePreviewSchema } from "../../../mail/schema";

export const dynamic = "force-dynamic";

/** Silmeden önce yalnızca SAYILARI gösterir; adresi yanıtta yankılamaz. Hiçbir şey değiştirmez. */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { email } = await body(req, erasurePreviewSchema);
  return json(await previewErasure(db, email));
});
