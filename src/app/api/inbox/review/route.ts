import { database, json, route } from "@/lib/api/http";
import { listReviewQueue } from "@/lib/mail/inbound/review-list";

export const dynamic = "force-dynamic";

/** İnceleme gerekli gelen iletiler (otomatik etki üretmeyenler). Gönderen adresi ve gövde yoktur. */
export const GET = route(async () => {
  const db = await database();
  return json({ items: await listReviewQueue(db) });
});
