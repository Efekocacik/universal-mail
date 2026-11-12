"use client";

import { useQuery } from "@tanstack/react-query";
import type { WorkerStatus } from "@/lib/jobs/worker-status";
import { api } from "./api";

export type { WorkerStatus };

/** Arka plan işçisi canlılığı; dakikada bir yoklanır (salt okunur, dış servise istek yok). */
export const useWorkerStatus = () =>
  useQuery({
    queryKey: ["worker-status"] as const,
    queryFn: () => api<WorkerStatus>("/api/worker-status"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
