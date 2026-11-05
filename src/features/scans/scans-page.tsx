"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Eye,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScanSearch,
  Square,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { Progress, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/client/api";
import { countryLabel, fmtDateTime, fmtNumber, fmtUsd } from "@/lib/client/format";
import { qk, useScans } from "@/lib/client/queries";
import type { ScanListItem, ScanStatus } from "@/lib/client/types";
import { skuLabel } from "@/lib/places/pricing";
import { t } from "@/lib/i18n";

const STATUS_VARIANT: Record<ScanStatus, BadgeProps["variant"]> = {
  draft: "outline",
  queued: "default",
  running: "success",
  paused: "warning",
  completed: "default",
  failed: "danger",
  cancelled: "low",
  budget_stopped: "warning",
};

interface ScanDetail {
  units: { status: string; count: number; saturated: number }[];
  failedUnits: { id: number; term: string; error: string | null }[];
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular text-base font-semibold">{value}</p>
    </div>
  );
}

function ScanCard({ scan }: { scan: ScanListItem }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const active = scan.status === "running" || scan.status === "queued";
  const p = scan.progress;
  const pct = p.unitsTotal ? Math.round(((p.unitsDone ?? 0) / p.unitsTotal) * 100) : 0;
  const calls = Object.values(scan.callsBySku).reduce((a, b) => a + b, 0);

  const detail = useQuery({
    queryKey: ["scan", scan.id],
    enabled: open,
    queryFn: () => api<ScanDetail>(`/api/scans/${scan.id}`),
    refetchInterval: open && active ? 2000 : false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.scans });
    void qc.invalidateQueries({ queryKey: qk.status });
  };
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "cancel") =>
      api(`/api/scans/${scan.id}/control`, { method: "POST", json: { action } }),
    onSuccess: (_r, action) => {
      if (action === "cancel") toast.success(t("scans.cancelled"));
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rerun = useMutation({
    mutationFn: () => api<{ scanId: number }>(`/api/scans/${scan.id}/rerun`, { method: "POST" }),
    onSuccess: (r) => {
      toast.success(t("builder.started", { id: r.scanId }));
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <article className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">
              #{scan.id} · {scan.regionName}
            </h2>
            <Badge variant={STATUS_VARIANT[scan.status]}>
              {scan.status === "running" && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {t(`scanStatus.${scan.status}`)}
            </Badge>
            {scan.provider === "mock" && <Badge variant="future">DEMO</Badge>}
            {scan.status === "completed" &&
              (scan.isBaseline ? (
                <Badge variant="outline">{t("scans.baseline")}</Badge>
              ) : (
                <Badge variant="outline">{t("scans.compared")}</Badge>
              ))}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {[
              countryLabel(scan.countryCode),
              fmtDateTime(scan.createdAt),
              t(`scans.strategy.${scan.strategy}`),
              scan.fieldProfile === "enrich" ? t("scans.profile.enrich") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {active && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => control.mutate("pause")}
              disabled={control.isPending}
              loading={control.isPending && control.variables === "pause"}
            >
              <Pause /> {t("scans.pause")}
            </Button>
          )}
          {(scan.status === "paused" || scan.status === "budget_stopped") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => control.mutate("resume")}
              disabled={control.isPending}
              loading={control.isPending && control.variables === "resume"}
            >
              <Play /> {t("scans.resume")}
            </Button>
          )}
          {(active || scan.status === "paused" || scan.status === "budget_stopped") && (
            <Button
              size="sm"
              variant="dangerOutline"
              onClick={() => setConfirmCancel(true)}
              disabled={control.isPending}
            >
              <Square /> {t("scans.cancel")}
            </Button>
          )}
          {(scan.status === "completed" || (p.placesFound ?? 0) > 0) && (
            <Button size="sm" variant="outline" onClick={() => router.push(`/?scan=${scan.id}`)}>
              <Eye /> {t("scans.show")}
            </Button>
          )}
          {(scan.status === "completed" ||
            scan.status === "failed" ||
            scan.status === "cancelled") && (
            <Button size="sm" variant="outline" onClick={() => setConfirmRerun(true)}>
              <RefreshCw /> {t("scans.rerun")}
            </Button>
          )}
        </div>
      </div>

      {(active || scan.status === "paused" || scan.status === "budget_stopped") && (
        <div className="mt-3 space-y-1.5">
          <Progress
            value={active ? Math.max(pct, 2) : pct}
            tone={active ? "primary" : "warning"}
            label={t("scans.units")}
          />
          <p className="tabular text-[12px] text-muted-foreground">
            {fmtNumber(p.unitsDone ?? 0)} / {fmtNumber(p.unitsTotal ?? 0)} {t("scans.units")} · %
            {pct}
          </p>
        </div>
      )}
      {scan.pauseReason && scan.status !== "completed" && (
        <p className="mt-2 rounded-md bg-nov-likely/15 px-3 py-2 text-[13px] text-[#6b5200]">
          {scan.pauseReason}
        </p>
      )}
      {(scan.error || scan.status === "failed") && (
        <p
          role="alert"
          className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
        >
          {t("scans.failed.explain")}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label={t("scans.stat.found")} value={fmtNumber(p.placesFound ?? 0)} />
        <Stat
          label={t("scans.stat.future")}
          value={fmtNumber(p.futureOpening ?? 0)}
          hint={t("scans.stat.future.hint")}
        />
        <Stat
          label={t("scans.stat.new")}
          value={scan.isBaseline || !scan.finishedAt ? "—" : fmtNumber(p.newPlaces ?? 0)}
          hint={t("scans.stat.new.hint")}
        />
        <Stat label={t("scans.stat.calls")} value={fmtNumber(calls)} />
        <Stat
          label={t("scans.stat.cost")}
          value={fmtUsd(scan.costUsd)}
          hint={t("scans.stat.cost.hint")}
        />
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-3 flex min-h-8 items-center gap-1 rounded text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />{" "}
        {t("scans.details")}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg bg-muted/60 p-3 text-[13px]">
          {detail.isLoading && <Skeleton className="h-10" />}
          {Object.keys(scan.callsBySku).length > 0 && (
            <ul className="space-y-0.5">
              {Object.entries(scan.callsBySku).map(([sku, n]) => (
                <li key={sku} className="flex justify-between">
                  <span>{skuLabel(sku)}</span>
                  <span className="tabular">
                    {fmtNumber(n)} {t("scans.stat.calls").toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {detail.data && (
            <p className="tabular text-muted-foreground">
              {detail.data.units
                .map((u) => `${t(`unitStatus.${u.status}` as never)}: ${fmtNumber(u.count)}`)
                .join(" · ")}
              {detail.data.units.some((u) => u.saturated > 0) &&
                ` · ${t("scans.saturated", { n: detail.data.units.reduce((a, u) => a + u.saturated, 0) })}`}
            </p>
          )}
          {detail.data && detail.data.failedUnits.length > 0 && (
            <div>
              <p className="font-medium text-destructive">{t("scans.failedUnits")}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {detail.data.failedUnits.map((u) => (
                  <li key={u.id}>
                    <code className="rounded bg-card px-1">{u.term}</code> — {u.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scan.error && (
            <p className="text-[12px] text-muted-foreground">
              {t("scans.detail.raw")}: {scan.error}
            </p>
          )}
          <p className="text-[12px] text-muted-foreground">{t("scans.compare.note")}</p>
        </div>
      )}

      <ConfirmDialog
        open={confirmRerun}
        onOpenChange={setConfirmRerun}
        tone="success"
        title={t("scans.rerun.title")}
        description={t("scans.rerun.body", { calls: fmtNumber(calls), cost: fmtUsd(scan.costUsd) })}
        confirmLabel={t("scans.rerun.confirm")}
        onConfirm={async () => {
          await rerun.mutateAsync();
        }}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        tone="danger"
        title={t("scans.cancel.title")}
        description={t("scans.cancel.body")}
        confirmLabel={t("scans.cancel")}
        onConfirm={async () => {
          await control.mutateAsync("cancel");
        }}
      />
    </article>
  );
}

export function ScansPage() {
  const { data, isLoading, isError, refetch, isFetching } = useScans(true);
  const hasScans = !!data && data.length > 0;
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="um-enter mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <PageHeader
          title={t("scans.title")}
          description={t("scans.subtitle")}
          actions={
            hasScans && (
              <Button asChild>
                <Link href="/">
                  <Plus /> {t("scans.new")}
                </Link>
              </Button>
            )
          }
        />
        {isLoading ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-52" />
            <Skeleton className="h-52" />
          </div>
        ) : isError ? (
          <div className="rounded-xl border bg-card">
            <EmptyState
              icon={ScanSearch}
              title={t("scans.error.title")}
              body={t("scans.error.body")}
              action={
                <Button variant="outline" loading={isFetching} onClick={() => void refetch()}>
                  <RefreshCw /> {t("scans.refresh")}
                </Button>
              }
            />
          </div>
        ) : hasScans ? (
          data.map((s) => <ScanCard key={s.id} scan={s} />)
        ) : (
          <div className="rounded-xl border border-dashed bg-card">
            <EmptyState
              icon={ScanSearch}
              title={t("scans.empty.title")}
              body={t("scans.empty.body")}
              action={
                <Button asChild>
                  <Link href="/">{t("scans.empty.cta")}</Link>
                </Button>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
