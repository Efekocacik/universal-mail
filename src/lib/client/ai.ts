"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { queryRetryDelay, shouldRetryQuery } from "./retry";

/**
 * Faz 5 paket A istemcisi: kişisel giriş (üret, listele, onayla/reddet/kaydet), Claude kullanımı ve anahtar sınaması.
 * Sunucu tipleri burada yinelenir (istemci paketi sunucu modüllerini içe aktarmaz).
 */

export type IntroLanguageId = "tr" | "en" | "de" | "fr" | "es" | "it" | "nl" | "pt" | "pl";
export const INTRO_LANGUAGES: readonly IntroLanguageId[] = [
  "tr",
  "en",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "pt",
  "pl",
];

export interface LeadIntro {
  id: number;
  leadId: number;
  language: IntroLanguageId;
  text: string;
  status: "draft" | "approved" | "rejected";
  model: "claude-opus-5-5" | "claude-haiku-5-5" | "demo";
  sourceDomain: string | null;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  createdAt: number;
  approvedAt: number | null;
}

export interface AiUsageResponse {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estUsd: number;
}

export const aiKeys = {
  intros: (leadId: number) => ["ai", "intros", leadId] as const,
  usage: ["ai", "usage"] as const,
};

export function useLeadIntros(leadId: number, enabled = true) {
  return useQuery({
    queryKey: aiKeys.intros(leadId),
    queryFn: () => api<{ intros: LeadIntro[] }>(`/api/leads/${leadId}/intro`).then((r) => r.intros),
    enabled,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
}

export function useAiUsage(enabled = true) {
  return useQuery({
    queryKey: aiKeys.usage,
    queryFn: () => api<AiUsageResponse>("/api/ai/usage"),
    enabled,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });
}

export function useGenerateIntro(leadId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (language: IntroLanguageId) =>
      api<{ intro: LeadIntro }>(`/api/leads/${leadId}/intro`, {
        method: "POST",
        json: { language },
      }).then((r) => r.intro),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: aiKeys.intros(leadId) });
      void qc.invalidateQueries({ queryKey: aiKeys.usage });
    },
  });
}

export function useIntroAction(leadId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { introId: number; action: "approve" | "reject" | "save"; text?: string }) =>
      api<{ intro: LeadIntro }>(`/api/leads/${leadId}/intro/${v.introId}`, {
        method: "PATCH",
        json: v.text === undefined ? { action: v.action } : { action: v.action, text: v.text },
      }).then((r) => r.intro),
    onSuccess: () => void qc.invalidateQueries({ queryKey: aiKeys.intros(leadId) }),
  });
}

/**
 * Bir dil için gösterilecek giriş: onaylı varsa o, yoksa en yeni taslak; ikisi de yoksa en yeni reddedilen
 * (kullanıcı neyi reddettiğini görür ve yeniden oluşturabilir). Liste yeniden eskiye sıralıdır.
 */
export function currentIntro(
  intros: readonly LeadIntro[],
  language: IntroLanguageId,
): LeadIntro | null {
  const forLang = intros.filter((i) => i.language === language);
  return (
    forLang.find((i) => i.status === "approved") ??
    forLang.find((i) => i.status === "draft") ??
    forLang[0] ??
    null
  );
}
