"use client";

import { Inbox, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { campaignLeadsApi, useExcludedCount } from "@/lib/client/campaign-leads";
import {
  campaignApi,
  useCampaign,
  useCampaignMessages,
  useCampaignQueue,
  type CampaignLeadStatus,
} from "@/lib/client/campaigns";
import { countryLabel, fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { queueFilterLabel, reasonLabel, REMOVABLE_SEQUENCES, SEQUENCE_STATUSES } from "./model";
import { LoadError, ReasonList, SequenceStatusBadge } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

const TH =
  "sticky top-0 z-10 bg-muted px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/**
 * Kuyruk (FR-CMP-05): alıcı adresleri sunucudan maskeli gelir; gönderimde olmayan dizi kaldırılabilir. Taslak/hazır
 * kampanyada hariç tutulan diziler yeniden denetlenebilir (uygun olanlar `pending` olur).
 */
export function QueueTable({
  campaignId,
  canRemove,
  running,
}: {
  campaignId: number;
  canRemove: boolean;
  running: boolean;
}) {
  const [status, setStatus] = useState<CampaignLeadStatus | "">("");
  const [target, setTarget] = useState<{ id: number; who: string } | null>(null);
  const q = useCampaignQueue(campaignId, status || undefined, running);
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const remove = useSafeMutation((clId: number) => campaignApi.removeLead(campaignId, clId), {
    successMessage: t("queue.removed"),
  });
  const campaignStatus = useCampaign(campaignId).data?.status;
  const editable = campaignStatus === "draft" || campaignStatus === "ready";
  const excludedCount = useExcludedCount(campaignId, editable).data ?? 0;
  const reevaluate = useSafeMutation(() => campaignLeadsApi.reevaluate(campaignId), {
    onSuccess: (r) => {
      if (r.reevaluated === 0) toast.info(t("queue.reevaluate.none"));
      else
        toast.success(
          t("queue.reevaluate.done", {
            pending: fmtNumber(r.nowPending),
            excluded: fmtNumber(r.stillExcluded),
          }),
        );
    },
  });

  return (
    <section aria-labelledby="queue-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="queue-title" className="text-sm font-semibold">
          {t("queue.title")}
          {q.data && (
            <span className="ml-2 font-normal text-muted-foreground">({fmtNumber(total)})</span>
          )}
        </h2>
        <Select
          aria-label={t("queue.filter")}
          value={status}
          onChange={(e) => setStatus(e.target.value as CampaignLeadStatus | "")}
          className="h-8 w-auto py-0 pr-7 text-[13px]"
        >
          <option value="">{t("queue.filter.all")}</option>
          {SEQUENCE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {queueFilterLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      {editable && excludedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <p className="text-[12px] text-muted-foreground">
            {t("queue.reevaluate.help", { n: fmtNumber(excludedCount) })}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reevaluate.mutate(undefined)}
            loading={reevaluate.isPending}
          >
            {!reevaluate.isPending && <RefreshCw aria-hidden />}
            {t("queue.reevaluate")}
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          className="rounded-lg border border-dashed p-6"
          icon={Inbox}
          title={t("queue.empty")}
        />
      ) : (
        <div className="um-scroll max-h-[28rem] overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[34rem] border-collapse text-[13px]">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  {t("queue.col.recipient")}
                </th>
                <th scope="col" className={TH}>
                  {t("queue.col.status")}
                </th>
                <th scope="col" className={TH}>
                  {t("queue.col.when")}
                </th>
                {canRemove && (
                  <th scope="col" className={`${TH} text-right`}>
                    <span className="sr-only">{t("queue.col.action")}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((r) => {
                const who = r.recipientMasked ?? String(r.id);
                return (
                  <tr key={r.id} className="align-top transition-colors hover:bg-accent/40">
                    <td className="max-w-[14rem] px-3 py-2.5">
                      <p className="truncate font-medium">
                        {r.recipientMasked ?? t("queue.noRecipient")}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        {[
                          r.countryCode ? countryLabel(r.countryCode) : null,
                          r.language?.toUpperCase(),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="space-y-1">
                        <SequenceStatusBadge
                          status={r.status}
                          reasons={r.exclusionReasons}
                          stopReason={r.stopReason}
                        />
                        {r.exclusionReasons.length > 0 && <ReasonList codes={r.exclusionReasons} />}
                        {r.lastError && (
                          <p className="text-[12px] text-destructive">
                            {r.lastError.split(",").map(reasonLabel).join(", ")}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="tabular px-3 py-2.5 text-[12px] text-muted-foreground">
                      <p>{t("queue.step", { n: r.nextStep + 1 })}</p>
                      {r.nextSendAt && <p>{t("queue.next", { at: fmtDateTime(r.nextSendAt) })}</p>}
                      {r.lastSentAt && <p>{t("queue.last", { at: fmtDateTime(r.lastSentAt) })}</p>}
                    </td>
                    {canRemove && (
                      <td className="px-3 py-2 text-right">
                        {REMOVABLE_SEQUENCES.has(r.status) && (
                          <Button
                            size="sm"
                            variant="dangerGhost"
                            onClick={() => setTarget({ id: r.id, who })}
                            disabled={remove.isPending}
                            aria-label={t("queue.remove.aria", { who })}
                            title={t("queue.remove.aria", { who })}
                          >
                            <X />
                            {t("queue.remove")}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {items.length > 0 && items.length < total && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-muted-foreground" data-testid="queue-partial">
            {t("queue.partial", { shown: fmtNumber(items.length), total: fmtNumber(total) })}
          </p>
          {q.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t("queue.more")}
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        tone="danger"
        title={t("queue.remove.title")}
        description={t("queue.remove.body", { who: target?.who ?? "" })}
        confirmLabel={t("queue.remove")}
        onConfirm={async () => {
          if (target) await remove.mutateAsync(target.id);
        }}
      />
    </section>
  );
}

/** Gönderim günlüğü (salt okunur): maskeli alıcı ve konu, durum, hata kodu. Gövde gösterilmez. */
export function MessagesTable({ campaignId, running }: { campaignId: number; running: boolean }) {
  const q = useCampaignMessages(campaignId, running);
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        className="rounded-lg border border-dashed p-6"
        icon={Inbox}
        title={t("messages.empty")}
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="um-scroll max-h-[28rem] overflow-x-auto rounded-lg border bg-card">
        <table
          className="w-full min-w-[34rem] border-collapse text-[13px]"
          aria-label={t("messages.title")}
        >
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {t("messages.col.recipient")}
              </th>
              <th scope="col" className={TH}>
                {t("messages.col.status")}
              </th>
              <th scope="col" className={TH}>
                {t("messages.col.when")}
              </th>
              <th scope="col" className={TH}>
                {t("messages.col.detail")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((m) => (
              <tr key={m.id} className="align-top transition-colors hover:bg-accent/40">
                <td className="max-w-[12rem] truncate px-3 py-2.5 font-medium">
                  {m.recipientMasked ?? m.peerDomain}
                </td>
                <td className="px-3 py-2.5">
                  <Badge
                    variant={
                      m.status === "sent"
                        ? "success"
                        : m.status === "failed"
                          ? "danger"
                          : m.status === "unknown"
                            ? "warning"
                            : "default"
                    }
                  >
                    {t(`messageStatus.${m.status}`)}
                  </Badge>
                </td>
                <td className="tabular px-3 py-2.5 text-[12px] text-muted-foreground">
                  <p>{t("queue.step", { n: (m.stepIndex ?? 0) + 1 })}</p>
                  <p>{fmtDateTime(m.sentAt ?? m.createdAt)}</p>
                </td>
                <td className="max-w-[16rem] px-3 py-2.5">
                  {m.subject && <p className="truncate text-muted-foreground">{m.subject}</p>}
                  {m.errorCode && (
                    <p className="text-[12px] text-destructive">{reasonLabel(m.errorCode)}</p>
                  )}
                  {(m.status === "failed" || m.status === "unknown") && (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {m.status === "failed"
                        ? t("messages.next.failed")
                        : t("messages.next.unknown")}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {t("messages.more")}
          </Button>
        </div>
      )}
    </div>
  );
}
