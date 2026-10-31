"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/misc";
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {t("campaigns.title")}
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("review.title")}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("review.subtitle")}</p>
        </div>
        <Notice tone="warning">{t("review.noResend")}</Notice>
        {q.isLoading ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data || q.data.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card p-10 text-center text-[13px] text-muted-foreground">
            {t("review.empty")}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border bg-card" aria-label={t("review.title")}>
            {q.data.map((r) => (
              <li key={r.messageId} className="space-y-1 p-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-nov-likely/16 px-1.5 text-[11px] font-medium text-[#8a6700]">
                    {t(`messageStatus.${r.status}`)}
                  </span>
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
