"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, toSearchParams } from "./api";
import type {
  AppConfig,
  AppStatus,
  BudgetStatus,
  Category,
  CityResult,
  Facets,
  LeadDetailResponse,
  LeadRow,
  ScanListItem,
  SettingsResponse,
} from "./types";

export const qk = {
  config: ["config"] as const,
  status: ["status"] as const,
  settings: ["settings"] as const,
  categories: ["categories"] as const,
  countries: ["countries"] as const,
  scans: ["scans"] as const,
  budget: ["budget"] as const,
  leads: (f: unknown, sort: string) => ["leads", f, sort] as const,
  points: (f: unknown) => ["points", f] as const,
  facets: (f: unknown) => ["facets", f] as const,
  lead: (id: number | null) => ["lead", id] as const,
};

export const useConfig = () =>
  useQuery({ queryKey: qk.config, queryFn: () => api<AppConfig>("/api/config") });

/** Üst çubuk durumu: sürmekte olan taramalar ve bütçe. Tarama varken sık, yoksa seyrek yoklanır. */
export const useStatus = () =>
  useQuery({
    queryKey: qk.status,
    queryFn: () => api<AppStatus>("/api/status"),
    refetchInterval: (q) =>
      q.state.data?.scans.some((s) => s.status === "running" || s.status === "queued")
        ? 1500
        : 6000,
    staleTime: 1000,
  });

export const useSettings = () =>
  useQuery({ queryKey: qk.settings, queryFn: () => api<SettingsResponse>("/api/settings") });
export const useCategories = () =>
  useQuery({
    queryKey: qk.categories,
    queryFn: () => api<{ categories: Category[] }>("/api/categories").then((r) => r.categories),
  });
export const useCountries = () =>
  useQuery({
    queryKey: qk.countries,
    queryFn: () =>
      api<{ countries: { code: string; name: string }[]; defaultExcluded: string[] }>(
        "/api/countries",
      ),
    staleTime: Infinity,
  });
export const useScans = (poll = false) =>
  useQuery({
    queryKey: qk.scans,
    queryFn: () => api<{ scans: ScanListItem[] }>("/api/scans").then((r) => r.scans),
    refetchInterval: poll ? 2000 : false,
  });
export const useBudget = () =>
  useQuery({ queryKey: qk.budget, queryFn: () => api<BudgetStatus>("/api/budget") });

export function useCitySearch(q: string, countries: string[]) {
  const enabled = q.trim().length >= 2;
  return useQuery({
    queryKey: ["cities", q, countries],
    enabled,
    queryFn: () =>
      api<{ cities: CityResult[] }>(
        `/api/cities?${toSearchParams({ q, cc: countries, limit: 8 })}`,
      ).then((r) => r.cities),
    staleTime: 60_000,
  });
}

export const PAGE_SIZE = 80;

export function useLeadsInfinite(filters: Record<string, unknown>, sort: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.leads(filters, sort),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<{ rows: LeadRow[]; total: number; offset: number }>(
        `/api/leads?${toSearchParams({ ...filters, sort, limit: PAGE_SIZE, offset: pageParam })}`,
      ),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: (prev) => prev,
  });
}

export const usePoints = (filters: Record<string, unknown>, enabled = true) =>
  useQuery({
    queryKey: qk.points(filters),
    enabled,
    queryFn: () =>
      api<{ points: number[][]; total: number; truncated: boolean }>(
        `/api/leads/points?${toSearchParams(filters)}`,
      ),
    placeholderData: (prev) => prev,
  });

export const useFacets = (filters: Record<string, unknown>) =>
  useQuery({
    queryKey: qk.facets(filters),
    queryFn: () => api<Facets>(`/api/leads/facets?${toSearchParams(filters)}`),
    placeholderData: (prev) => prev,
  });

export const useLead = (id: number | null) =>
  useQuery({
    queryKey: qk.lead(id),
    enabled: id !== null,
    queryFn: () => api<LeadDetailResponse>(`/api/leads/${id}`),
  });

export function usePatchLead(id: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { status?: string; notes?: string | null; tags?: string[] }) =>
      api<LeadDetailResponse>(`/api/leads/${id}`, { method: "PATCH", json: patch }),
    onSuccess: (data) => {
      qc.setQueryData(qk.lead(id), data);
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["points"] });
      void qc.invalidateQueries({ queryKey: ["facets"] });
    },
  });
}
