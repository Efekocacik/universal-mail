"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint, Label, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { ToggleRow } from "@/features/settings/shared";
import { api, ApiError, errorText } from "@/lib/client/api";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { RETENTION_QK, type RetentionView } from "./data";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Faz 6 (paket Y.8, FR-CMPL-04): temas edilmemiş eski işletme kayıtlarının saklama süresi. Açma/kapama ve süre (1–12
 * ay; yalnızca kısaltılabilir) değişince hemen kaydedilir; "Şu an silinecek" önizlemesi gösterilir. "Şimdi uygula" onay
 * penceresinde görülen sayıyı sunucuya taşır: sayı bu arada arttıysa hiçbir şey silinmez (409) ve önizleme yenilenir.
 */
export function RetentionCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: RETENTION_QK,
    queryFn: () => api<RetentionView>("/api/data/retention"),
  });
  const [confirmRun, setConfirmRun] = useState(false);
  const save = useMutation({
    mutationFn: (v: { enabled: boolean; months: number }) =>
      api<Pick<RetentionView, "settings" | "preview">>("/api/data/retention", {
        method: "PUT",
        json: v,
      }),
    onSuccess: (r) => {
      qc.setQueryData<RetentionView>(RETENTION_QK, (old) => (old ? { ...old, ...r } : old));
      toast.success(t("backup.ret.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const run = useMutation({
    mutationFn: (expectedMax: number) =>
      api<{ deleted: number; cutoff: number }>("/api/data/retention/run", {
        method: "POST",
        json: { expectedMax },
      }),
    onSuccess: (r) => toast.success(t("backup.ret.done", { n: fmtNumber(r.deleted) })),
    onError: (e: Error) => toast.error(errorText(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: RETENTION_QK }),
  });

  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-[13px]">
        <span role="alert">{t("backup.loadError")}</span>
        <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
          {t("backup.retry")}
        </Button>
      </div>
    );
  const { settings, preview, lastRun } = q.data;
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="backup-retention">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <Hourglass className="size-4 text-muted-foreground" aria-hidden />
          {t("backup.ret.title")}
        </h3>
        <p className="text-[12px] text-muted-foreground">{t("backup.ret.desc")}</p>
      </div>
      <ToggleRow
        id="retention-enabled"
        label={t("backup.ret.enabled")}
        hint={t("backup.ret.enabled.hint")}
        checked={settings.enabled}
        disabled={save.isPending}
        onChange={(enabled) => save.mutate({ enabled, months: settings.months })}
      />
      <div className="flex flex-col items-start gap-1.5">
        <Label htmlFor="retention-months">{t("backup.ret.months")}</Label>
        <Select
          id="retention-months"
          className="w-auto"
          value={String(settings.months)}
          disabled={save.isPending}
          onChange={(e) =>
            save.mutate({ enabled: settings.enabled, months: Number(e.target.value) })
          }
        >
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {t("backup.ret.monthsValue", { months: m })}
            </option>
          ))}
        </Select>
        <FieldHint>{t("backup.ret.kept")}</FieldHint>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px]" aria-live="polite" data-testid="retention-preview">
          <span className="font-medium">
            {t("backup.ret.preview", { n: fmtNumber(preview.leads) })}
          </span>{" "}
          <span className="text-muted-foreground">
            {t("backup.ret.previewHint", { date: fmtDate(preview.cutoff) })}
          </span>
        </p>
        <Button
          size="sm"
          variant="dangerOutline"
          disabled={preview.leads === 0}
          loading={run.isPending}
          onClick={() => setConfirmRun(true)}
        >
          {t("backup.ret.run")}
        </Button>
      </div>
      {lastRun && (
        <FieldHint>
          {t("backup.ret.lastRun", {
            date: fmtDateTime(lastRun.at),
            n: fmtNumber(lastRun.deleted),
          })}
        </FieldHint>
      )}
      <ConfirmDialog
        open={confirmRun}
        onOpenChange={setConfirmRun}
        tone="danger"
        title={t("backup.ret.run.title")}
        description={t("backup.ret.run.body", { n: fmtNumber(preview.leads) })}
        confirmLabel={t("backup.ret.run")}
        onConfirm={async () => {
          try {
            await run.mutateAsync(preview.leads);
          } catch (e) {
            // Bayat önizleme: pencere kapanır, yeni sayı yüklenir (kullanıcı yeniden onaylar).
            if (!(e instanceof ApiError && e.code === "RETENTION_PREVIEW_STALE")) throw e;
          }
        }}
      />
    </div>
  );
}
