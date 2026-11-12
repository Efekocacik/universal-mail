"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { api, ApiError } from "./api";
import { fmtNumber } from "./format";
import type { AddLeadsByFilterResult, AddLeadsResult } from "@/lib/campaigns/enrollment";
import type { BulkAction, BulkResult } from "@/lib/leads/bulk";

/**
 * Toplu işlemler istemcisi (keşif ekranındaki seçim çubuğu). Tipler sunucu modülünden YALNIZCA tip olarak alınır.
 * Değişiklik yapan çağrılar tek denemedir; sunucu tarafı idempotent olduğundan kullanıcı güvenle yeniden deneyebilir.
 */
export type { BulkAction, BulkResult };
export type SelectionTarget = { leadIds: number[] } | { filterQuery: string };

/** Sunucudaki `MAX_ADD_BATCH` ile aynı: kampanyaya kimlikle eklemede tek istek. */
export const CAMPAIGN_ADD_CHUNK = 500;

export const leadsBulkApi = {
  run: (action: BulkAction, selection: SelectionTarget, dryRun = false) =>
    api<BulkResult>("/api/leads/bulk", {
      method: "POST",
      json: { action, selection, ...(dryRun ? { dryRun: true } : {}) },
    }),
};

/** Lead görünümlerini (liste, nokta, sayım, ayrıntı) tazeler. */
export function invalidateLeadViews(qc: ReturnType<typeof useQueryClient>): void {
  for (const key of ["lead", "leads", "points", "facets"])
    void qc.invalidateQueries({ queryKey: [key] });
}

export function useBulkAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { action: BulkAction; selection: SelectionTarget }) =>
      leadsBulkApi.run(v.action, v.selection),
    onSuccess: () => invalidateLeadViews(qc),
  });
}

/**
 * Seçimi CSV olarak indirir (POST /api/export/leads). 2000 kimlik adrese sığmadığı için gövdeyle gönderilir; yanıt
 * tarayıcıda dosyaya çevrilir. Dosya adı sunucunun `Content-Disposition` başlığından alınır.
 */
export async function downloadSelectionCsv(
  selection: SelectionTarget,
  google: boolean,
): Promise<void> {
  const res = await fetch("/api/export/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection, google }),
    cache: "no-store",
  });
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* gövde yok */
    }
    throw new ApiError(
      typeof body.error === "string" ? body.error : `İstek başarısız (${res.status}).`,
      res.status,
    );
  }
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "leadler.csv";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Kimlikleri `size`'lık parçalara böler (saf; sınanır). */
export function chunkIds(ids: readonly number[], size = CAMPAIGN_ADD_CHUNK): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Parça sonuçlarını tek sonuçta birleştirir (saf; sınanır). */
export function mergeAddResults(parts: readonly AddLeadsResult[]): AddLeadsResult {
  return {
    added: parts.reduce((n, p) => n + p.added, 0),
    excluded: parts.flatMap((p) => p.excluded),
    duplicates: parts.flatMap((p) => p.duplicates),
    reevaluated: parts.reduce((n, p) => n + p.reevaluated, 0),
    updatedAt: Math.max(0, ...parts.map((p) => p.updatedAt)),
  };
}

/** Kimlikle kampanyaya ekleme sonucu: bir parça başarısız olduysa o ana kadarki sonuç ve hata. */
export type AddIdsResult = AddLeadsByFilterResult & {
  /** Başarısız parçanın hata iletisi; tüm parçalar eklendiyse null. */
  error: string | null;
};

/**
 * Seçili kimlikleri kampanyaya 500'lük parçalarla ekler. Bir parça başarısız olursa DURUR ve o ana kadar eklenenleri
 * hatayla birlikte döndürür (`error`, `remaining`: denenmeyen kimlik sayısı). Hiçbir parça eklenemediyse hata fırlatılır.
 * Ekleme sunucuda idempotenttir (tekrar eklenenler `duplicates` olur); kullanıcı aynı seçimle güvenle yeniden dener.
 */
export async function addIdsToCampaign(
  campaignId: number,
  ids: readonly number[],
  onProgress?: (done: number, total: number) => void,
  post: (part: number[]) => Promise<AddLeadsResult> = (part) =>
    api<AddLeadsResult>(`/api/campaigns/${campaignId}/leads`, {
      method: "POST",
      json: { leadIds: part },
    }),
): Promise<AddIdsResult> {
  const parts: AddLeadsResult[] = [];
  let done = 0;
  let error: string | null = null;
  onProgress?.(0, ids.length);
  for (const part of chunkIds(ids)) {
    try {
      parts.push(await post(part));
    } catch (e) {
      if (parts.length === 0) throw e;
      error = (e as Error).message || t("common.error");
      break;
    }
    done += part.length;
    onProgress?.(done, ids.length);
  }
  return {
    ...mergeAddResults(parts),
    matched: ids.length,
    taken: done,
    remaining: ids.length - done,
    error,
  };
}

/** Toplu işlem sonucu bildirimi (saf; sınanır): kaç işletme değişti, kaçı atlandı. */
export function bulkResultMessage(r: Pick<BulkResult, "action" | "changed" | "skipped">): {
  done: string;
  skipped: string | null;
} {
  const skipped = r.skipped.unchanged + r.skipped.activeCampaign + r.skipped.notFound;
  return {
    done: t(`bulk.done.${r.action}`, { n: fmtNumber(r.changed) }),
    skipped: skipped > 0 ? t("bulk.done.skipped", { n: fmtNumber(skipped) }) : null,
  };
}
