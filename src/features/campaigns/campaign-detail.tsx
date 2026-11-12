"use client";

import { ArrowLeft, Pause, Pencil, Play, ShieldAlert, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Progress, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  campaignApi,
  useCampaign,
  useTemplates,
  type CampaignAction,
  type CampaignDetail,
} from "@/lib/client/campaigns";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import {
  allowedActions,
  dayLabel,
  pauseReasonText,
  plainCounts,
  plainCountsText,
  progressOf,
  progressTone,
  statusStats,
} from "./model";
import { CampaignStatusBadge, DemoBadge, LoadError, Notice, Stat } from "./parts";
import { PreflightPanel } from "./preflight-panel";
import { MessagesTable, QueueTable } from "./queue-table";
import { useSafeMutation } from "./use-safe-mutation";

const DONE_MESSAGE: Record<CampaignAction, string | null> = {
  pause: t("campaign.paused.done"),
  resume: t("campaign.resumed.done"),
  cancel: t("campaign.cancelled.done"),
  draft: null,
  ready: null,
  start: null,
};

function Actions({ c }: { c: CampaignDetail }) {
  const a = allowedActions(c.status);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const control = useSafeMutation((action: CampaignAction) => campaignApi.control(c.id, action), {
    onSuccess: (_r, action) => {
      const msg = DONE_MESSAGE[action];
      if (msg) toast.success(msg);
    },
  });
  const busy = control.isPending;
  const pendingAction = busy ? control.variables : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {a.edit || a.backToDraft ? (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/campaigns/${c.id}/edit`}>
            <Pencil /> {t("campaign.edit")}
          </Link>
        </Button>
      ) : null}
      {a.pause && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => control.mutate("pause")}
          disabled={busy}
          loading={pendingAction === "pause"}
        >
          {pendingAction !== "pause" && <Pause />} {t("campaign.pause")}
        </Button>
      )}
      {a.resume && (
        <Button
          size="sm"
          onClick={() => control.mutate("resume")}
          disabled={busy}
          loading={pendingAction === "resume"}
        >
          {pendingAction !== "resume" && <Play />} {t("campaign.resume")}
        </Button>
      )}
      {a.cancel && (
        <Button
          size="sm"
          variant="dangerOutline"
          onClick={() => setConfirmCancel(true)}
          disabled={busy}
        >
          <Square /> {t("campaign.cancel")}
        </Button>
      )}
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        tone="danger"
        title={t("campaign.cancel.title")}
        description={t("campaign.cancel.body")}
        confirmLabel={t("campaign.cancel.confirm")}
        onConfirm={async () => {
          await control.mutateAsync("cancel");
        }}
      />
    </div>
  );
}

function Overview({ c }: { c: CampaignDetail }) {
  const p = progressOf(c.counts);
  const plain = plainCounts(c.counts, c.breakdown);
  const templates = useTemplates();
  const tplName = (id: number) => templates.data?.find((x) => x.id === id)?.name ?? `#${id}`;
  return (
    <div className="um-enter space-y-4">
      <div className="space-y-1.5 rounded-lg border bg-card p-4">
        <Progress value={p.pct} tone={progressTone(c.status)} label={c.name} />
        <p className="tabular text-[14px] font-medium">{plainCountsText(plain, fmtNumber)}</p>
        <p className="tabular text-[12px] text-muted-foreground">
          {t("campaign.progress", {
            done: fmtNumber(p.finished),
            total: fmtNumber(p.total),
            excluded: fmtNumber(p.excluded),
          })}
        </p>
        <div className="grid grid-cols-2 gap-4 pt-2 sm:grid-cols-4">
          {statusStats(c.counts, c.breakdown).map((s) => (
            <Stat key={s.key} label={s.label} value={fmtNumber(s.value)} />
          ))}
        </div>
      </div>
      <dl className="grid gap-3 rounded-lg border bg-card p-4 text-[13px] sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t("wizard.window")}</dt>
          <dd>
            {c.sendWindow.days.map(dayLabel).join(", ")} · {c.sendWindow.start}–{c.sendWindow.end}{" "}
            <span className="text-muted-foreground">({t("wizard.window.local")})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("wizard.dailyCap")}</dt>
          <dd className="tabular">{fmtNumber(c.dailyCap)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("wizard.gap")}</dt>
          <dd className="tabular">
            {c.minGapS}–{c.maxGapS} {t("wizard.seconds")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("campaign.startedAt")}</dt>
          <dd>{fmtDateTime(c.startedAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t("wizard.steps")}</dt>
          <dd>
            {c.steps.length === 0 ? (
              t("wizard.steps.none")
            ) : (
              <ul className="mt-1 space-y-0.5">
                {c.steps.map((s) => (
                  <li key={`${s.stepIndex}-${s.language}`}>
                    {t("queue.step", { n: s.stepIndex + 1 })} · {s.language.toUpperCase()} ·{" "}
                    {tplName(s.templateId)}
                    {s.stepIndex > 0 ? ` · ${t("wizard.delay.after", { n: s.delayDays })}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function CampaignDetailPage({ id }: { id: number }) {
  const q = useCampaign(id);
  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-14" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  const c = q.data;
  const running = c.status === "running";
  const reason = c.status === "paused" ? pauseReasonText(c.pauseReason) : null;
  const inFlight = c.counts.in_flight ?? 0;
  const a = allowedActions(c.status);
  const showPreflight = c.status === "draft" || c.status === "ready";

  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {t("campaigns.title")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{c.name}</h1>
              <CampaignStatusBadge status={c.status} />
              <DemoBadge />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("campaign.updated", { at: fmtDateTime(c.updatedAt) })}
              {" · "}
              <span className="tabular">
                {plainCountsText(plainCounts(c.counts, c.breakdown), fmtNumber)}
              </span>
            </p>
          </div>
          <Actions c={c} />
        </div>
        {reason && <Notice tone="warning">{reason}</Notice>}
        {inFlight > 0 && (
          <Notice tone="warning">
            {t("campaign.inFlight", { n: inFlight })}{" "}
            <Link href="/campaigns/review" className="inline-flex items-center gap-1 underline">
              <ShieldAlert className="size-3.5" /> {t("review.title")}
            </Link>
          </Notice>
        )}
        {(running || c.status === "paused") && <Notice>{t("campaign.reservedNote")}</Notice>}

        <Tabs defaultValue={showPreflight ? "preflight" : "overview"}>
          <TabsList>
            <TabsTrigger value="overview">{t("campaign.tab.overview")}</TabsTrigger>
            {showPreflight && (
              <TabsTrigger value="preflight">{t("campaign.tab.preflight")}</TabsTrigger>
            )}
            <TabsTrigger value="queue">{t("campaign.tab.queue")}</TabsTrigger>
            <TabsTrigger value="messages">{t("campaign.tab.messages")}</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-3">
            <Overview c={c} />
          </TabsContent>
          {showPreflight && (
            <TabsContent value="preflight" className="mt-3">
              <PreflightPanel campaign={c} />
            </TabsContent>
          )}
          <TabsContent value="queue" className="mt-3">
            <QueueTable campaignId={c.id} canRemove={a.removeLeads} running={running} />
          </TabsContent>
          <TabsContent value="messages" className="mt-3">
            <MessagesTable campaignId={c.id} running={running} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
