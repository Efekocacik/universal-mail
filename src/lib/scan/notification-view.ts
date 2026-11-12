import type { Db } from "@/lib/db/client";
import { isLocale, type Locale } from "@/lib/i18n";
import { renderNotification, type NotificationRow } from "@/lib/notifications";
import { getSetting } from "@/lib/settings";

/**
 * Bildirim HTTP sözleşmesinin (Paket B uygular, D tüketir) satır biçimi. Metin, okunurken kullanıcının arayüz diline göre
 * üretilir; veritabanında yalnızca tür + parametreler vardır.
 */
export interface NotificationItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  readAt: number | null;
}

export async function notificationLocale(db: Db): Promise<Locale> {
  const lang = await getSetting(db, "ui.language");
  return isLocale(lang) ? lang : "tr";
}

export function toNotificationItem(row: NotificationRow, locale: Locale): NotificationItem {
  const { title, body } = renderNotification(row, locale);
  return {
    id: row.id,
    kind: row.kind,
    title,
    body,
    url: row.url,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}
