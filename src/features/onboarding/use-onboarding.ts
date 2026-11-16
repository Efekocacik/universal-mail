"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { queryRetryDelay, shouldRetryQuery } from "@/lib/client/retry";
import type { OnboardingChecklist } from "@/lib/onboarding/checklist";

export type { OnboardingChecklist, OnboardingItem } from "@/lib/onboarding/checklist";

export const ONBOARDING_QUERY_KEY = ["onboarding"] as const;
/** Kart pencereye dönüldüğünde ve dakikada bir tazelenir (adımlar başka ekranlarda tamamlanır). */
export const ONBOARDING_REFRESH_MS = 60_000;

export const useOnboarding = () =>
  useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api<OnboardingChecklist>("/api/onboarding"),
    refetchInterval: ONBOARDING_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: shouldRetryQuery,
    retryDelay: queryRetryDelay,
  });

/** Gizle / yeniden göster. Sunucu yanıtı (`dismissedAt`) önbelleğe hemen yazılır; ardından liste tazelenir. */
export function useOnboardingVisibility() {
  const qc = useQueryClient();
  const apply = (dismissedAt: number | null) => {
    qc.setQueryData<OnboardingChecklist>(ONBOARDING_QUERY_KEY, (old) =>
      old ? { ...old, dismissedAt } : old,
    );
    void qc.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
  };
  const dismiss = useMutation({
    mutationFn: () =>
      api<{ dismissedAt: number }>("/api/onboarding/dismiss", { method: "POST", json: {} }),
    onSuccess: (r) => apply(r.dismissedAt),
  });
  const restore = useMutation({
    mutationFn: () =>
      api<{ dismissedAt: null }>("/api/onboarding/restore", { method: "POST", json: {} }),
    onSuccess: () => apply(null),
  });
  return { dismiss, restore };
}
