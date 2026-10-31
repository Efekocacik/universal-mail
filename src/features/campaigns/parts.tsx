"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CampaignLeadStatus, CampaignStatus } from "@/lib/client/campaigns";
import { t } from "@/lib/i18n";
import { reasonLabel, SEQUENCE_VARIANT, STATUS_VARIANT } from "./model";

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{t(`campaignStatus.${status}`)}</Badge>;
}

export function SequenceStatusBadge({ status }: { status: CampaignLeadStatus }) {
  return <Badge variant={SEQUENCE_VARIANT[status]}>{t(`sequenceStatus.${status}`)}</Badge>;
}

export function DemoBadge() {
  return (
    <Badge variant="future" title={t("campaign.demo.tip")}>
      {t("provider.demo")}
    </Badge>
  );
}

/** Kod listesi → okunur gerekçeler (bilinmeyen kod olduğu gibi gösterilir). */
export function ReasonList({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1">
      {codes.map((c) => (
        <li key={c}>
          <Badge variant="outline" title={c}>
            {reasonLabel(c)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div title={hint}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular text-base font-semibold">{value}</p>
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "danger";
  children: React.ReactNode;
}) {
  const cls =
    tone === "danger"
      ? "bg-destructive/10 text-destructive"
      : tone === "warning"
        ? "bg-nov-likely/15 text-[#6b5200]"
        : "bg-muted text-muted-foreground";
  return (
    <div
      role={tone === "info" ? "note" : "alert"}
      className={`flex gap-2 rounded-md px-3 py-2 text-[13px] ${cls}`}
    >
      {tone !== "info" && <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Okuma hatası: GET'ler meşgul durumunda zaten otomatik yenilendi; kullanıcı elle de yenileyebilir. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-dashed bg-card p-6 text-center">
      <p className="text-sm font-semibold">{t("campaign.loadError")}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw /> {t("error.retry")}
      </Button>
    </div>
  );
}
