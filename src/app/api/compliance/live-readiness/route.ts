import { database, json, route } from "@/lib/api/http";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";

export const dynamic = "force-dynamic";

/** Canlı gönderime hazırlık (salt okunur). Gerçek gönderimi AÇMAZ; yalnızca neden kapalı olduğunu gösterir. */
export const GET = route(async () => {
  const db = await database();
  return json(await getLiveReadiness(db));
});
