"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { CountryPolicyView } from "@/lib/compliance/policy-service";
import type {
  SuppressionList,
  SuppressionListItem,
  SuppressionState,
} from "@/lib/compliance/suppression-list";
import type { CsvImportReport } from "@/lib/compliance/suppression";
import type { PolicyMode, SuppressionReason, SuppressionScope } from "@/lib/db/schema";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/** Uyum API'si istemcisi (Aşama 12): ülke politikası ve suppression yönetimi. */

export type {
  CountryPolicyView,
  CsvImportReport,
  PolicyMode,
  SuppressionList,
  SuppressionListItem,
  SuppressionReason,
  SuppressionScope,
  SuppressionState,
};

export interface PoliciesResponse {
  liveSendingEnabled: boolean;
  demo: CountryPolicyView[];
  live: CountryPolicyView[];
}

export interface SuppressionFilter {
  state: SuppressionState;
  reason?: SuppressionReason;
  scope?: SuppressionScope;
  q?: string;
}

export const xk = {
  all: ["compliance"] as const,
  policies: ["compliance", "policies"] as const,
  suppressions: (f: SuppressionFilter) => ["compliance", "suppressions", f] as const,
};

const getOpts = { retry: shouldRetryQuery, retryDelay: queryRetryDelay } as const;

export const usePolicies = () =>
  useQuery({
    queryKey: xk.policies,
    queryFn: () => api<PoliciesResponse>("/api/compliance/policies"),
    ...getOpts,
  });

function listUrl(f: SuppressionFilter, beforeId?: number): string {
  const sp = new URLSearchParams({ state: f.state, limit: "50" });
  if (f.reason) sp.set("reason", f.reason);
  if (f.scope) sp.set("scope", f.scope);
  if (f.q?.trim()) sp.set("q", f.q.trim());
  if (beforeId) sp.set("beforeId", String(beforeId));
  return `/api/compliance/suppressions?${sp}`;
}

export const useSuppressions = (f: SuppressionFilter) =>
  useInfiniteQuery({
    queryKey: xk.suppressions(f),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<SuppressionList>(listUrl(f, pageParam || undefined)),
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    ...getOpts,
  });

/** Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. */
export const complianceApi = {
  tighten: (countryCode: string, mode: PolicyMode) =>
    api<{ changed: boolean }>("/api/compliance/policies", {
      method: "PATCH",
      json: { countryCode, mode },
    }),
  addSuppression: (input: {
    kind: "email" | "domain";
    value: string;
    reason: "manual" | "negative_reply" | "unsubscribe" | "complaint";
    note?: string;
  }) =>
    api<{ outcome: "added" | "strengthened" | "existing"; id: number }>(
      "/api/compliance/suppressions",
      { method: "POST", json: input },
    ),
  lift: (id: number, justification: string) =>
    api<{ ok: true }>(`/api/compliance/suppressions/${id}/lift`, {
      method: "POST",
      json: { confirm: true, justification },
    }),
};
