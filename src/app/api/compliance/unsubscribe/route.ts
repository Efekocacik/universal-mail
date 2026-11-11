import { database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { buildUnsubscribeState } from "@/lib/unsubscribe/state";

export const dynamic = "force-dynamic";

/**
 * Çıkış altyapısının GENEL durumu (TB-3): temel adres, anahtar kimlikleri, kanıt ve teslimat durumu, çekme anahtarı.
 * Yalnızca veritabanını okur; hiçbir ağ isteği yapmaz. Gizli bilgi veya sınama `jti` değeri dönmez.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  return json(await buildUnsubscribeState(db, process.env));
});
