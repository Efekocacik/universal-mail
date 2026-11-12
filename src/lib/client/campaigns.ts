"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IneligibleCode } from "@/lib/compliance/eligibility";
import type { CampaignStatus, CampaignLeadStatus, SendWindow } from "@/lib/db/schema";
import type { ReviewItem } from "@/lib/mail/scheduler/review";
import type {
  ResolveReviewResult,
  UncertainSendDecision,
} from "@/lib/mail/scheduler/resolve-review";
import type { TemplateListItem } from "@/lib/mail/template-service";
import type { AddLeadsResult, QueueItem } from "@/lib/campaigns/enrollment";
import type { CampaignMessageItem } from "@/lib/campaigns/messages";
import type {
  BlockerCode,
  PreflightPreview,
  PreflightReport,
  PreflightStepPreview,
} from "@/lib/campaigns/preflight";
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
  PreflightPreview,
  PreflightReport,
  PreflightStepPreview,
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
  /** Demo olmayan ve bağlı olmayan kutular ad/durum değişikliğine ve silmeye açıktır. */
  editable?: boolean;
  /** Kişisel Gmail adresi (`@gmail.com`/`@googlemail.com`). */
  consumerGmail?: boolean;
  /** Google yetkisi geçersiz/iptal: kutu yeniden bağlanana kadar gönderim ertelenir. */
  reauthorizationRequired?: boolean;
  /** Bugünkü geçerli günlük tavan, ısınma tabanı ve günlük üst sınır. */
  limits?: {
    todayCap: number;
    warmupBase: number;
    maxDaily: number;
    /** Günlük sınır penceresinin üst sınırları (kişisel Gmail 50/5, diğerleri 80/10). */
    profileMaxDaily?: number;
    maxWarmupStep?: number;
  };
  warmupStep?: number;
  warmupStartedAt?: number | null;
  updatedAt?: number;
  /** Günlük sınır penceresi açılabilir mi (demo dışındaki her kutu). */
  limitsEditable?: boolean;
}

/** Şablon listesi öğesi (gövde yok); `lockedBy` > 0 ise içerik değiştirilemez. */
export type TemplateItem = TemplateListItem;

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

/** Kampanya listesi sayfası (`updatedAt` azalan; `nextOffset` sonraki sayfa). */
export interface CampaignListPage {
  items: CampaignSummary[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

const campaignListUrl = (status: CampaignStatus | undefined, limit: number, offset: number) => {
  const sp = new URLSearchParams({ limit: String(limit) });
  if (status) sp.set("status", status);
  if (offset > 0) sp.set("offset", String(offset));
  return `/api/campaigns?${sp}`;
};

/** Sunucu süzgeçli kampanya listesi (tek sayfa, en çok 200); ör. kampanya seçici `draft`/`ready` için ayrı çağırır. */
export const useCampaigns = (status?: CampaignStatus, limit = 200) =>
  useQuery({
    queryKey: [...ck.list(status), limit] as const,
    queryFn: () => api<CampaignListPage>(campaignListUrl(status, limit, 0)).then((r) => r.items),
    refetchInterval: (q) => (q.state.data?.some((c) => isActive(c.status)) ? 5000 : false),
    ...getOpts,
  });

/** Kampanyalar ekranı: sayfalı liste ("Daha fazla yükle"). */
export const useCampaignList = (status?: CampaignStatus) =>
  useInfiniteQuery({
    queryKey: [...ck.list(status), "pages"] as const,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<CampaignListPage>(campaignListUrl(status, 50, pageParam)),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((c) => isActive(c.status))) ? 5000 : false,
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

/** Kuyruk sayfası (kimliğe göre artan; `nextAfterId` sonraki sayfanın imleci). */
export interface QueuePage {
  items: QueueItem[];
  total: number;
  nextAfterId: number | null;
}

export const QUEUE_PAGE_SIZE = 200;

export const useCampaignQueue = (id: number, status?: CampaignLeadStatus, running = false) =>
  useInfiniteQuery({
    queryKey: ck.queue(id, status),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: String(QUEUE_PAGE_SIZE) });
      if (status) sp.set("status", status);
      if (pageParam > 0) sp.set("afterId", String(pageParam));
      return api<QueuePage>(`/api/campaigns/${id}/leads?${sp}`);
    },
    getNextPageParam: (last) => last.nextAfterId ?? undefined,
    refetchInterval: running ? 5000 : false,
    ...getOpts,
  });

/** Gönderim günlüğü sayfası (kimliğe göre azalan; `nextBeforeId` daha eski sayfanın imleci). */
export interface CampaignMessagesPage {
  items: CampaignMessageItem[];
  nextBeforeId: number | null;
}

export const useCampaignMessages = (id: number, running = false) =>
  useInfiniteQuery({
    queryKey: ck.messages(id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: "100" });
      if (pageParam > 0) sp.set("beforeId", String(pageParam));
      return api<CampaignMessagesPage>(`/api/campaigns/${id}/messages?${sp}`);
    },
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
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
  removeLead: (id: number, clId: number) =>
    api<{ removed: true }>(`/api/campaigns/${id}/leads/${clId}`, { method: "DELETE" }),
  control: (id: number, action: CampaignAction, confirmToken?: string) =>
    api<TransitionResult>(`/api/campaigns/${id}/control`, {
      method: "POST",
      json: confirmToken ? { action, confirmToken } : { action },
    }),
};

/* Sonucu belirsiz gönderimin kararı (C7): tek deneme; hiçbir şey göndermez. -------------------------- */

export type { ResolveReviewResult, UncertainSendDecision };

export const reviewApi = {
  /** `mark_not_sent` açık onay ister (`confirm: true`); yanlış kararda aynı kişiye ikinci e-posta gider. */
  resolve: (messageId: number, decision: UncertainSendDecision, opts: { confirm?: boolean } = {}) =>
    api<ResolveReviewResult>(`/api/campaigns/review/${messageId}`, {
      method: "POST",
      json: opts.confirm ? { decision, confirm: true } : { decision },
    }),
};
