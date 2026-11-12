"use client";

import { AlertTriangle } from "lucide-react";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { useWorkerStatus } from "@/lib/client/worker-status";
import { t } from "@/lib/i18n";

/**
 * Arka plan işçisi çalışmıyorsa (gecikmiş gönderim/gelen kutusu/çıkış işi ve canlı işçi yok, veya Electron çökme
 * döngüsü bildirdi) tüm ekranlarda kırmızı uyarı. Durum okunamazsa veya sorun yoksa hiçbir şey göstermez.
 */
export function WorkerStatusBanner() {
  const { data } = useWorkerStatus();
  if (!data || data.ok) return null;
  const body =
    data.reason === "crash_loop" && data.crashLoop
      ? t("worker.banner.crashLoop", {
          restarts: fmtNumber(data.crashLoop.restarts),
          at: fmtDateTime(data.crashLoop.at),
        })
      : t("worker.banner.overdue", {
          count: fmtNumber(data.overdueJobs),
          since: fmtDateTime(data.oldestOverdueAt),
        });
  return (
    <div
      role="alert"
      data-testid="worker-status-banner"
      className="flex shrink-0 gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px] text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{t("worker.banner.title")}</p>
        <p className="text-[12px]">{body}</p>
      </div>
    </div>
  );
}
