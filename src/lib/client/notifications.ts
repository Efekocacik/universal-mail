"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Bildirim istemcisi (Paket B sözleşmesi; zil ve açılır liste Paket D'de). Sunucu metni arayüz dilinde üretir.
 *  GET  /api/notifications?limit=1..50&before=<id>&unread=1 → {items, unread}
 *  POST /api/notifications/read {ids:number[]} | {all:true}  → {updated, unread}
 *  Okunmamış sayısı ayrıca `useStatus().data.unreadNotifications` ile (mevcut yoklamada) gelir.
 */
export interface NotificationItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  /** Uygulama içi yol; `router.push` ile açılır (dış adres olmaz). */
  url: string;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationList {
  items: NotificationItem[];
  unread: number;
}

export const notificationKeys = {
  list: (limit: number) => ["notifications", limit] as const,
};

/** Bildirim listesi; yalnızca `enabled` (ör. açılır liste açıkken) yoklanır. */
export function useNotifications(limit = 20, enabled = true) {
  return useQuery({
    queryKey: notificationKeys.list(limit),
    enabled,
    queryFn: () => api<NotificationList>(`/api/notifications?limit=${limit}`),
    refetchInterval: enabled ? 30_000 : false,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sel: { ids: number[] } | { all: true }) =>
      api<{ updated: number; unread: number }>("/api/notifications/read", {
        method: "POST",
        json: sel,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}

/** Uygulama içi yol mu? (Sunucu zaten doğrular; istemci de dış adrese yönlendirmez.) */
export function isInAppPath(url: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_\-?=&.%]*$/.test(url) && !url.includes("\\");
}
