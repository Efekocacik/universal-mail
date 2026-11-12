"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/client/api";
import { fmtRelativeTime } from "@/lib/client/format";
import {
  badgeText,
  BELL_QUERY_KEY,
  fetchBell,
  markBellRead,
  unreadIncreased,
  type BellItem,
} from "@/lib/client/notification-bell";
import { qk, useStatus } from "@/lib/client/queries";
import { t } from "@/lib/i18n";

/**
 * Üst çubuktaki bildirim zili (Faz 4). Okunmamış sayı mevcut durum yoklamasından gelir (`/api/status`
 * `unreadNotifications`); liste yalnızca açılınca getirilir. Bir bildirime tıklamak ilgili sayfaya gider ve onu okundu
 * yapar. Tarayıcıda (Electron dışında) yeni bildirim geldiğinde kısa bir uyarı gösterilir; masaüstünde bu işi işletim
 * sistemi bildirimi yapar. Bildirim uçları henüz yoksa zil "kullanılamıyor" der, başka bir şeyi etkilemez.
 */
export function NotificationBell() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: status } = useStatus();
  const unread = (status as { unreadNotifications?: number } | undefined)?.unreadNotifications;

  const list = useQuery({
    queryKey: BELL_QUERY_KEY,
    queryFn: () => fetchBell(),
    enabled: open,
    staleTime: 0,
  });

  // Tarayıcıda yeni bildirim: sayı arttığında ve sayfa görünürken en yenisinin başlığını kısaca göster.
  const prev = useRef<number | undefined>(undefined);
  useEffect(() => {
    const before = prev.current;
    prev.current = unread;
    if (!unreadIncreased(before, unread) || window.universalMail?.osNotifications) return;
    if (document.visibilityState !== "visible") return;
    void fetchBell(1)
      .then((r) => {
        const top = r?.items[0];
        if (top && top.readAt === null) toast.info(t("bell.newToast", { title: top.title }));
      })
      .catch(() => undefined);
  }, [unread]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: BELL_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: qk.status });
  };
  const read = useMutation({
    mutationFn: markBellRead,
    onSuccess: refresh,
    onError: (e) => toast.error(errorText(e)),
  });

  const go = (item: BellItem) => {
    setOpen(false);
    if (item.readAt === null) read.mutate({ ids: [item.id] });
    router.push(item.url);
  };

  const badge = badgeText(unread);
  const label = badge
    ? `${t("notif.bell.label")}: ${t("bell.unreadCount", { n: unread ?? 0 })}`
    : t("notif.bell.label");
  const items = list.data?.items ?? [];
  const unavailable = list.isSuccess && list.data === null;
  const anyUnread = (list.data?.unread ?? 0) > 0 || items.some((i) => i.readAt === null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={t("notif.bell.label")}
          data-testid="notification-bell"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground"
        >
          <Bell className="size-4" aria-hidden />
          {badge && (
            <span
              aria-hidden
              data-testid="notification-badge"
              className="tabular absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
            >
              {badge}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" aria-label={t("notif.bell.label")}>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-semibold">{t("notif.bell.label")}</p>
          {anyUnread && (
            <Button
              size="sm"
              variant="ghost"
              loading={read.isPending}
              onClick={() => read.mutate({ all: true })}
            >
              {!read.isPending && <CheckCheck aria-hidden />} {t("notif.markAllRead")}
            </Button>
          )}
        </div>
        <div className="um-scroll max-h-96">
          {list.isLoading ? (
            <p className="p-4 text-[13px] text-muted-foreground">{t("common.loading")}</p>
          ) : list.isError ? (
            <p role="alert" className="p-4 text-[13px] text-destructive">
              {t("bell.loadError")}
            </p>
          ) : unavailable ? (
            <p className="flex items-center gap-2 p-4 text-[13px] text-muted-foreground">
              <BellOff className="size-4 shrink-0" aria-hidden />
              {t("bell.unavailable")}
            </p>
          ) : items.length === 0 ? (
            <p className="p-4 text-center text-[13px] text-muted-foreground">{t("notif.empty")}</p>
          ) : (
            <ul className="divide-y" aria-label={t("notif.bell.label")}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => go(item)}
                    className={cn(
                      "flex w-full gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-accent/60",
                      item.readAt === null && "bg-accent/30",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        item.readAt === null ? "bg-primary" : "bg-transparent",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-snug">
                        {item.title}
                        {item.readAt === null && (
                          <span className="sr-only"> ({t("bell.unread")})</span>
                        )}
                      </span>
                      {item.body && (
                        <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                          {item.body}
                        </span>
                      )}
                      {item.createdAt > 0 && (
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {fmtRelativeTime(item.createdAt)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
