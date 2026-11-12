"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/** Posta kutusu yapılandırması istemcisi (Aşama 15.2). Sır ve tam istemci kimliği yanıtlarda ASLA yer almaz. */

export interface GmailClientStatus {
  clientIdConfigured: boolean;
  clientIdPreview: string | null;
  secretConfigured: boolean;
}

export interface OAuthStatus {
  connected: boolean;
  send: boolean;
  read: boolean;
  reauthorizationRequired: boolean;
}

export const mbk = {
  gmailClient: ["mailboxes", "gmail-client"] as const,
  oauth: (id: number) => ["mailboxes", "oauth", id] as const,
};

export const useOAuthStatus = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: mbk.oauth(id),
    enabled,
    queryFn: () => api<OAuthStatus>(`/api/mailboxes/${id}/oauth`),
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

export const useGmailClient = () =>
  useQuery({
    queryKey: mbk.gmailClient,
    queryFn: () => api<GmailClientStatus>("/api/mailboxes/gmail-client"),
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

/** Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. */
export const mailboxApi = {
  create: (input: { label: string; address: string }) =>
    api<{ id: number }>("/api/mailboxes", { method: "POST", json: input }),
  update: (id: number, patch: { label?: string; status?: "not_configured" | "disabled" }) =>
    api<{ ok: true }>(`/api/mailboxes/${id}`, { method: "PATCH", json: patch }),
  updateLimits: (
    id: number,
    patch: {
      dailyCap?: number;
      warmupStep?: number;
      expected: { dailyCap: number; warmupStep: number };
    },
  ) =>
    api<{
      id: number;
      dailyCap: number;
      warmupStep: number;
      todayCap: number;
      warmupRebased: boolean;
      updatedAt: number;
    }>(`/api/mailboxes/${id}/limits`, { method: "PATCH", json: patch }),
  remove: (id: number) => api<{ ok: true }>(`/api/mailboxes/${id}`, { method: "DELETE" }),
  setClient: (input: { clientId: string; clientSecret?: string }) =>
    api<GmailClientStatus>("/api/mailboxes/gmail-client", { method: "PUT", json: input }),
  oauthStart: (id: number, level: "send" | "send_read") =>
    api<{ authUrl: string; expiresAt: number }>(`/api/mailboxes/${id}/oauth/start`, {
      method: "POST",
      json: { level },
    }),
  oauthDisconnect: (id: number) =>
    api<{ revoked: boolean }>(`/api/mailboxes/${id}/oauth/disconnect`, {
      method: "POST",
      json: { confirm: true },
    }),
  clearClient: () => api<GmailClientStatus>("/api/mailboxes/gmail-client", { method: "DELETE" }),
};
