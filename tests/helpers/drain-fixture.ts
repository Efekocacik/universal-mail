import type { Db } from "@/lib/db/client";
import { setSetting } from "@/lib/settings";
import { checkDeliveryHealth } from "@/lib/unsubscribe/endpoint";

/**
 * Canlı kampanya gönderiminin çekme kapısını (`evaluateDrainGate`) karşılar: çekme işi Ayarlar'dan açık ve `now`
 * anında sağlıklı bir kuyruk kaydı var (ağ yok; istatistik sahte). Uç nokta adresi değiştirilirse sağlık kaydı
 * sıfırlandığından, bu çağrı `setUnsubscribeBaseUrl`'den SONRA yapılmalıdır.
 */
export async function enableHealthyDrain(db: Db, now: number): Promise<void> {
  await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
  const r = await checkDeliveryHealth(
    db,
    { getStats: async () => ({ depth: 0, oldestAgeMs: null, corrupt: 0 }) },
    now,
  );
  if (!r.ok) throw new Error("sağlıklı kuyruk kaydı yazılamadı");
}
