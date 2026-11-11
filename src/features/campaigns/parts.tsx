"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleCheck,
  FileText,
  Info,
  OctagonAlert,
  Pause,
  Play,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CampaignLeadStatus, CampaignStatus } from "@/lib/client/campaigns";
import { t } from "@/lib/i18n";
import { reasonLabel, SEQUENCE_VARIANT, sequenceStatusLabel, STATUS_VARIANT } from "./model";

/** Renk tek başına anlam taşımaz: her duruma metnin yanında küçük bir simge de eklenir. */
const STATUS_ICON: Record<CampaignStatus, LucideIcon> = {
  draft: FileText,
  ready: CircleCheck,
  running: Play,
  paused: Pause,
  completed: CheckCircle2,
  cancelled: Ban,
  stopped: OctagonAlert,
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      <Icon className="size-3" aria-hidden />
      {t(`campaignStatus.${status}`)}
    </Badge>
  );
}

/**
 * `reasons`: dizinin gerekçe kodları. `unsubscribed` durumu çıkış talebi VE ARF şikâyeti için ortak geçici durumdur
 * (migrasyon yok); şikâyetle durdurulan dizi `arf_complaint` işaretiyle ayrı etiketlenir.
 */
export function SequenceStatusBadge({
  status,
  reasons,
}: {
  status: CampaignLeadStatus;
  reasons?: readonly string[];
}) {
  return <Badge variant={SEQUENCE_VARIANT[status]}>{sequenceStatusLabel(status, reasons)}</Badge>;
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

/** Sayfa içi bilgi / uyarı / hata kutusu: renk + simge + metin (renk körlüğüne uygun). */
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
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      role={tone === "info" ? "note" : "alert"}
      className={`flex gap-2 rounded-md px-3 py-2 text-[13px] ${cls}`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Okuma hatası: ne oldu + ne yapılabilir; teknik ayrıntı yalnızca ipucu (title) olarak tutulur. */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div
      className="um-enter rounded-xl border border-dashed bg-card p-6 text-center"
      title={error instanceof Error ? error.message : undefined}
    >
      <p className="text-sm font-semibold">{t("campaign.loadError")}</p>
      <p className="mt-1 text-[13px] text-muted-foreground">{t("campaign.loadError.next")}</p>
      <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw /> {t("error.retry")}
      </Button>
    </div>
  );
}
