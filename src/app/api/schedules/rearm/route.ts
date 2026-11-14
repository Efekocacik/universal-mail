import { database, json, route } from "@/lib/api/http";
import { scheduleTick } from "@/lib/scan/schedule";

export const dynamic = "force-dynamic";

/**
 * Kopmuş zamanlama zincirini yeniden kurar ("Yeniden başlat" düğmesi; durum özeti `schedules.stalled`). İdempotent:
 * kuyrukta/çalışan tick varsa yenisi eklenmez, yalnızca zamanı şimdiye çekilir. Ücretli çağrı yapmaz; tick'in kendisi
 * zamanlamaları normal kapılarla (kurulum, bütçe, onaylı tutar) çalıştırır. Aynı köken denetimi middleware'dedir.
 * 200 `{armed: true}`.
 */
export const POST = route(async () => {
  const db = await database();
  const now = Date.now();
  await scheduleTick(db, { runAt: now, now, pullForward: true });
  return json({ armed: true });
});
