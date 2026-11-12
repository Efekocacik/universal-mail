"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SavedFilterPayload, SavedFilterSortValue } from "@/lib/leads/saved-filter-payload";
import type { SavedFilterItem } from "@/lib/leads/saved-filters";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/** Kayıtlı süzgeçler istemcisi. Tipler sunucu modüllerinden YALNIZCA tip olarak alınır. */
export type { SavedFilterItem, SavedFilterPayload, SavedFilterSortValue };

export const sfk = { all: ["saved-filters"] as const };

export const useSavedFilters = () =>
  useQuery({
    queryKey: sfk.all,
    queryFn: () => api<{ items: SavedFilterItem[] }>("/api/saved-filters").then((r) => r.items),
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

export const savedFiltersApi = {
  create: (v: {
    name: string;
    payload: SavedFilterPayload;
    sort: SavedFilterSortValue;
    overwrite?: boolean;
  }) => api<{ item: SavedFilterItem }>("/api/saved-filters", { method: "POST", json: v }),
  update: (
    id: number,
    v: { name?: string; payload?: SavedFilterPayload; sort?: SavedFilterSortValue },
  ) => api<{ item: SavedFilterItem }>(`/api/saved-filters/${id}`, { method: "PATCH", json: v }),
  remove: (id: number) => api<null>(`/api/saved-filters/${id}`, { method: "DELETE" }),
  /** Son kullanım zamanı (sıralama için). Hata önemsizdir; sessizce yutulur. */
  use: (id: number) =>
    api<null>(`/api/saved-filters/${id}/use`, { method: "POST" }).catch(() => null),
};

/** Değişiklik sonrası listeyi tazeleyen mutasyon kancası. */
export function useSavedFilterMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => void qc.invalidateQueries({ queryKey: sfk.all }),
  });
}
