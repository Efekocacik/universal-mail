import { database, json, route } from "@/lib/api/http";
import { aiUsage } from "@/lib/ai/service";

export const dynamic = "force-dynamic";

/** Bu (UTC) ayın Claude kullanımı: istek, belirteç ve tahmini USD (canlı üretimler + faturalanmış başarısız yanıtlar). */
export const GET = route(async () => {
  const db = await database();
  return json(await aiUsage(db));
});
