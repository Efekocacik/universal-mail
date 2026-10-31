"use client";

import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
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

/** Kuyruk (FR-CMP-05): alıcı adresleri sunucudan maskeli gelir; gönderimde olmayan dizi çıkarılabilir. */
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
        <Skeleton className="h-24" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data || q.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          {t("queue.empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {q.data.items.map((r) => (
            <li
              key={r.id}
              className="grid gap-2 p-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SequenceStatusBadge status={r.status} />
                  <span className="truncate font-medium">
                    {r.recipientMasked ?? t("queue.noRecipient")}
                  </span>
                  {r.countryCode && (
                    <span className="text-muted-foreground">{countryLabel(r.countryCode)}</span>
                  )}
                  {r.language && (
                    <span className="uppercase text-muted-foreground">{r.language}</span>
                  )}
                </div>
                <p className="tabular text-[12px] text-muted-foreground">
                  {t("queue.step", { n: r.nextStep + 1 })}
                  {r.nextSendAt ? ` · ${t("queue.next", { at: fmtDateTime(r.nextSendAt) })}` : ""}
                  {r.lastSentAt ? ` · ${t("queue.last", { at: fmtDateTime(r.lastSentAt) })}` : ""}
                  {r.lastError ? ` · ${reasonLabel(r.lastError)}` : ""}
                </p>
                {r.exclusionReasons.length > 0 && <ReasonList codes={r.exclusionReasons} />}
              </div>
              {canRemove && REMOVABLE_SEQUENCES.has(r.status) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove.mutate(r.id)}
                  disabled={remove.isPending}
                  aria-label={t("queue.remove.aria", { who: r.recipientMasked ?? String(r.id) })}
                >
                  {remove.isPending && remove.variables === r.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <X />
                  )}
                  {t("queue.remove")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Gönderim günlüğü (salt okunur): maskeli alıcı ve konu, durum, hata kodu. Gövde gösterilmez. */
export function MessagesTable({ campaignId, running }: { campaignId: number; running: boolean }) {
  const q = useCampaignMessages(campaignId, running);
  if (q.isLoading) return <Skeleton className="h-24" />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || q.data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-[13px] text-muted-foreground">
        {t("messages.empty")}
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border bg-card" aria-label={t("messages.title")}>
      {q.data.map((m) => (
        <li key={m.id} className="space-y-1 p-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-1.5 text-[11px] font-medium">
              {t(`messageStatus.${m.status}`)}
            </span>
            <span className="font-medium">{m.recipientMasked ?? m.peerDomain}</span>
            <span className="text-muted-foreground">
              {t("queue.step", { n: (m.stepIndex ?? 0) + 1 })}
            </span>
            <span className="tabular text-muted-foreground">
              {fmtDateTime(m.sentAt ?? m.createdAt)}
            </span>
          </div>
          {m.subject && <p className="truncate text-muted-foreground">{m.subject}</p>}
          {m.errorCode && (
            <p className="text-[12px] text-destructive">{reasonLabel(m.errorCode)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
