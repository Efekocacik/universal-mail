"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldHint, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { t, type TrKey } from "@/lib/i18n";
import {
  DERIVED_DAY_OPTIONS,
  retentionRows,
  type GoogleRetentionSummary,
} from "@/lib/scan/google-data-view";

const SOURCES: { href: string; key: TrKey }[] = [
  { href: "https://cloud.google.com/maps-platform/terms", key: "retention.source.terms" },
  {
    href: "https://developers.google.com/maps/documentation/places/web-service/policies",
    key: "retention.source.policies",
  },
  {
    href: "https://developers.google.com/maps/documentation/places/web-service/place-id#save-id",
    key: "retention.source.placeId",
  },
];

/**
 * Ayarlar > Veri: Google verisi saklama politikası kartı (Paket B; Ayarlar sayfasına Paket D yerleştirir).
 * Alan sınıfına göre ne kadar veri tutulduğunu, kuralını ve kaynağını gösterir; türetilmiş bayrak süresini ayarlatır ve
 * yer kimliği yenilemesini elle başlatır.
 */
export function GoogleRetentionCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["google-data"],
    queryFn: () => api<GoogleRetentionSummary>("/api/google-data"),
  });
  const saveDays = useMutation({
    mutationFn: (days: number | null) =>
      api("/api/settings", { method: "PUT", json: { "google.derivedFlagsDays": days } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["google-data"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("retention.saved"));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () =>
      api<{ queued: boolean }>("/api/google-data/refresh-ids", { method: "POST", json: {} }),
    onSuccess: (r) =>
      r.queued
        ? toast.success(t("retention.refresh.queued"))
        : toast.info(t("retention.refresh.already")),
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <Skeleton className="h-48" />;
  const rows = retentionRows(data);
  const derived = data.byPolicy.derived.maxDays;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div>
          <p className="text-[13px] font-medium">{t("retention.title")}</p>
          <p className="text-[12px] text-muted-foreground">{t("retention.desc")}</p>
        </div>
      </div>
      <table className="w-full text-[12px]">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">{t("retention.col.data")}</th>
            <th className="py-1 text-right font-medium">{t("retention.col.count")}</th>
            <th className="py-1 pl-3 font-medium">{t("retention.col.rule")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t">
              <td className="py-1.5">{r.label}</td>
              <td className="tabular py-1.5 text-right">{r.count}</td>
              <td className="py-1.5 pl-3 text-muted-foreground">{r.rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.byPolicy.indefinite.gone > 0 && (
        <FieldHint>
          {t("retention.gone", { n: fmtNumber(data.byPolicy.indefinite.gone) })}
        </FieldHint>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="derived-days">{t("retention.derived.label")}</Label>
        <Select
          id="derived-days"
          className="w-auto"
          value={derived === null ? "" : String(derived)}
          disabled={saveDays.isPending}
          onChange={(e) => saveDays.mutate(e.target.value ? Number(e.target.value) : null)}
        >
          {[...new Set([...DERIVED_DAY_OPTIONS, derived])].map((d) => (
            <option key={d ?? "forever"} value={d === null ? "" : String(d)}>
              {d === null
                ? t("retention.derived.forever")
                : t("retention.derived.days", { days: d })}
            </option>
          ))}
        </Select>
        <FieldHint>{t("retention.derived.hint")}</FieldHint>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          loading={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw /> {t("retention.refresh")}
        </Button>
        <span className="text-[12px] text-muted-foreground">
          {t("retention.refresh.due", { n: fmtNumber(data.byPolicy.indefinite.dueRefresh) })}
        </span>
      </div>

      <details className="text-[12px] text-muted-foreground">
        <summary className="cursor-pointer">
          {t("retention.sources", { date: data.termsReviewedAt })}
        </summary>
        <ul className="mt-1.5 space-y-1">
          {SOURCES.map((s) => (
            <li key={s.href}>
              <a
                href={s.href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                {t(s.key)} <ExternalLink className="size-3" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-1.5">{t("retention.legal")}</p>
      </details>
    </div>
  );
}
