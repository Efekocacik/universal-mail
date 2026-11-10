import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { executeErasure, listErasureHistory, listPendingErasures } from "@/lib/compliance/erasure";
import { requireConsent } from "../../campaigns/schema";
import { erasureSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/** Bekleyen (hukuki değerlendirme bekleyen) kayıt sayıları ve son talepler. Adres içermez. */
export const GET = domainRoute(async () => {
  const db = await database();
  return json({
    pending: await listPendingErasures(db),
    history: await listErasureHistory(db),
  });
});

/**
 * Silme talebini uygular (GERİ ALINAMAZ). Açık onay, talep tarihi ve gerekçe ister. Kullanıcı beyanı hukuki onay
 * yerine geçmez: gerçek gönderim kayıtları hukuki değerlendirme tamamlanana kadar bekler ve yanıtta bildirilir.
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, erasureSchema);
  await requireConsent(db);
  return json(await executeErasure(db, input));
});
