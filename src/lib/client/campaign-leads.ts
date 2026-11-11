"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  AddLeadsByFilterResult,
  QueueItem,
  ReevaluateResult,
} from "@/lib/campaigns/enrollment";
import { api } from "./api";
import { ck } from "./campaigns";
import { shouldRetryQuery, queryRetryDelay } from "./retry";

/**
 * Kampanya alıcıları: süzgeçle sayfa sayfa ekleme ve hariç tutulanları yeniden denetleme. Tipler sunucu modüllerinden
 * YALNIZCA tip olarak alınır. Değişiklik yapan çağrılar tek denemedir (bkz. `campaigns.ts`).
 */

export type { AddLeadsByFilterResult, ReevaluateResult };

/** Hariç tutulan dizi sayısı (`ck.all` altında: kampanya değişikliklerinden sonra kendiliğinden yenilenir). */
export const excludedCountKey = (id: number) => [...ck.queue(id, "excluded"), "count"] as const;

export const useExcludedCount = (id: number, enabled = true) =>
  useQuery({
    queryKey: excludedCountKey(id),
    queryFn: () =>
      api<{ items: QueueItem[]; total: number }>(
        `/api/campaigns/${id}/leads?status=excluded&limit=1`,
      ).then((r) => r.total),
    enabled,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

export const campaignLeadsApi = {
  addByFilter: (id: number, filterQuery: string) =>
    api<AddLeadsByFilterResult>(`/api/campaigns/${id}/leads`, {
      method: "POST",
      json: { filterQuery },
    }),
  reevaluate: (id: number) =>
    api<ReevaluateResult>(`/api/campaigns/${id}/leads/reevaluate`, { method: "POST" }),
};
