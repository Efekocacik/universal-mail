"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupSchedule } from "@/lib/backup/service";
import type { BackupRow, BackupSummary, LifecyclePending } from "@/lib/backup/shared";
import { api } from "@/lib/client/api";
import { intlLocale, t } from "@/lib/i18n";
import type { LifecycleResult } from "@/lib/lifecycle/pending";

/**
 * Faz 6 (paket Y.8): Ayarlar → Yedekler bölümünün veri katmanı (uç yanıt türleri, sorgu anahtarları, ortak biçimleme).
 * Türler sunucu modüllerinden YALNIZCA tür olarak alınır (istemci paketine Node modülü girmez).
 */

export const BACKUPS_QK = ["backups"] as const;
export const RETENTION_QK = ["data-retention"] as const;

/** `GET /api/backups`. */
export interface BackupOverview {
  backups: BackupRow[];
  schedule: BackupSchedule;
  folder: string;
  folderIsDefault: boolean;
  defaultFolder: string;
  passphraseSet: boolean;
  preMigrateCount: number;
  pending: LifecyclePending | null;
  lastResult: LifecycleResult | null;
}

/** `POST /api/backups/restore/verify`. */
export interface VerifyResponse {
  stageId: string;
  expiresAt: number;
  summary: BackupSummary;
  migrationNeeded: boolean;
  hasSecrets: boolean;
}

/** `GET /api/data/retention`. */
export interface RetentionView {
  settings: { enabled: boolean; months: number };
  preview: { cutoff: number; leads: number };
  lastRun: { at: number; cutoff: number; deleted: number } | null;
}

/** Yedek listesi; süren bir yedek varsa 2 sn'de bir yenilenir (düğme ve satır kendiliğinden güncellenir). */
export function useBackups() {
  return useQuery({
    queryKey: BACKUPS_QK,
    queryFn: () => api<BackupOverview>("/api/backups"),
    refetchInterval: (q) =>
      q.state.data?.backups.some((b) => b.status === "running") ? 2000 : false,
  });
}

export function useRefreshBackups() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: BACKUPS_QK });
    void qc.invalidateQueries({ queryKey: RETENTION_QK });
    // Kurulum listesi (paket K) "yedek alındı" maddesini durum ucundan okur.
    void qc.invalidateQueries({ queryKey: ["onboarding"] });
  };
}

/** Bayt → "12,4 KB" / "3,1 MB" (etkin dilin ondalık ayıracıyla). */
export function fmtSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const kb = bytes / 1024;
  const nf = (n: number) =>
    n.toLocaleString(intlLocale(), { maximumFractionDigits: n < 10 ? 1 : 0 });
  return kb < 1024
    ? t("backup.size.kb", { size: nf(kb) })
    : t("backup.size.mb", { size: nf(kb / 1024) });
}

/** Electron köprüsü (tarayıcıda/geliştirmede yok; her çağıran yokluğu karşılar). */
export const desktop = () => (typeof window === "undefined" ? undefined : window.universalMail);
