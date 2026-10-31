"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IneligibleCode } from "@/lib/compliance/eligibility";
import type { CampaignStatus, CampaignLeadStatus, SendWindow } from "@/lib/db/schema";
import type { ReviewItem } from "@/lib/mail/scheduler/review";
import type { AddLeadsResult, QueueItem } from "@/lib/campaigns/enrollment";
import type { CampaignMessageItem } from "@/lib/campaigns/messages";
import type { BlockerCode, PreflightReport } from "@/lib/campaigns/preflight";
import type { CampaignDetail, CampaignSummary, StepInput } from "@/lib/campaigns/service";
import type { CampaignAction, TransitionResult } from "@/lib/campaigns/lifecycle";
import { api } from "./api";
import { shouldRetryQuery, queryRetryDelay } from "./retry";

/**
 * Kampanya API'si istemcisi (Aşama 10 uçları). Tipler sunucu modüllerinden YALNIZCA tip olarak alınır.
 *
 * Yeniden deneme politikası (bkz. `retry.ts`): GET istekleri yalnızca 503 `DB_BUSY` için sınırlı ve artan beklemeyle
 * otomatik yenilenir. Değişiklik yapan istekler (POST/PATCH/PUT/DELETE, kampanya kontrolü) ASLA otomatik yeniden
 * gönderilmez; belirsiz sonuçta önce güncel durum sorgulanır ve kullanıcıya bildirilir.
 */

export type {
  AddLeadsResult,
  BlockerCode,
  CampaignAction,
  CampaignDetail,
  CampaignLeadStatus,
  CampaignMessageItem,
  CampaignStatus,
  CampaignSummary,
  IneligibleCode,
  PreflightReport,
  QueueItem,
  ReviewItem,
  SendWindow,
  StepInput,
  TransitionResult,
};

export interface MailboxItem {
  id: number;
  provider: string;
  label: string;
  address: string | null;
  status: string;
  dailyCap: number;
  scope: "demo" | "live";
  sendable: boolean;
}

export interface TemplateItem {
  id: number;
  name: string;
  language: string;
  kind: "initial" | "followup";
  categoryKey: string | null;
  builtIn: boolean;
  version: number;
  subject: string;
  archived: boolean;
}

export const ck = {
  all: ["campaigns"] as const,
  list: (status?: string) => ["campaigns", "list", status ?? "all"] as const,
  detail: (id: number) => ["campaigns", "detail", id] as const,
  queue: (id: number, status?: string) => ["campaigns", "queue", id, status ?? "all"] as const,
  messages: (id: number) => ["campaigns", "messages", id] as const,
  preflight: (id: number) => ["campaigns", "preflight", id] as const,
  review: ["campaigns", "review"] as const,
  mailboxes: ["mailboxes"] as const,
  templates: ["templates"] as const,
};

const getOpts = { retry: shouldRetryQuery, retryDelay: queryRetryDelay } as const;
const isActive = (s?: CampaignStatus) => s === "running";

export const useCampaigns = (status?: CampaignStatus) =>
  useQuery({
    queryKey: ck.list(status),
    queryFn: () =>
      api<{ items: CampaignSummary[] }>(`/api/campaigns${status ? `?status=${status}` : ""}`).then(
        (r) => r.items,
      ),
    refetchInterval: (q) => (q.state.data?.some((c) => isActive(c.status)) ? 5000 : false),
    ...getOpts,
  });

export const useCampaign = (id: number, enabled = true) =>
  useQuery({
    queryKey: ck.detail(id),
    queryFn: () => api<CampaignDetail>(`/api/campaigns/${id}`),
    enabled,
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 5000 : false),
    ...getOpts,
  });

export const useCampaignQueue = (id: number, status?: CampaignLeadStatus, running = false) =>
  useQuery({
    queryKey: ck.queue(id, status),
    queryFn: () =>
      api<{ items: QueueItem[]; total: number }>(
        `/api/campaigns/${id}/leads?limit=500${status ? `&status=${status}` : ""}`,
      ),
    refetchInterval: running ? 5000 : false,
    ...getOpts,
  });

export const useCampaignMessages = (id: number, running = false) =>
  useQuery({
    queryKey: ck.messages(id),
    queryFn: () =>
      api<{ items: CampaignMessageItem[] }>(`/api/campaigns/${id}/messages?limit=200`).then(
        (r) => r.items,
      ),
    refetchInterval: running ? 5000 : false,
    ...getOpts,
  });

export const usePreflight = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ck.preflight(id),
    queryFn: () => api<PreflightReport>(`/api/campaigns/${id}/preflight`),
    enabled,
    staleTime: 0,
    ...getOpts,
  });

export const useReview = () =>
  useQuery({
    queryKey: ck.review,
    queryFn: () => api<{ items: ReviewItem[] }>("/api/campaigns/review").then((r) => r.items),
    ...getOpts,
  });

export const useMailboxes = () =>
  useQuery({
    queryKey: ck.mailboxes,
    queryFn: () => api<{ items: MailboxItem[] }>("/api/mailboxes").then((r) => r.items),
    ...getOpts,
  });

export const useTemplates = () =>
  useQuery({
    queryKey: ck.templates,
    queryFn: () => api<{ items: TemplateItem[] }>("/api/templates").then((r) => r.items),
    ...getOpts,
  });

/** Kampanyayla ilgili bütün sorguları sunucudan yeniden ister (belirsiz sonuçtan sonra). */
export function useRefreshCampaigns() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ck.all });
}

/* Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. --------------- */

export const campaignApi = {
  create: (input: {
    name: string;
    mailboxId?: number | null;
    sendWindow?: SendWindow;
    dailyCap?: number;
    minGapS?: number;
    maxGapS?: number;
  }) => api<{ id: number; updatedAt: number }>("/api/campaigns", { method: "POST", json: input }),
  update: (
    id: number,
    expectedUpdatedAt: number,
    patch: {
      name?: string;
      mailboxId?: number | null;
      sendWindow?: SendWindow;
      dailyCap?: number;
      minGapS?: number;
      maxGapS?: number;
    },
  ) =>
    api<{ updatedAt: number }>(`/api/campaigns/${id}`, {
      method: "PATCH",
      json: { expectedUpdatedAt, ...patch },
    }),
  setSteps: (id: number, expectedUpdatedAt: number, steps: StepInput[]) =>
    api<{ updatedAt: number }>(`/api/campaigns/${id}/steps`, {
      method: "PUT",
      json: { expectedUpdatedAt, steps },
    }),
  addLeads: (id: number, target: { leadIds: number[] } | { filterQuery: string }) =>
    api<AddLeadsResult>(`/api/campaigns/${id}/leads`, { method: "POST", json: target }),
  removeLead: (id: number, clId: number) =>
    api<{ removed: true }>(`/api/campaigns/${id}/leads/${clId}`, { method: "DELETE" }),
  control: (id: number, action: CampaignAction, confirmToken?: string) =>
    api<TransitionResult>(`/api/campaigns/${id}/control`, {
      method: "POST",
      json: confirmToken ? { action, confirmToken } : { action },
    }),
};
