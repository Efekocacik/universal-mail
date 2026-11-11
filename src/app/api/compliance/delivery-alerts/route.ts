import { database, json, route } from "@/lib/api/http";
import { getDeliveryAlerts } from "@/lib/unsubscribe/delivery-alert";

export const dynamic = "force-dynamic";

/**
 * Çıkış teslimatı uyarıları (C14, salt okunur). Yalnızca saklanan son sağlık kaydı ve doğrulama kanıtı okunur;
 * aktarıcıya istek atılmaz, sağlık denetimi başlatılmaz. Adres, anahtar veya sayaç döndürülmez.
 */
export const GET = route(async () => {
  const db = await database();
  return json({ alerts: await getDeliveryAlerts(db) });
});
