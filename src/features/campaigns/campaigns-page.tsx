"use client";

import { Eye, Megaphone, Plus, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Progress, Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { DeliveryAlertBanner } from "@/features/compliance/delivery-alert";
import { MailboxReauthBanner } from "./mailbox-reauth-banner";
import { useCampaignList, type CampaignStatus, type CampaignSummary } from "@/lib/client/campaigns";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import {
  CAMPAIGN_STATUSES,
  pauseReasonText,
  plainCounts,
  plainCountsText,
  progressOf,
  progressTone,
} from "./model";
import { CampaignStatusBadge, LoadError, Notice } from "./parts";
import { CampaignsSubnav } from "./subnav";

function CampaignCard({ c }: { c: CampaignSummary }) {
  const p = progressOf(c.counts);
  const plain = plainCounts(c.counts, c.breakdown);
  const reason = c.status === "paused" ? pauseReasonText(c.pauseReason) : null;
  return (
    <article className="um-enter rounded-xl border bg-card p-4 shadow-xs transition-shadow duration-150 hover:shadow-md">
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
      <div className="mt-3 space-y-1">
        {p.total > 0 ? (
          <>
            <Progress value={p.pct} tone={progressTone(c.status)} label={c.name} />
            <p className="tabular text-[13px] text-muted-foreground">
              {plainCountsText(plain, fmtNumber)}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t("campaign.progress.none")}</p>
        )}
      </div>
    </article>
  );
}

export function CampaignsPage() {
  const [status, setStatus] = useState<CampaignStatus | "">("");
  const q = useCampaignList(status || undefined);
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const isEmpty = !q.isLoading && !q.isError && items.length === 0;
  const emptyNoFilter = isEmpty && status === "";
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <CampaignsSubnav />
        <DeliveryAlertBanner />
        <MailboxReauthBanner />
        <PageHeader
          title={t("campaigns.title")}
          description={t("campaigns.subtitle")}
          actions={
            <>
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
              {/* Tek dolu yeşil eylem: liste boşken ana eylem boş durumdaki düğmedir. */}
              <Button size="sm" variant={emptyNoFilter ? "outline" : "default"} asChild>
                <Link href="/campaigns/new">
                  <Plus /> {t("campaigns.new")}
                </Link>
              </Button>
            </>
          }
        />
        <Notice>{t("campaigns.demoNote")}</Notice>
        {q.isLoading ? (
          <div className="space-y-4" aria-busy aria-label={t("campaigns.loading")}>
            <Skeleton className="h-[116px] rounded-xl" />
            <Skeleton className="h-[116px] rounded-xl" />
            <Skeleton className="h-[116px] rounded-xl" />
          </div>
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : items.length > 0 ? (
          <>
            {items.map((c) => (
              <CampaignCard key={c.id} c={c} />
            ))}
            {items.length < total && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-muted-foreground">
                  {t("campaigns.partial", {
                    shown: fmtNumber(items.length),
                    total: fmtNumber(total),
                  })}
                </p>
                {q.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={q.isFetchingNextPage}
                    onClick={() => void q.fetchNextPage()}
                  >
                    {t("campaigns.more")}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : status === "" ? (
          <EmptyState
            className="rounded-xl border border-dashed bg-card p-10"
            icon={Megaphone}
            title={t("campaigns.empty.title")}
            body={t("campaigns.empty.body")}
            action={
              <Button asChild>
                <Link href="/campaigns/new">
                  <Plus /> {t("campaigns.new")}
                </Link>
              </Button>
            }
          />
        ) : (
          <EmptyState
            className="rounded-xl border border-dashed bg-card p-10"
            icon={Megaphone}
            title={t("campaigns.empty.filtered")}
            body={t("campaigns.empty.filtered.body")}
            action={
              <Button variant="outline" onClick={() => setStatus("")}>
                {t("campaigns.empty.showAll")}
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
