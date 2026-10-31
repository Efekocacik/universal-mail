"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ck } from "@/lib/client/campaigns";
import { classifyMutationError, type MutationErrorInfo } from "@/lib/client/retry";
import { t } from "@/lib/i18n";

/**
 * Değişiklik yapan kampanya çağrıları için ortak sarmalayıcı.
 * - `retry: false`: hiçbir durumda otomatik yeniden gönderilmez.
 * - Belirsiz sonuç (503/ağ hatası), çakışma veya eski özet: önce bütün kampanya sorguları sunucudan yeniden istenir,
 *   ardından kullanıcıya ne olduğu açıkça söylenir. Yeniden deneme kararı kullanıcınındır; o anki güncel veriyle
 *   (güncel `updatedAt` belirteci) yeniden kurulur.
 */
export function useSafeMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  opts: {
    onSuccess?: (data: TData, vars: TVars) => void;
    onError?: (info: MutationErrorInfo) => void;
    successMessage?: string;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    retry: false,
    onSuccess: async (data, vars) => {
      await qc.invalidateQueries({ queryKey: ck.all });
      if (opts.successMessage) toast.success(opts.successMessage);
      opts.onSuccess?.(data, vars);
    },
    onError: async (error) => {
      const info = classifyMutationError(error);
      if (info.refresh) await qc.invalidateQueries({ queryKey: ck.all });
      if (info.kind === "uncertain") {
        toast.warning(t("campaign.error.uncertain"), {
          description: t("campaign.error.uncertain.body"),
          duration: 15_000,
        });
      } else if (info.kind === "conflict") {
        toast.error(t("campaign.error.conflict"));
      } else if (info.kind === "stale") {
        toast.info(t("campaign.error.stale"));
      } else if (info.kind !== "validation") {
        toast.error(info.message);
      }
      opts.onError?.(info);
    },
  });
}
