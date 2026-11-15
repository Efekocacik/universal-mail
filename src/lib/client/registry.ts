"use client";

import { useEffect, useRef } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { getLocale, intlLocale, t, type Locale, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";
import type { CompanyStats, RegistryCompanyDto, RegistryRunDto } from "@/lib/registry/service";
import type { RegistrySource } from "@/lib/registry/types";
import { api, toSearchParams } from "./api";
import { fmtNumber } from "./format";

/**
 * Resmî sicil istemcisi (paket R).
 *  GET  /api/registry/runs?limit=                → { runs, matchActive }
 *  POST /api/registry/runs {source, locality?, codes?, windowDays?} → 202 { run, jobId }
 *  GET  /api/registry/companies?match=&runId=&leadId=&q=&cursor=&limit= → { items, nextCursor, stats }
 *  POST /api/registry/match {runId?}            → 202 { jobId }
 *  POST /api/registry/companies/:id/lead {}     → 201 { leadId }
 *  POST /api/registry/test {source}             → { ok, demo }
 * Google adları bu yanıtlarda YOKTUR; eşleşen işletmenin adı lead ayrıntısından (oturum önbelleği) gösterilir.
 */
export type { CompanyStats, RegistryCompanyDto, RegistryRunDto, RegistrySource };

export const REGISTRY_SOURCES: readonly RegistrySource[] = ["companies_house", "insee"];

const KEY = ["registry"] as const;
export const registryKeys = {
  all: KEY,
  runs: [...KEY, "runs"] as const,
  companies: (params: Record<string, unknown>) => [...KEY, "companies", params] as const,
  lead: (leadId: number) => [...KEY, "lead", leadId] as const,
};

/* ------------------------------------------------ saf yardımcılar (sınanır) -------------------------------- */

/** Çalışma hâlâ sürüyor mu (yoklama için)? */
export const isRunActive = (r: Pick<RegistryRunDto, "status">) =>
  r.status === "queued" || r.status === "running";

/** Eşleşme oranı 0..1 → "%40" / "40%" (etkin dil). Kayıt yoksa null. */
export function formatRate(rate: number | null, locale: Locale = getLocale()): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}

/** Çalışmanın eşleşme oranı: eşleşen / (eşleşen + eşleşmeyen + bekleyen); sayaç yoksa null. */
export function runMatchRate(
  r: Pick<RegistryRunDto, "matchedCount" | "unmatchedCount" | "pendingCount">,
): number | null {
  const total = r.matchedCount + r.unmatchedCount + r.pendingCount;
  return total > 0 ? r.matchedCount / total : null;
}

const hasKey = (k: string): k is TrKey => Object.prototype.hasOwnProperty.call(tr, k);

/** Eşleşme nedeni → kullanıcı metni (bilinmeyen neden boş). */
export function reasonText(reason: string | null): string {
  if (!reason) return "";
  const key = `registry.reason.${reason}`;
  return hasKey(key) ? t(key) : "";
}

/** Çalışma hata kodu → kullanıcı metni (bilinmeyen kod → genel ulaşılamadı metni). */
export function runErrorText(code: string | null): string | null {
  if (!code) return null;
  const key = `registry.error.${code}`;
  return hasKey(key) ? t(key) : t("registry.error.REGISTRY_UPSTREAM");
}

/** Faaliyet kodu etiketi (bilinmeyen kod olduğu gibi). */
export function codeLabel(code: string): string {
  const key = `registry.code.${code}`;
  return hasKey(key) ? t(key) : code;
}

export type RunTone = "success" | "danger" | "info";
export const runTone = (s: RegistryRunDto["status"]): RunTone =>
  s === "done" ? "success" : s === "failed" ? "danger" : "info";

/** Çalışma satırının özet metinleri (saf). */
export function runSummary(r: RegistryRunDto): {
  status: string;
  window: string;
  counts: string;
  rate: string | null;
  error: string | null;
} {
  const rate = formatRate(runMatchRate(r));
  return {
    status: t(`registry.status.${r.status}`),
    window: t("registry.runs.window", { from: r.windowFrom, to: r.windowTo }),
    counts: t("registry.runs.counts", {
      fetched: fmtNumber(r.fetchedCount),
      new: fmtNumber(r.newCount),
    }),
    rate: r.status === "done" && rate ? t("registry.runs.rate", { rate }) : null,
    error: r.status === "failed" ? runErrorText(r.errorCode) : null,
  };
}

/** Kayıt satırının görünen adı: tabela adı (varsa) + hukuki ad. */
export function companyTitle(c: Pick<RegistryCompanyDto, "name" | "tradingName">): {
  primary: string;
  secondary: string | null;
} {
  return c.tradingName && c.tradingName !== c.name
    ? { primary: c.tradingName, secondary: c.name }
    : { primary: c.name, secondary: null };
}

/**
 * Çalışma listesinin "durum imzası": bir çalışmanın durumu/sayaçları veya eşleştirme etkinliği değişince değişir.
 * Kayıt listeleri yalnızca iş sürerken yoklanır; demo çekme + eşleştirme ilk yoklamadan önce bitebilir, bu yüzden imza
 * her değiştiğinde (özellikle etkin → boşta geçişinde) kayıt listeleri ve lead rozetleri yenilenir.
 */
export function runsSignature(
  data: { runs: RegistryRunDto[]; matchActive: boolean } | undefined,
): string | null {
  if (!data) return null;
  return [
    data.matchActive ? "m" : "-",
    ...data.runs.map(
      (r) =>
        `${r.id}:${r.status}:${r.fetchedCount}:${r.matchedCount}:${r.unmatchedCount}:${r.pendingCount}`,
    ),
  ].join("|");
}

/** Lead rozeti: lead bu kayıttan OLUŞTURULDUYSA veya lead'in yeri bu kayıtla eşleştiyse o kayıt (yoksa null). */
export function pickLeadRegistryCompany(
  items: readonly RegistryCompanyDto[] | undefined,
  leadId: number,
): RegistryCompanyDto | null {
  return (
    items?.find(
      (c) => c.leadId === leadId || c.matchStatus === "matched" || c.matchStatus === "manual",
    ) ?? null
  );
}

/* ------------------------------------------------ sorgular ------------------------------------------------- */

export function useRegistryRuns() {
  return useQuery({
    queryKey: registryKeys.runs,
    queryFn: () => api<{ runs: RegistryRunDto[]; matchActive: boolean }>("/api/registry/runs"),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.matchActive || q.state.data.runs.some(isRunActive))
        ? 1500
        : false,
  });
}

/** Çalışma imzası değişince (ilk yüklemede değil) kayıt listelerini ve lead rozetlerini yeniler. */
export function useRegistryAutoRefresh(
  data: { runs: RegistryRunDto[]; matchActive: boolean } | undefined,
) {
  const qc = useQueryClient();
  const sig = runsSignature(data);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (sig === null) return;
    const before = prev.current;
    prev.current = sig;
    if (before === null || before === sig) return;
    void qc.invalidateQueries({ queryKey: [...KEY, "companies"] });
    void qc.invalidateQueries({ queryKey: [...KEY, "lead"] });
  }, [sig, qc]);
}

export interface CompanyPage {
  items: RegistryCompanyDto[];
  nextCursor: string | null;
  stats: CompanyStats;
}

export function useRegistryCompanies(
  params: { match: "matched" | "open"; q?: string },
  poll: boolean,
) {
  const query = {
    match: params.match === "matched" ? "matched" : "unmatched,pending",
    q: params.q?.trim() || undefined,
    limit: 50,
  };
  return useInfiniteQuery({
    queryKey: registryKeys.companies(query),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<CompanyPage>(
        `/api/registry/companies?${toSearchParams({ ...query, cursor: pageParam ?? undefined })}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: poll ? 2000 : false,
  });
}

/**
 * Lead ayrıntısı rozeti: bu lead'e bağlı sicil kayıtları. Sunucu `leadId` süzgeci "lead bu kayıttan oluşturuldu VEYA
 * lead'in yeri bu kayıtla eşleşti" demektir; eşleşme durumu süzülmez (sicilden oluşturulan kayıt `pending` kalır).
 * Rozetin göstereceği kayıt `pickLeadRegistryCompany` ile seçilir.
 */
export function useLeadRegistry(leadId: number) {
  return useQuery({
    queryKey: registryKeys.lead(leadId),
    queryFn: () => api<CompanyPage>(`/api/registry/companies?leadId=${leadId}&limit=5`),
    staleTime: 30_000,
  });
}

function invalidate(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: registryKeys.all });
}

export function useCreateRegistryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      source: RegistrySource;
      locality?: string;
      codes: string[];
      windowDays: number;
    }) =>
      api<{ run: RegistryRunDto; jobId: number }>("/api/registry/runs", {
        method: "POST",
        json: input,
      }),
    onSuccess: () => invalidate(qc),
  });
}

export function useRematch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ jobId: number }>("/api/registry/match", { method: "POST", json: {} }),
    onSuccess: () => invalidate(qc),
  });
}

export function usePromoteToLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (companyId: number) =>
      api<{ leadId: number }>(`/api/registry/companies/${companyId}/lead`, {
        method: "POST",
        json: {},
      }),
    onSuccess: () => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["facets"] });
    },
  });
}

export function useTestRegistry() {
  return useMutation({
    mutationFn: (source: RegistrySource) =>
      api<{ ok: true; demo: boolean }>("/api/registry/test", { method: "POST", json: { source } }),
  });
}
