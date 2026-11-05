"use client";

import { ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { useReview } from "@/lib/client/campaigns";
import { fmtDateTime } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { reasonLabel } from "./model";
import { LoadError, Notice } from "./parts";

/**
 * Sonucu kesinleşmemiş gönderimler — SALT OKUNUR. Bu iletiler otomatik yeniden gönderilmez; bu ekranda çözüm veya
 * yeniden gönderim işlemi bilinçli olarak YOKTUR. Alıcı sunucudan maskeli gelir.
 */
export function ReviewPage() {
  const q = useReview();
  return (
    <div className="um-scroll min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {t("campaigns.title")}
        </Link>
        <PageHeader title={t("review.title")} description={t("review.subtitle")} />
        <Notice tone="warning">{t("review.noResend")}</Notice>
        {q.isLoading ? (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data || q.data.length === 0 ? (
          <EmptyState
            className="rounded-xl border border-dashed bg-card p-10"
            icon={CheckCircle2}
            title={t("review.empty")}
          />
        ) : (
          <ul
            className="um-enter divide-y rounded-lg border bg-card"
            aria-label={t("review.title")}
          >
            {q.data.map((r) => (
              <li key={r.messageId} className="space-y-1 p-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">{t(`messageStatus.${r.status}`)}</Badge>
                  <span className="font-medium">{r.recipientMasked ?? r.peerDomain}</span>
                  {r.stepIndex !== null && (
                    <span className="text-muted-foreground">
                      {t("queue.step", { n: r.stepIndex + 1 })}
                    </span>
                  )}
                  <span className="tabular text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
                </div>
                <p className="text-muted-foreground">
                  {r.errorCode ? reasonLabel(r.errorCode) : t("review.noCode")}
                  {r.campaignId !== null && (
                    <>
                      {" · "}
                      <Link href={`/campaigns/${r.campaignId}`} className="underline">
                        {t("review.openCampaign", { id: r.campaignId })}
                      </Link>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
