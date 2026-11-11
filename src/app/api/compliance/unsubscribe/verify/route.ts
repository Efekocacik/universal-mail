import { database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { buildHttpSource } from "@/lib/unsubscribe/drain-job";
import { verifyOneClickEndpoint } from "@/lib/unsubscribe/endpoint";
import { requireConsent } from "../../../campaigns/schema";
import { withUnsubscribeLock } from "../shared";

export const dynamic = "force-dynamic";

/**
 * UÇTAN UCA doğrulama (YALNIZCA kullanıcı eylemiyle): imzalı SINAMA belirteci aktarıcıya gerçek bir RFC 8058 POST ile
 * gönderilir, olay kanaldan geri çekilir ve uygulama kendisi doğrular. Sınama hiçbir alıcıya/engele dokunmaz.
 * Sonuç her zaman `lastAttempt` olarak kaydedilir (kanal hatası dahil: `channel_failed`).
 */
export const POST = domainRoute(async () => {
  const db = await database();
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    const bundle = await buildHttpSource(db);
    if (!bundle) {
      throw new HttpError(
        409,
        "Doğrulama için önce çıkış adresi ve kanal anahtarı tanımlanmalıdır.",
        { code: "NOT_CONFIGURED" },
      );
    }
    return json({ outcome: await verifyOneClickEndpoint(db, { source: bundle.source }) });
  });
});
