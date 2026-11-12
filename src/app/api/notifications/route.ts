import { z } from "zod";
import { database, json, route } from "@/lib/api/http";
import { listNotifications, unreadCount } from "@/lib/notifications";
import { notificationLocale, toNotificationItem } from "@/lib/scan/notification-view";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: z.coerce.number().int().min(1).optional(),
    unread: z.enum(["0", "1"]).optional(),
  })
  .strict();

/**
 * Zil listesi (yeniden eskiye). `?limit=1..50&before=<id>&unread=1`.
 * Yanıt: `{items:[{id,kind,title,body,url,createdAt,readAt}], unread}`; başlık/gövde arayüz dilinde üretilir.
 */
export const GET = route(async (req: Request) => {
  const db = await database();
  const q = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const [rows, unread, locale] = await Promise.all([
    listNotifications(db, { limit: q.limit, before: q.before, unreadOnly: q.unread === "1" }),
    unreadCount(db),
    notificationLocale(db),
  ]);
  return json({ items: rows.map((r) => toNotificationItem(r, locale)), unread });
});
