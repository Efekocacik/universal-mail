import { database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { buildHttpSource } from "@/lib/unsubscribe/drain-job";
import { checkDeliveryHealth } from "@/lib/unsubscribe/endpoint";
import { requireConsent } from "../../../campaigns/schema";
import { withUnsubscribeLock } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Aktarıcı kuyruğunun sağlığı (YALNIZCA kullanıcı eylemiyle): derinlik, en eski olayın yaşı, bozuk kayıt sayısı.
 * Sonuç (erişilemezlik dahil) kaydedilir; olay çekilmez veya onaylanmaz.
 */
export const POST = domainRoute(async () => {
  const db = await database();
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    const bundle = await buildHttpSource(db);
    if (!bundle) {
      throw new HttpError(
        409,
        "Kuyruk denetimi için önce çıkış adresi ve kanal anahtarı tanımlanmalıdır.",
        { code: "NOT_CONFIGURED" },
      );
    }
    return json(await checkDeliveryHealth(db, bundle.stats));
  });
});
