"use client";

import { Inbox } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { useSafeMutation } from "@/features/campaigns/use-safe-mutation";
import { fmtDateTime } from "@/lib/client/format";
import { mailOpsApi, mk, useReviewQueue, type ReviewItem } from "@/lib/client/mail-ops";
import { t } from "@/lib/i18n";
import { classLabel, reviewReasonLabel } from "./model";

const INVALIDATE = [mk.all] as const;

function ReviewRow({ item }: { item: ReviewItem }) {
  const [confirm, setConfirm] = useState(false);
  const apply = useSafeMutation(() => mailOpsApi.resolveReview(item.id, "apply"), {
    invalidate: INVALIDATE,
    successMessage: t("inbox.applied"),
  });
  const ignore = useSafeMutation(() => mailOpsApi.resolveReview(item.id, "ignore"), {
    invalidate: INVALIDATE,
    successMessage: t("inbox.ignored"),
  });
  return (
    <li className="grid items-center gap-2 p-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          <Badge variant="warning">
            {classLabel(item.classification, item.reason) ?? t("mlog.class.other")}
          </Badge>
          <span>{reviewReasonLabel(item.reason)}</span>
        </p>
        <p className="text-[12px] text-muted-foreground">
          {t("inbox.sender", { domain: item.senderDomain })} · {fmtDateTime(item.receivedAt)}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          loading={ignore.isPending}
          onClick={() => ignore.mutate(undefined)}
        >
          {t("inbox.ignore")}
        </Button>
        {item.applicable && (
          <Button size="sm" onClick={() => setConfirm(true)}>
            {t("inbox.apply")}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        title={t("inbox.apply.title")}
        description={t("inbox.apply.body")}
        confirmLabel={t("inbox.apply.confirm")}
        onConfirm={async () => {
          try {
            await apply.mutateAsync(undefined);
          } catch {
            /* useSafeMutation kullanıcıya bildirir */
          }
        }}
      />
    </li>
  );
}

/** İnceleme kuyruğu (K4): otomatik etki üretmeyen iletiler. Karar kullanıcıya aittir. */
export function ReviewPanel() {
  const q = useReviewQueue();
  return (
    <div className="space-y-3">
      <Notice>{t("inbox.help")}</Notice>
      {q.isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : q.isError || !q.data ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t("inbox.empty.title")}
          body={t("inbox.empty.body")}
          className="rounded-xl border border-dashed bg-card"
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label={t("inbox.title")}>
          {q.data.map((it) => (
            <ReviewRow key={it.id} item={it} />
          ))}
        </ul>
      )}
      <p className="text-[12px] text-muted-foreground">{t("inbox.simulated")}</p>
    </div>
  );
}
