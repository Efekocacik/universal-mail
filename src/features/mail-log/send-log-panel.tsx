"use client";

import { Download, ScrollText } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { LoadError, Notice } from "@/features/campaigns/parts";
import { fmtDateTime } from "@/lib/client/format";
import { mailLogExportUrl, useMailLog, type MailLogFilter } from "@/lib/client/mail-ops";
import { t } from "@/lib/i18n";
import { classLabel, deliveryLabel, purposeLabel, statusLabel, statusVariant } from "./model";

/** Gönderim günlüğü (FR-CMP-10): giden ve gelen iletiler. Adresler maskeli; CSV de yalnızca maskeli adres içerir. */
export function SendLogPanel() {
  const [direction, setDirection] = useState<"" | "out" | "in">("");
  const filter: MailLogFilter = direction ? { direction } : {};
  const q = useMailLog(filter);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="mlog-direction">{t("mlog.filter.direction")}</Label>
          <Select
            id="mlog-direction"
            className="w-40"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "" | "out" | "in")}
          >
            <option value="">{t("mlog.filter.all")}</option>
            <option value="out">{t("mlog.dir.out")}</option>
            <option value="in">{t("mlog.dir.in")}</option>
          </Select>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={mailLogExportUrl(filter)} download>
            <Download /> {t("mlog.export")}
          </a>
        </Button>
      </div>
      <p className="text-[12px] text-muted-foreground">{t("mlog.export.note")}</p>

      {q.isLoading ? (
        <Skeleton className="h-64 rounded-xl" aria-label={t("mlog.loading")} />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t("mlog.empty.title")}
          body={t("mlog.empty.body")}
          className="rounded-xl border border-dashed bg-card"
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label={t("mlog.tab.send")}>
          {items.map((m) => (
            <li
              key={m.id}
              className="grid gap-1 p-3 text-[13px] sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
            >
              <span className="text-[12px] text-muted-foreground">{fmtDateTime(m.at)}</span>
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {m.redacted
                    ? t("mlog.redacted")
                    : `${m.direction === "out" ? t("mlog.dir.out") : t("mlog.dir.in")} · ${m.peer ?? "—"}`}
                </p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {[
                    purposeLabel(m.purpose),
                    m.campaignName,
                    m.subject,
                    classLabel(m.classification, m.errorCode),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={statusVariant(m.status)}>{statusLabel(m.status)}</Badge>
                {deliveryLabel(m.deliveryStatus) && (
                  <Badge variant={m.deliveryStatus === "bounced_hard" ? "danger" : "warning"}>
                    {deliveryLabel(m.deliveryStatus)}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {t("mlog.more")}
          </Button>
        </div>
      )}
      {items.length > 0 && <Notice>{t("health.demoNote")}</Notice>}
    </div>
  );
}
