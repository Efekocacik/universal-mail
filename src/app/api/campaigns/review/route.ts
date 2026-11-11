import { database, json, route } from "@/lib/api/http";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";

export const dynamic = "force-dynamic";

/** Sonucu kesinleşmemiş gönderimler (salt okunur; alıcı maskeli). Çözüm veya yeniden gönderim işlemi YOKTUR. */
export const GET = route(async () => {
  const db = await database();
  return json({ items: await listSendsNeedingReview(db) });
});
