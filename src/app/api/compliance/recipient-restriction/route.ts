import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  getRecipientRestrictionState,
  updateRecipientRestriction,
} from "@/lib/compliance/recipient-restriction";
import { requireConsent } from "../../campaigns/schema";

export const dynamic = "force-dynamic";

/**
 * Test alıcı sınırı ("test modu"). AÇIKKEN gerçek kampanya iletileri yalnızca listedeki TAM adreslere gider (uygunluk
 * denetimi ve Gmail sağlayıcısı, ikisi de sunucuda). Varsayılan KAPALI. Bkz. src/lib/compliance/recipient-restriction.ts.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return json(await getRecipientRestrictionState(db));
});

const putSchema = z
  .object({
    enabled: z.boolean(),
    // Alan adı veya joker kabul edilmez (servis her girdiyi tam adres olarak doğrular); üst sınır çok fazla girdiyi keser.
    addresses: z.array(z.string().max(254)).max(100),
    /** Gevşetme (kapatmak veya adres eklemek) için açık onay; çalışan canlı kampanyalar duraklatılır. */
    ackLoosening: z.boolean().optional(),
  })
  .strict();

/**
 * Sınırı günceller. Açarken liste AÇIKÇA verilmelidir (boş liste ile açılamaz). Sıkılaştırma (açmak, adres çıkarmak)
 * serbesttir; gevşetme `ackLoosening: true` ister ve çalışan canlı kampanyaları duraklatır (açık yeniden başlatma
 * onayı bekler). Her değişiklik denetim kaydına yazılır (adresler yazılmaz, yalnızca sayılar).
 */
export const PUT = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, putSchema);
  await requireConsent(db);
  return json(await updateRecipientRestriction(db, input));
});
