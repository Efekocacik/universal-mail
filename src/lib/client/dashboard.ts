"use client";

import { useQuery } from "@tanstack/react-query";
import type { DashboardData } from "@/lib/dashboard";
import { getLocale } from "@/lib/i18n";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

export type {
  DashboardBudget,
  DashboardCounters,
  DashboardMailboxQueue,
  DashboardNewItem,
  DashboardNotification,
  DashboardScheduleItem,
  DashboardSection,
} from "@/lib/dashboard";

/** Gösterge paneli yanıtı (sunucu süreleri başlıkta gelir, gövdede yoktur). */
export type DashboardResponse = Omit<DashboardData, "timings">;

/** Panel her dakika ve pencereye dönüldüğünde tazelenir; yalnızca okuma olduğu için yeniden deneme güvenlidir. */
export const DASHBOARD_REFRESH_MS = 60_000;

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function dashboardUrl(locale: string, timeZone: string | null): string {
  const q = new URLSearchParams({ locale });
  if (timeZone) q.set("tz", timeZone);
  return `/api/dashboard?${q.toString()}`;
}

export const useDashboard = () => {
  const locale = getLocale();
  return useQuery({
    queryKey: ["dashboard", locale] as const,
    queryFn: () => api<DashboardResponse>(dashboardUrl(locale, browserTimeZone())),
    refetchInterval: DASHBOARD_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
};
