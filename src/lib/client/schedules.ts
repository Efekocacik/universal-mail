"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t, type TrKey } from "@/lib/i18n";
import { api } from "./api";

/**
 * Zamanlanmış taramalar istemcisi (Paket B).
 *  GET    /api/schedules                         → {schedules: ScheduleItem[]}
 *  POST   /api/schedules {fromScanId, intervalDays?, maxCostUsd?} → 201 {id, nextRunAt, ackMaxUsd, warning?}
 *  PATCH  /api/schedules/:id {intervalDays?, enabled?, maxCostUsd?} → {schedule}
 *  DELETE /api/schedules/:id                     → 204
 *  POST   /api/schedules/:id/run-now {acknowledgeRisk?} → 201 {scanId}
 */
export type IntervalDays = 7 | 14 | 30;
export const INTERVALS: readonly IntervalDays[] = [7, 14, 30];

export interface ScheduleItem {
  id: number;
  regionId: number;
  regionName: string;
  countryCode: string | null;
  categories: string[];
  customKeywords: string[];
  strategy: "text" | "nearby";
  fieldProfile: "discovery" | "enrich";
  intervalDays: IntervalDays;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastScanId: number | null;
  lastOutcome: "started" | "skipped" | "completed" | "failed" | null;
  lastSkipCode: string | null;
  missedRuns: number;
  maxCostUsd: number | null;
  ackMaxUsd: number | null;
  createdAt: number;
}

/** Bilinen atlama kodları (bildirim ve kart metinleri); bilinmeyen kod "other" metnine düşer. */
export const SKIP_CODES = [
  "BUDGET_BLOCKED",
  "NEEDS_ACK",
  "PLACES_KEY_MISSING",
  "SETUP_REQUIRED",
  "COUNTRY_NOT_TARGETED",
  "ACTIVE_SCAN",
  "CATEGORY_SET_MISSING",
  // Zamanlamanın kendi son taraması bitmedi (src/lib/scan/pause-codes.ts OWN_RUN_CODES).
  "PREVIOUS_RUN_ACTIVE",
  "SCAN_RETRYING",
  "SCAN_BUDGET_STOPPED",
  "SCAN_PAUSED",
] as const;

/** Bu kodlarla "skipped" aslında "son tarama duraklatıldı" demektir; kart "Atlandı" yerine "Duraklatıldı" der. */
const PAUSED_CODES = new Set(["SCAN_RETRYING", "SCAN_BUDGET_STOPPED", "SCAN_PAUSED"]);

export type ScheduleTone = "ok" | "warning" | "danger" | "muted";

export interface ScheduleVM {
  title: string;
  intervalLabel: string;
  /** "Sonraki çalışma" satırı: tarih veya "uygulama açılınca" / "kapalı". */
  nextLabel: string;
  overdue: boolean;
  outcomeLabel: string | null;
  outcomeTone: ScheduleTone;
  /** Atlandıysa sade Türkçe neden (ne yapılmalı dahil). */
  skipReason: string | null;
  missedNote: string | null;
  capLabel: string | null;
}

const DAY = 86_400_000;

/** Kart görünüm modeli (saf; testlerde `now` ve biçimlendirici enjekte edilir). */
export function scheduleViewModel(
  s: ScheduleItem,
  now: number,
  fmt: { dateTime: (ms: number) => string; usd: (n: number) => string },
): ScheduleVM {
  const parts = [s.regionName, ...s.categories, ...s.customKeywords.map((k) => `"${k}"`)];
  const overdue = s.enabled && s.nextRunAt <= now;
  const nextLabel = !s.enabled
    ? t("schedules.next.off")
    : overdue
      ? t("schedules.next.due")
      : s.nextRunAt - now < DAY
        ? t("schedules.next.soon", { at: fmt.dateTime(s.nextRunAt) })
        : fmt.dateTime(s.nextRunAt);
  let outcomeLabel: string | null = null;
  let outcomeTone: ScheduleTone = "muted";
  let skipReason: string | null = null;
  switch (s.lastOutcome) {
    case "completed":
      outcomeLabel = t("schedules.outcome.completed");
      outcomeTone = "ok";
      break;
    case "started":
      outcomeLabel = t("schedules.outcome.started");
      outcomeTone = "ok";
      break;
    case "failed":
      outcomeLabel = t("schedules.outcome.failed");
      outcomeTone = "danger";
      break;
    case "skipped": {
      const code = (SKIP_CODES as readonly string[]).includes(s.lastSkipCode ?? "")
        ? s.lastSkipCode!
        : "other";
      if (code === "PREVIOUS_RUN_ACTIVE") {
        // Önceki çalışma hâlâ sürüyor: bir sorun yok, yalnızca bilgi.
        outcomeLabel = t("schedules.outcome.started");
        outcomeTone = "ok";
      } else {
        outcomeLabel = t(
          PAUSED_CODES.has(code) ? "schedules.outcome.paused" : "schedules.outcome.skipped",
        );
        outcomeTone = "warning";
      }
      skipReason = t(`schedules.skip.${code}` as TrKey);
      break;
    }
    default:
      outcomeLabel = null;
  }
  return {
    title: parts.join(" · "),
    intervalLabel: t(`schedules.interval.${s.intervalDays}` as TrKey),
    nextLabel,
    overdue,
    outcomeLabel,
    outcomeTone,
    skipReason,
    missedNote: s.missedRuns > 0 ? t("schedules.missed", { n: s.missedRuns }) : null,
    capLabel:
      s.ackMaxUsd !== null
        ? t(s.maxCostUsd !== null ? "schedules.cap.user" : "schedules.cap.auto", {
            usd: fmt.usd(s.ackMaxUsd),
          })
        : null,
  };
}

export const scheduleKeys = { all: ["schedules"] as const };

export function useSchedules() {
  return useQuery({
    queryKey: scheduleKeys.all,
    queryFn: () => api<{ schedules: ScheduleItem[] }>("/api/schedules").then((r) => r.schedules),
    refetchInterval: 30_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: scheduleKeys.all });
    void qc.invalidateQueries({ queryKey: ["scans"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
}

export interface CreateScheduleInput {
  fromScanId: number;
  intervalDays: IntervalDays;
  maxCostUsd?: number | null;
}

export function useCreateSchedule() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateScheduleInput) =>
      api<{
        id: number;
        nextRunAt: number;
        ackMaxUsd: number;
        warning?: { code: string; message: string };
      }>("/api/schedules", { method: "POST", json: input }),
    onSuccess: done,
  });
}

export function useUpdateSchedule() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (p: {
      id: number;
      intervalDays?: IntervalDays;
      enabled?: boolean;
      maxCostUsd?: number | null;
    }) => {
      const { id, ...patch } = p;
      return api<{ schedule: ScheduleItem }>(`/api/schedules/${id}`, {
        method: "PATCH",
        json: patch,
      });
    },
    onSuccess: done,
  });
}

export function useDeleteSchedule() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => api(`/api/schedules/${id}`, { method: "DELETE" }),
    onSuccess: done,
  });
}

export function useRunScheduleNow() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (p: { id: number; acknowledgeRisk?: boolean }) =>
      api<{ scanId: number }>(`/api/schedules/${p.id}/run-now`, {
        method: "POST",
        json: p.acknowledgeRisk ? { acknowledgeRisk: true } : {},
      }),
    onSuccess: done,
  });
}

/** Maliyet üst sınırı girişini doğrular: boş → null (otomatik), aksi halde 0..10000 sayı. */
export function parseCostCap(raw: string): { ok: true; value: number | null } | { ok: false } {
  const v = raw.trim().replace(",", ".");
  if (!v) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}
