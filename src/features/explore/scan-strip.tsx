"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/misc";
import { api } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { qk, useStatus } from "@/lib/client/queries";
import { t } from "@/lib/i18n";

/** Sürmekte olan veya yarım kalmış taramanın ilerleme şeridi (FR-DIS-06). */
export function ScanStrip() {
  const { data } = useStatus();
  const qc = useQueryClient();
  const control = useMutation({
    mutationFn: (v: { id: number; action: "pause" | "resume" }) =>
      api(`/api/scans/${v.id}/control`, { method: "POST", json: { action: v.action } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.status }),
    onError: (e: Error) => toast.error(e.message),
  });

  const scan =
    data?.scans.find((s) => s.status === "running" || s.status === "queued") ??
    data?.scans.find((s) => s.status === "paused" || s.status === "budget_stopped");
  if (!scan) return null;

  const p = scan.progress;
  const pct = p.unitsTotal ? Math.round(((p.unitsDone ?? 0) / p.unitsTotal) * 100) : 0;
  const running = scan.status === "running" || scan.status === "queued";

  return (
    <div className="space-y-2 border-b bg-accent/50 px-4 py-3" role="status">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium">
          {running
            ? t("strip.running", { id: scan.id })
            : scan.status === "budget_stopped"
              ? t("strip.budgetStopped", { id: scan.id })
              : t("strip.paused", { id: scan.id })}
        </p>
        <div className="flex items-center gap-1">
          {running ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => control.mutate({ id: scan.id, action: "pause" })}
            >
              <Pause /> {t("scans.pause")}
            </Button>
          ) : scan.status === "budget_stopped" ? (
            <Button size="sm" variant="outline" className="h-7" asChild>
              <Link href="/settings#budget">{t("strip.raiseBudget")}</Link>
            </Button>
          ) : null}
          {scan.status === "paused" && (
            <Button
              size="sm"
              className="h-7"
              onClick={() => control.mutate({ id: scan.id, action: "resume" })}
              disabled={control.isPending}
            >
              <Play /> {t("scans.resume")}
            </Button>
          )}
        </div>
      </div>
      <Progress value={running ? Math.max(pct, 2) : pct} tone={running ? "primary" : "warning"} />
      <p className="tabular text-[12px] text-muted-foreground">
        {t("strip.stats", {
          found: fmtNumber(p.placesFound ?? 0),
          calls: fmtNumber(p.callsTotal ?? 0),
          future: fmtNumber(p.futureOpening ?? 0),
        })}
      </p>
      {!running && scan.pauseReason && (
        <p className="text-[12px] text-muted-foreground">{scan.pauseReason}</p>
      )}
    </div>
  );
}
