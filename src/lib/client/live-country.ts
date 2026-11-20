"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Canlı ülke aktivasyonu istemci katmanı. Türler bilerek burada (sunucu hizmetini içe aktarmadan) tanımlıdır:
 * `live-country-activation.ts` yalnızca kendi rotası tarafından içe aktarılabilir.
 */

export const LIVE_COUNTRY_QUERY_KEY = ["compliance", "live-country"] as const;

export interface LiveCountryRow {
  countryCode: string;
  mode: string;
  locked: boolean;
  approvalRef: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
}

export interface PrerequisiteReport {
  ok: boolean;
  checks: { key: string; ok: boolean }[];
  testMode: { enabled: boolean; addresses: number; corrupt: boolean };
  selfTest: { mailboxId: number; ok: boolean }[];
}

export interface LiveCountryState {
  countries: LiveCountryRow[];
  prerequisites: PrerequisiteReport;
  nativeConfirmAvailable: boolean;
  runningLiveCampaigns: number;
  limits: { maxCountries: number; documentMaxAgeDays: number; selfTestMaxAgeDays: number };
}

export interface ActivationFormInput {
  countries: string[];
  mode: "generic_only" | "allowed";
  representativeName: string;
  representativeTitle: string;
  operatorName: string;
  documentRef: string;
  documentDate: string;
  documentSha256: string | null;
  scopeAttested: boolean;
}

export interface ActivationPlanResponse {
  prerequisites: PrerequisiteReport;
  countries: { countryCode: string; problems: string[] }[];
  blockers: string[];
  warnings: string[];
  runningLiveCampaigns: number;
  ready: boolean;
}

export const useLiveCountryState = () =>
  useQuery({
    queryKey: LIVE_COUNTRY_QUERY_KEY,
    queryFn: () => api<LiveCountryState>("/api/compliance/live-country"),
    staleTime: 10_000,
  });

export const liveCountryApi = {
  plan: (input: ActivationFormInput) =>
    api<ActivationPlanResponse>("/api/compliance/live-country", {
      method: "POST",
      json: { action: "plan", ...input },
    }),
  /** Yerel onay penceresi açılır; yanıt en çok ~2 dakika sonra gelir. */
  activate: (input: ActivationFormInput) =>
    api<{ activated: string[]; approvedAt: number; warnings: string[] }>(
      "/api/compliance/live-country",
      { method: "POST", json: { action: "activate", ...input } },
    ),
  revoke: (countries: string[]) =>
    api<{ revoked: string[]; pausedCampaigns: number[] }>("/api/compliance/live-country", {
      method: "POST",
      json: { action: "revoke", countries, ack: true },
    }),
};
