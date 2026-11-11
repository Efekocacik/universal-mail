"use client";

import { ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, PageHeader } from "@/components/ui/page";
import {
  reviewApi,
  useReview,
  type ReviewItem,
  type UncertainSendDecision,
} from "@/lib/client/campaigns";
import { fmtDateTime } from "@/lib/client/format";
import { t, type TrKey } from "@/lib/i18n";
import { reasonLabel } from "./model";
import { LoadError, Notice } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

/**
 * Sonucu kesinleşmemiş gönderimler. Bu iletiler otomatik yeniden gönderilmez; karar kullanıcınındır (gönderildi /
 * gönderilmedi / gönderimi durdur) ve her karar onay penceresinden geçer. Bu ekran hiçbir şey GÖNDERMEZ:
 * "gönderilmedi" kararı adımı yalnızca yeniden uygun hâle getirir. Alıcı sunucudan maskeli gelir.
 */

const DIALOG: Record<
  UncertainSendDecision,
  { title: TrKey; body: TrKey; confirm: TrKey; done: TrKey; tone: "warning" | "danger" }
> = {
  mark_sent: {
    title: "review.markSent.title",
    body: "review.markSent.body",
    confirm: "review.markSent.confirm",
    done: "review.resolved.mark_sent",
    tone: "warning",
  },
  mark_not_sent: {
    title: "review.markNotSent.title",
    body: "review.markNotSent.body",
    confirm: "review.markNotSent.confirm",
    done: "review.resolved.mark_not_sent",
    tone: "danger",
  },
  stop_sequence: {
    title: "review.stop.title",
    body: "review.stop.body",
    confirm: "review.stop.confirm",
    done: "review.resolved.stop_sequence",
    tone: "danger",
  },
};

function ReviewRow({ item }: { item: ReviewItem }) {
  const [open, setOpen] = useState<UncertainSendDecision | null>(null);
  const resolve = useSafeMutation(
    (decision: UncertainSendDecision) =>
      reviewApi.resolve(item.messageId, decision, { confirm: decision === "mark_not_sent" }),
    { onSuccess: (_, decision) => toast.success(t(DIALOG[decision].done)) },
  );
  const dialog = open ? DIALOG[open] : null;
  return (
    <li className="grid items-center gap-2 p-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning">{t(`messageStatus.${item.status}`)}</Badge>
          <span className="font-medium">{item.recipientMasked ?? item.peerDomain}</span>
          {item.stepIndex !== null && (
            <span className="text-muted-foreground">
              {t("queue.step", { n: item.stepIndex + 1 })}
            </span>
          )}
          <span className="tabular text-muted-foreground">{fmtDateTime(item.createdAt)}</span>
        </div>
        <p className="text-muted-foreground">
          {item.errorCode ? reasonLabel(item.errorCode) : t("review.noCode")}
          {item.campaignId !== null ? (
            <>
              {" · "}
              <Link href={`/campaigns/${item.campaignId}`} className="underline">
                {t("review.openCampaign", { id: item.campaignId })}
              </Link>
            </>
          ) : (
            <> · {t("review.testSend")}</>
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("review.resolve.actions")}>
        <Button
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          onClick={() => setOpen("mark_sent")}
        >
          {t("review.markSent")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          onClick={() => setOpen("mark_not_sent")}
        >
          {t("review.markNotSent")}
        </Button>
        {item.campaignLeadId !== null && (
          <Button
            size="sm"
            variant="dangerOutline"
            disabled={resolve.isPending}
            onClick={() => setOpen("stop_sequence")}
          >
            {t("review.stop")}
          </Button>
        )}
      </div>
      {dialog && open && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setOpen(null);
          }}
          tone={dialog.tone}
          title={t(dialog.title)}
          description={t(dialog.body)}
          confirmLabel={t(dialog.confirm)}
          pending={resolve.isPending}
          onConfirm={async () => {
            try {
              await resolve.mutateAsync(open);
            } catch {
              /* useSafeMutation kullanıcıya bildirir */
            }
          }}
        />
      )}
    </li>
  );
}

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
          <>
            <Notice>{t("review.resolve.help")}</Notice>
            <ul
              className="um-enter divide-y rounded-lg border bg-card"
              aria-label={t("review.title")}
            >
              {q.data.map((r) => (
                <ReviewRow key={r.messageId} item={r} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
