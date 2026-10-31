"use client";

import { Eye, Plus, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { useCampaigns, type CampaignStatus, type CampaignSummary } from "@/lib/client/campaigns";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { CAMPAIGN_STATUSES, pauseReasonText, progressOf } from "./model";
import { CampaignStatusBadge, LoadError, Notice } from "./parts";

function CampaignCard({ c }: { c: CampaignSummary }) {
  const p = progressOf(c.counts);
  const reason = c.status === "paused" ? pauseReasonText(c.pauseReason) : null;
  return (
    <article className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">
              <Link href={`/campaigns/${c.id}`} className="hover:underline">
                {c.name}
              </Link>
            </h2>
            <CampaignStatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("campaign.updated", { at: fmtDateTime(c.updatedAt) })} ·{" "}
            {t("campaign.dailyCapShort", { n: c.dailyCap })}
          </p>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link href={`/campaigns/${c.id}`}>
            <Eye /> {t("campaign.open")}
          </Link>
        </Button>
      </div>
      {reason && (
        <div className="mt-2">
          <Notice tone="warning">{reason}</Notice>
        </div>
      )}
      {p.total > 0 && (
        <div className="mt-3 space-y-1">
          <Progress value={p.pct} tone={c.status === "running" ? "primary" : "warning"} />
          <p className="tabular text-[12px] text-muted-foreground">
            {t("campaign.progress", {
              done: fmtNumber(p.finished),
              total: fmtNumber(p.total),
              excluded: fmtNumber(p.excluded),
            })}
          </p>
        </div>
      )}
    </article>
  );
}

export function CampaignsPage() {
  const [status, setStatus] = useState<CampaignStatus | "">("");
  const q = useCampaigns(status || undefined);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t("campaigns.title")}</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">{t("campaigns.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("campaigns.filter")}
              value={status}
              onChange={(e) => setStatus(e.target.value as CampaignStatus | "")}
              className="h-8 w-auto py-0 pr-7 text-[13px]"
            >
              <option value="">{t("campaigns.filter.all")}</option>
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`campaignStatus.${s}`)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="outline" asChild>
              <Link href="/campaigns/review">
                <ShieldAlert /> {t("review.title")}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/campaigns/new">
                <Plus /> {t("campaigns.new")}
              </Link>
            </Button>
          </div>
        </div>
        <Notice>{t("campaigns.demoNote")}</Notice>
        {q.isLoading ? (
          <Skeleton className="h-32" />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data && q.data.length > 0 ? (
          q.data.map((c) => <CampaignCard key={c.id} c={c} />)
        ) : (
          <div className="rounded-xl border border-dashed bg-card p-10 text-center">
            <p className="text-sm font-semibold">{t("campaigns.empty.title")}</p>
            <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
              {t("campaigns.empty.body")}
            </p>
            <Button asChild className="mt-4">
              <Link href="/campaigns/new">{t("campaigns.new")}</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
