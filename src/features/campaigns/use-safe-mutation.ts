"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { ck } from "@/lib/client/campaigns";
import { classifyMutationError, type MutationErrorInfo } from "@/lib/client/retry";
import { t } from "@/lib/i18n";

/**
 * Değişiklik yapan çağrılar için ortak sarmalayıcı (kampanya, şablon, uyum).
 * - `retry: false`: hiçbir durumda otomatik yeniden gönderilmez.
 * - Belirsiz sonuç (503/ağ hatası), çakışma veya eski özet: önce ilgili sorgular sunucudan yeniden istenir,
 *   ardından kullanıcıya ne olduğu açıkça söylenir. Yeniden deneme kararı kullanıcınındır; o anki güncel veriyle
 *   (güncel `updatedAt`/`version` belirteci) yeniden kurulur.
 * - `invalidate`: kampanya sorgularına ek olarak yenilenecek anahtarlar (ör. `["templates"]`, `["compliance"]`).
 */
export function useSafeMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  opts: {
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (info: MutationErrorInfo) => void;
    successMessage?: string;
    invalidate?: readonly QueryKey[];
    /** Çakışma bildirimi (varsayılan: kampanya metni). */
    conflictMessage?: string;
  } = {},
) {
  const qc = useQueryClient();
  const refresh = async () => {
    await Promise.all(
      [ck.all as QueryKey, ...(opts.invalidate ?? [])].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
  };
  return useMutation({
    mutationFn: fn,
    retry: false,
    onSuccess: async (data, vars) => {
      await refresh();
      if (opts.successMessage) toast.success(opts.successMessage);
      opts.onSuccess?.(data, vars);
    },
    onError: async (error) => {
      const info = classifyMutationError(error);
      if (info.refresh) await refresh();
      if (info.kind === "uncertain") {
        toast.warning(t("campaign.error.uncertain"), {
          description: t("campaign.error.uncertain.body"),
          duration: 15_000,
        });
      } else if (info.kind === "conflict") {
        toast.error(opts.conflictMessage ?? t("campaign.error.conflict"));
      } else if (info.kind === "stale") {
        toast.info(t("campaign.error.stale"));
      } else if (info.kind !== "validation") {
        toast.error(info.message);
      }
      opts.onError?.(info);
    },
  });
}
