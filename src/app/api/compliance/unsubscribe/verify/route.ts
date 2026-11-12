import { database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { buildHttpSource, httpSourceProblem } from "@/lib/unsubscribe/drain-job";
import { recordVerifyProblem, verifyOneClickEndpoint } from "@/lib/unsubscribe/endpoint";
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
      if ((await httpSourceProblem(db)) === "no_channel_key") {
        // Kanal anahtarı tanımlı görünür ama özel anahtarı okunamıyor (gizli bilgiler sıfırlandı): neden kaydedilir.
        await recordVerifyProblem(db, "no_channel_key");
        throw new HttpError(
          409,
          "Kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlanmış olabilir). Kanal anahtarında “Yeni anahtara geç”i seçin, anahtar dosyasını yeniden yükleyin.",
          { code: "CHANNEL_KEY_UNREADABLE" },
        );
      }
      throw new HttpError(
        409,
        "Doğrulama için önce çıkış adresi ve kanal anahtarı tanımlanmalıdır.",
        { code: "NOT_CONFIGURED" },
      );
    }
    return json({ outcome: await verifyOneClickEndpoint(db, { source: bundle.source }) });
  });
});
