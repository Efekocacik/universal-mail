import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { ensureChannelKey, rotateChannelKey } from "@/lib/unsubscribe/channel";
import { requireConsent } from "../../../../campaigns/schema";
import { keyActionSchema, withUnsubscribeLock } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Aktarıcı kanalı imza anahtarı: `ensure` yoksa üretir, `rotate` yenisini etkin yapar (eskisi iptal edilene kadar
 * aktarıcıda geçerli kalabilir). Aktarıcı yeni anahtarı tanıyana kadar olay çekme 401 ile başarısız olur.
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { action } = await body(req, keyActionSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    const r = action === "ensure" ? await ensureChannelKey(db) : await rotateChannelKey(db);
    return json({ kid: r.kid, rotated: action === "rotate" });
  });
});
