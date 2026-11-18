"use client";

import { useQuery } from "@tanstack/react-query";
import type { RestrictionState } from "@/lib/compliance/recipient-restriction";
import { api } from "./api";

export type { RestrictionState };

export const RESTRICTION_QUERY_KEY = ["compliance", "recipient-restriction"] as const;

export interface RestrictionUpdateResponse {
  state: RestrictionState;
  loosened: boolean;
  pausedCampaigns: number[];
  changed: boolean;
}

/** Test alıcı sınırı durumu (salt okunur). Uyarı bandı ve Ayarlar kartı aynı sorguyu paylaşır. */
export const useRecipientRestriction = () =>
  useQuery({
    queryKey: RESTRICTION_QUERY_KEY,
    queryFn: () => api<RestrictionState>("/api/compliance/recipient-restriction"),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

export const restrictionApi = {
  update: (input: { enabled: boolean; addresses: string[]; ackLoosening?: boolean }) =>
    api<RestrictionUpdateResponse>("/api/compliance/recipient-restriction", {
      method: "PUT",
      json: input,
    }),
};
