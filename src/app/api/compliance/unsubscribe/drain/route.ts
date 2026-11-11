import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { setUnsubscribeDrainEnabled } from "@/lib/unsubscribe/drain-job";
import { requireConsent } from "../../../campaigns/schema";
import { drainSchema, withUnsubscribeLock } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Çıkış olaylarını aktarıcıdan düzenli çekme işini açar/kapatır (`mail.unsubscribeDrain`; C4). Açıkken iş dakikada bir
 * aktarıcıya imzalı istek yapar; gönderimi AÇMAZ. Açılınca (temel adres varsa) hemen bir tur planlanır; kapatılınca
 * bekleyen turlar iptal edilir. Ortam bayrağı `UM_UNSUBSCRIBE_DRAIN_ENABLED` açıksa iş bu anahtardan bağımsız çalışır.
 */
export const PUT = domainRoute(async (req: Request) => {
  const db = await database();
  const { enabled } = await body(req, drainSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () =>
    json(await setUnsubscribeDrainEnabled(db, enabled, { env: process.env })),
  );
});
