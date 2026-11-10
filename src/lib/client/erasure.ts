"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ErasureHistoryItem,
  ErasurePreview,
  ErasureResult,
  PendingErasures,
} from "@/lib/compliance/erasure";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/** Silme talebi istemcisi (Aşama 14). Adres yalnızca istek gövdesinde gider; yanıtlarda asla yer almaz. */

export type { ErasureHistoryItem, ErasurePreview, ErasureResult, PendingErasures };

export const ek = { all: ["erasure"] as const, state: ["erasure", "state"] as const };

export const useErasureState = () =>
  useQuery({
    queryKey: ek.state,
    queryFn: () =>
      api<{ pending: PendingErasures; history: ErasureHistoryItem[] }>("/api/compliance/erasure"),
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

export const erasureApi = {
  preview: (email: string) =>
    api<ErasurePreview>("/api/compliance/erasure/preview", { method: "POST", json: { email } }),
  execute: (input: {
    email: string;
    requestedAt: number;
    justification: string;
    confirm: true;
    clearNotes: boolean;
  }) => api<ErasureResult>("/api/compliance/erasure", { method: "POST", json: input }),
};
