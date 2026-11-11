import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { ensureSigningKey, rotateSigningKey } from "@/lib/unsubscribe/keys";
import { requireConsent } from "../../../../campaigns/schema";
import { keyActionSchema, withUnsubscribeLock } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Çıkış bağlantısı imza anahtarı: `ensure` yoksa üretir (varsa aynısını döner), `rotate` yenisini etkin yapar.
 * Döndürmeden sonra uç nokta DOĞRULANMAMIŞ sayılır: aktarıcıya yeni anahtar dosyası yüklenip yeniden doğrulanmalıdır.
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { action } = await body(req, keyActionSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    if (action === "ensure") return json({ kid: (await ensureSigningKey(db)).kid, rotated: false });
    const r = await rotateSigningKey(db);
    return json({ kid: r.kid, previous: r.previous, rotated: true, reverifyRequired: true });
  });
});
