"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { MailLogItem } from "@/lib/mail/mail-log";
import type { AuditItem } from "@/lib/audit-list";
import type { ReviewItem } from "@/lib/mail/inbound/review-list";
import type { DnsReport } from "@/lib/mail/dns-check";
import type { MailboxHealthView } from "@/lib/mail/mailbox-health";
import type { LiveReadiness } from "@/lib/compliance/live-readiness";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/** Gönderim günlüğü, inceleme kuyruğu, işlem kaydı ve gönderim sağlığı istemcisi (Aşama 13). */

export type { AuditItem, DnsReport, LiveReadiness, MailLogItem, MailboxHealthView, ReviewItem };

export interface AutoStopResponse {
  config: { minRecipients: number; minBounces: number; minRateBp: number };
  defaults: { minRecipients: number; minBounces: number; minRateBp: number };
  floors: { minRecipients: number; minBounces: number; minRateBp: number };
}

export interface MailLogFilter {
  direction?: "out" | "in";
}

export const mk = {
  all: ["mail-ops"] as const,
  log: (f: MailLogFilter) => ["mail-ops", "log", f] as const,
  review: ["mail-ops", "review"] as const,
  audit: (prefix: string) => ["mail-ops", "audit", prefix] as const,
  autoStop: ["mail-ops", "auto-stop"] as const,
  health: (id: number) => ["mail-ops", "health", id] as const,
  readiness: ["mail-ops", "readiness"] as const,
};

const getOpts = { retry: shouldRetryQuery, retryDelay: queryRetryDelay } as const;

export function mailLogExportUrl(f: MailLogFilter): string {
  const sp = new URLSearchParams();
  if (f.direction) sp.set("direction", f.direction);
  const q = sp.toString();
  return `/api/mail-log/export${q ? `?${q}` : ""}`;
}

export function auditExportUrl(prefix: string): string {
  return `/api/audit/export${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`;
}

export const useMailLog = (f: MailLogFilter) =>
  useInfiniteQuery({
    queryKey: mk.log(f),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: "50" });
      if (f.direction) sp.set("direction", f.direction);
      if (pageParam) sp.set("beforeId", String(pageParam));
      return api<{ items: MailLogItem[]; nextBeforeId: number | null }>(`/api/mail-log?${sp}`);
    },
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    ...getOpts,
  });

export const useAudit = (prefix: string) =>
  useInfiniteQuery({
    queryKey: mk.audit(prefix),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: "50" });
      if (prefix) sp.set("prefix", prefix);
      if (pageParam) sp.set("beforeId", String(pageParam));
      return api<{ items: AuditItem[]; nextBeforeId: number | null }>(`/api/audit?${sp}`);
    },
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    ...getOpts,
  });

export const useReviewQueue = () =>
  useQuery({
    queryKey: mk.review,
    queryFn: () => api<{ items: ReviewItem[] }>("/api/inbox/review").then((r) => r.items),
    ...getOpts,
  });

export const useMailboxHealth = (mailboxId: number | undefined) =>
  useQuery({
    queryKey: mk.health(mailboxId ?? 0),
    enabled: mailboxId !== undefined,
    queryFn: () => api<MailboxHealthView>(`/api/mailboxes/${mailboxId}/health`),
    ...getOpts,
  });

export const useLiveReadiness = () =>
  useQuery({
    queryKey: mk.readiness,
    queryFn: () => api<LiveReadiness>("/api/compliance/live-readiness"),
    ...getOpts,
  });

export const useAutoStop = () =>
  useQuery({
    queryKey: mk.autoStop,
    queryFn: () => api<AutoStopResponse>("/api/compliance/auto-stop"),
    ...getOpts,
  });

/** Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. */
export const mailOpsApi = {
  resolveReview: (id: number, decision: "apply" | "ignore") =>
    api<{ status: string; suppressed: boolean }>(`/api/inbox/review/${id}`, {
      method: "POST",
      json: { decision },
    }),
  tightenAutoStop: (input: { minRecipients?: number; minRateBp?: number }) =>
    api<{ config: AutoStopResponse["config"] }>("/api/compliance/auto-stop", {
      method: "PATCH",
      json: input,
    }),
  reenableMailbox: (mailboxId: number, justification: string) =>
    api<{ ok: true }>(`/api/mailboxes/${mailboxId}/health/reenable`, {
      method: "POST",
      json: { confirm: true, justification },
    }),
  tightenMailboxLimits: (input: {
    bounceBp?: number;
    minRecipients?: number;
    guardBounces?: number;
  }) =>
    api<{ limits: MailboxHealthView["limits"] }>("/api/compliance/mailbox-limits", {
      method: "PATCH",
      json: input,
    }),
  dnsCheck: (mailboxId: number, input: { selector?: string }) =>
    api<DnsReport>(`/api/mailboxes/${mailboxId}/dns-check`, { method: "POST", json: input }),
  testSend: (mailboxId: number, input: { templateId: number; leadId: number }) =>
    api<{
      outcome: "sent" | "failed" | "unknown";
      messageRowId: number;
      scope: "demo" | "live";
      listUnsubscribe: boolean;
      code?: string;
      /** Sonuç sağlayıcıdan alındı ama kaydı yazılamadı (uzlaştırılacak); yeniden göndermeyin. */
      recordError?: boolean;
    }>(`/api/mailboxes/${mailboxId}/test-send`, { method: "POST", json: input }),
};
