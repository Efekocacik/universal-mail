import { database, json, route } from "@/lib/api/http";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import { withoutResolved } from "@/lib/mail/scheduler/resolve-review";

export const dynamic = "force-dynamic";

const LIMIT = 200;

/**
 * Sonucu kesinleşmemiş gönderimler (alıcı maskeli). Karara bağlanmış olanlar (`stop_sequence` sonrası `unknown` kalan
 * ileti) listelenmez. Karar `POST …/review/{messageId}` ile verilir; otomatik yeniden gönderim YOKTUR.
 */
export const GET = route(async () => {
  const db = await database();
  const items = await withoutResolved(db, await listSendsNeedingReview(db, { limit: 1000 }));
  return json({ items: items.slice(0, LIMIT) });
});
