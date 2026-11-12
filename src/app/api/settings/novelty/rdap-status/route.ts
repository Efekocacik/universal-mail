import { database, json, route } from "@/lib/api/http";
import { rdapStatus } from "@/lib/novelty/rdap-job";

export const dynamic = "force-dynamic";

/** Ayarlar > Yenilik: RDAP durumu (açık mı, önyükleme dosyası, alan adı sayıları, sıradaki denetimler). */
export const GET = route(async () => {
  const db = await database();
  return json(await rdapStatus(db, Date.now()));
});
