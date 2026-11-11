"use client";

import { useQuery } from "@tanstack/react-query";
import type { ContentIssue } from "@/lib/mail/content-check";
import type { ComposeIssue, TemplateDetail, TemplateListItem } from "@/lib/mail/template-service";
import type { TemplateIssue } from "@/lib/mail/template-engine";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/**
 * Şablon API'si istemcisi (Aşama 12). Tipler sunucu modüllerinden YALNIZCA tip olarak alınır.
 * Okumalar yalnızca 503 `DB_BUSY` için sınırlı ve artan beklemeyle yenilenir; değişiklikler asla otomatik tekrarlanmaz.
 */

export type { ComposeIssue, ContentIssue, TemplateDetail, TemplateIssue, TemplateListItem };

export interface TemplateDraftInput {
  name: string;
  language: string;
  kind: "initial" | "followup";
  categoryKey?: string | null;
  subject: string;
  bodyHtml: string;
}

export type PreviewResponse =
  | { ok: false; errors: TemplateIssue[]; warnings: TemplateIssue[] }
  | {
      ok: true;
      subject: string;
      html: string;
      text: string;
      language: string | null;
      missing: string[];
      variables: string[];
      errors: ComposeIssue[];
      warnings: (TemplateIssue | ContentIssue)[];
    };

export const tk = {
  all: ["templates"] as const,
  list: (archived: boolean) => ["templates", "list", archived] as const,
  detail: (id: number) => ["templates", "detail", id] as const,
};

const getOpts = { retry: shouldRetryQuery, retryDelay: queryRetryDelay } as const;

export const useTemplateList = (includeArchived = false) =>
  useQuery({
    queryKey: tk.list(includeArchived),
    queryFn: () =>
      api<{ items: TemplateListItem[] }>(
        `/api/templates${includeArchived ? "?archived=1" : ""}`,
      ).then((r) => r.items),
    ...getOpts,
  });

export const useTemplateDetail = (id: number, enabled = true) =>
  useQuery({
    queryKey: tk.detail(id),
    queryFn: () => api<TemplateDetail>(`/api/templates/${id}`),
    enabled,
    ...getOpts,
  });

/** Değişiklik yapan çağrılar: tek deneme; yeniden deneme kararı kullanıcıya aittir. */
export const templateApi = {
  create: (draft: TemplateDraftInput) =>
    api<{ id: number; version: number }>("/api/templates", { method: "POST", json: draft }),
  update: (id: number, expectedVersion: number, patch: Partial<TemplateDraftInput>) =>
    api<{ version: number }>(`/api/templates/${id}`, {
      method: "PATCH",
      json: { expectedVersion, ...patch },
    }),
  archive: (id: number, expectedVersion: number) =>
    api<{ ok: true }>(`/api/templates/${id}/archive`, {
      method: "POST",
      json: { expectedVersion },
    }),
  duplicate: (id: number) =>
    api<{ id: number; version: number }>(`/api/templates/${id}/duplicate`, {
      method: "POST",
      json: {},
    }),
  /** Ön izleme yazma yapmaz; bu yüzden okuma gibi (kullanıcı tetiklemeli) çağrılır. */
  preview: (draft: TemplateDraftInput, leadId: number, signal?: AbortSignal) =>
    api<PreviewResponse>("/api/templates/preview", {
      method: "POST",
      json: { draft, leadId },
      signal,
    }),
};
