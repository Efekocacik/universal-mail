import { database, json, route } from "@/lib/api/http";
import { getWorkerStatus } from "@/lib/jobs/worker-status";

export const dynamic = "force-dynamic";

/** Arka plan işçisi canlılığı (salt okunur): gecikmiş gönderim/gelen kutusu/çıkış işleri veya çökme döngüsü. */
export const GET = route(async () => {
  const db = await database();
  return json(await getWorkerStatus(db));
});
