import { database, json, route } from "@/lib/api/http";
import { claimForOs } from "@/lib/notifications";
import { notificationLocale, toNotificationItem } from "@/lib/scan/notification-view";

export const dynamic = "force-dynamic";

/**
 * Electron ana sürecinin işletim sistemi bildirimi yoklaması. Henüz OS'ta gösterilmemiş, okunmamış ve son 24 saatteki en
 * çok 5 bildirimi ATOMİK olarak sahiplenir (tek UPDATE … RETURNING): iki yoklayıcı aynı satırı asla birlikte almaz,
 * her bildirim OS'ta en çok bir kez görünür. `notifications.os` ayarı kapalıysa `[]`.
 * Gövde yoktur; Origin denetimi (middleware) geçerlidir. Denetim kaydı yazılmaz (makine yoklaması; zil kaydı kalıcıdır).
 */
export const POST = route(async () => {
  const db = await database();
  const [rows, locale] = await Promise.all([claimForOs(db, { limit: 5 }), notificationLocale(db)]);
  return json({ items: rows.map((r) => toNotificationItem(r, locale)) });
});
