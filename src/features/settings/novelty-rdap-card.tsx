"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/tooltip";
import { api, errorText } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import {
  rdapSummary,
  YOUNG_DAYS_MAX,
  YOUNG_DAYS_MIN,
  type RdapStatus,
} from "@/lib/novelty/rdap-view";

/**
 * Ayarlar > Yenilik: alan adı yaşı (RDAP) kartı (Paket B; Ayarlar > Gelişmiş > Yenilik bölümünde, settings-page.tsx).
 * Açık/kapalı, "genç alan adı" penceresi, durum ve "Şimdi denetle". Gizlilik notu: yalnızca alan adı gönderilir.
 */
export function NoveltyRdapCard({ youngDays }: { youngDays: number }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["rdap-status"],
    queryFn: () => api<RdapStatus>("/api/settings/novelty/rdap-status"),
    refetchInterval: 30_000,
  });
  const [days, setDays] = useState(String(youngDays));
  useEffect(() => setDays(String(youngDays)), [youngDays]);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api("/api/settings", { method: "PUT", json: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["rdap-status"] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(t("rdap.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const check = useMutation({
    mutationFn: () =>
      api<{ added: number; queued: boolean }>("/api/leads/rdap", { method: "POST", json: {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["rdap-status"] });
      toast.success(r.queued ? t("rdap.check.queued") : t("rdap.check.already"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });

  if (isLoading || !data) return <Skeleton className="h-40" />;
  const n = Number(days);
  const daysValid = Number.isInteger(n) && n >= YOUNG_DAYS_MIN && n <= YOUNG_DAYS_MAX;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Globe className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
          <div>
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              {t("rdap.title")}
              <HelpTip>{t("help.rdap")}</HelpTip>
            </p>
            <p className="text-[12px] text-muted-foreground">{t("rdap.desc")}</p>
          </div>
        </div>
        <Switch
          checked={data.enabled}
          disabled={save.isPending}
          aria-label={t("rdap.toggle")}
          onCheckedChange={(enabled) => save.mutate({ "novelty.rdap": { enabled } })}
        />
      </div>
      <FieldHint>{data.demo ? t("rdap.privacy.demo") : t("rdap.privacy")}</FieldHint>
      {data.enabled && (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (daysValid && n !== youngDays) save.mutate({ "novelty.domainYoungDays": n });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rdap-days">{t("rdap.days")}</Label>
              <Input
                id="rdap-days"
                className="w-28"
                inputMode="numeric"
                value={days}
                aria-invalid={!daysValid}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              type="submit"
              variant="outline"
              disabled={!daysValid || n === youngDays}
            >
              {t("rdap.days.save")}
            </Button>
          </form>
          {daysValid ? (
            <FieldHint>{t("rdap.days.hint")}</FieldHint>
          ) : (
            <FieldError>
              {t("rdap.days.invalid", { min: YOUNG_DAYS_MIN, max: YOUNG_DAYS_MAX })}
            </FieldError>
          )}
          <p className="text-[12px] text-muted-foreground">{rdapSummary(data)}</p>
          {data.lastCheckedAt && (
            <p className="text-[12px] text-muted-foreground">
              {t("rdap.lastChecked", { at: fmtDateTime(data.lastCheckedAt) })}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            loading={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw /> {t("rdap.check")}
          </Button>
        </>
      )}
    </div>
  );
}
