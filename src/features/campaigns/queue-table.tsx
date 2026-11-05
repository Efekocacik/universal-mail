"use client";

import { Inbox, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import {
  campaignApi,
  useCampaignMessages,
  useCampaignQueue,
  type CampaignLeadStatus,
} from "@/lib/client/campaigns";
import { countryLabel, fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { reasonLabel, REMOVABLE_SEQUENCES, SEQUENCE_STATUSES } from "./model";
import { LoadError, ReasonList, SequenceStatusBadge } from "./parts";
import { useSafeMutation } from "./use-safe-mutation";

const TH =
  "sticky top-0 z-10 bg-muted px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/** Kuyruk (FR-CMP-05): alıcı adresleri sunucudan maskeli gelir; gönderimde olmayan dizi kaldırılabilir. */
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
  const remove = useSafeMutation((clId: number) => campaignApi.removeLead(campaignId, clId), {
    successMessage: t("queue.removed"),
  });

  return (
    <section aria-labelledby="queue-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="queue-title" className="text-sm font-semibold">
          {t("queue.title")}
          {q.data && (
            <span className="ml-2 font-normal text-muted-foreground">
              ({fmtNumber(q.data.total)})
            </span>
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
              {t(`sequenceStatus.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.items.length === 0 ? (
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
              {q.data.items.map((r) => {
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
                        <SequenceStatusBadge status={r.status} />
                        {r.exclusionReasons.length > 0 && <ReasonList codes={r.exclusionReasons} />}
                        {r.lastError && (
                          <p className="text-[12px] text-destructive">{reasonLabel(r.lastError)}</p>
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
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.length === 0) {
    return (
      <EmptyState
        className="rounded-lg border border-dashed p-6"
        icon={Inbox}
        title={t("messages.empty")}
      />
    );
  }
  return (
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
          {q.data.map((m) => (
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
                    {m.status === "failed" ? t("messages.next.failed") : t("messages.next.unknown")}
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
