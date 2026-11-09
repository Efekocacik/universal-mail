"use client";

import { Download, History } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/page";
import { LoadError } from "@/features/campaigns/parts";
import { fmtDateTime } from "@/lib/client/format";
import { auditExportUrl, useAudit } from "@/lib/client/mail-ops";
import { t } from "@/lib/i18n";

const PREFIXES = [
  "campaign.",
  "suppression.",
  "inbound.",
  "export.",
  "template.",
  "policy.",
] as const;

/** İşlem kaydı (FR-CMPL-06): kişisel bilgi içermeyen özetler. */
export function AuditPanel() {
  const [prefix, setPrefix] = useState("");
  const q = useAudit(prefix);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">{t("audit.help")}</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="audit-prefix">{t("audit.filter")}</Label>
          <Select
            id="audit-prefix"
            className="w-48"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          >
            <option value="">{t("mlog.filter.all")}</option>
            {PREFIXES.map((p) => (
              <option key={p} value={p}>
                {p.replace(".", "")}
              </option>
            ))}
          </Select>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={auditExportUrl(prefix)} download>
            <Download /> {t("mlog.export")}
          </a>
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : q.isError ? (
        <LoadError error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={History}
          title={t("audit.empty")}
          className="rounded-xl border border-dashed bg-card"
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label={t("audit.title")}>
          {items.map((a) => (
            <li
              key={a.id}
              className="grid gap-1 p-3 text-[13px] sm:grid-cols-[9rem_14rem_minmax(0,1fr)] sm:gap-3"
            >
              <span className="text-[12px] text-muted-foreground">{fmtDateTime(a.at)}</span>
              <span className="truncate font-mono text-[12px]">{a.action}</span>
              <span className="truncate text-[12px] text-muted-foreground">{a.summary}</span>
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
    </div>
  );
}
