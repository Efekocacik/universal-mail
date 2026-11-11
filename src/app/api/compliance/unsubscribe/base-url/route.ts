import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { scheduleUnsubscribeDrainIfActive } from "@/lib/unsubscribe/drain-job";
import { setUnsubscribeBaseUrl } from "@/lib/unsubscribe/endpoint";
import { requireConsent } from "../../../campaigns/schema";
import { baseUrlSchema, withUnsubscribeLock } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Çıkış uç noktasının temel adresi (yalnızca güvenli HTTPS kökü, port ve yol olmadan). Değişince eski kanıtlar
 * SIFIRLANIR (yeniden doğrulama gerekir). Çekme işi açıksa hemen bir tur planlanır. Ağ isteği yapılmaz.
 */
export const PUT = domainRoute(async (req: Request) => {
  const db = await database();
  const { baseUrl } = await body(req, baseUrlSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    await setUnsubscribeBaseUrl(db, baseUrl);
    const scheduled = await scheduleUnsubscribeDrainIfActive(db, { env: process.env });
    return json({ ok: true, drainScheduled: scheduled });
  });
});
