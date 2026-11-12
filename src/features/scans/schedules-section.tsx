"use client";

import { CalendarClock, CircleAlert, Play, RefreshCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, FieldHint, Input, Label, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/tooltip";
import { ApiError, errorText } from "@/lib/client/api";
import { fmtDateTime, fmtUsd } from "@/lib/client/format";
import {
  INTERVALS,
  parseCostCap,
  scheduleControlName,
  scheduleViewModel,
  useDeleteSchedule,
  useRunScheduleNow,
  useSchedules,
  useUpdateSchedule,
  type IntervalDays,
  type ScheduleItem,
  type ScheduleTone,
} from "@/lib/client/schedules";
import { t, type TrKey } from "@/lib/i18n";

const TONE: Record<ScheduleTone, BadgeProps["variant"]> = {
  ok: "success",
  warning: "warning",
  danger: "danger",
  muted: "outline",
};

function ScheduleRow({ s }: { s: ScheduleItem }) {
  const update = useUpdateSchedule();
  const del = useDeleteSchedule();
  const runNow = useRunScheduleNow();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const vm = scheduleViewModel(s, Date.now(), { dateTime: fmtDateTime, usd: fmtUsd });
  const titleId = `schedule-${s.id}-title`;
  const named = (label: string) => scheduleControlName(label, vm.title);

  const patch = (p: { intervalDays?: IntervalDays; enabled?: boolean }) =>
    update.mutate(
      { id: s.id, ...p },
      {
        onSuccess: () => toast.success(t("schedules.updated")),
        onError: (e: Error) => toast.error(errorText(e)),
      },
    );
  const start = async (acknowledgeRisk: boolean) => {
    try {
      const r = await runNow.mutateAsync({ id: s.id, acknowledgeRisk });
      toast.success(t("builder.started", { id: r.scanId }));
      setAck(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NEEDS_ACK") setAck(e.message);
      else toast.error(errorText(e));
      if (acknowledgeRisk) throw e;
    }
  };

  return (
    <li className="rounded-lg border bg-card p-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p id={titleId} className="truncate text-sm font-semibold" title={vm.title}>
            {vm.title}
          </p>
          <p className="text-[13px] text-muted-foreground">
            {vm.intervalLabel} · {t("schedules.next")}:{" "}
            <span className={vm.overdue ? "font-medium text-foreground" : undefined}>
              {vm.nextLabel}
            </span>
          </p>
          {(vm.outcomeLabel || vm.missedNote) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              {vm.outcomeLabel && (
                <Badge variant={TONE[vm.outcomeTone]}>
                  {t("schedules.last")}: {vm.outcomeLabel}
                </Badge>
              )}
              {s.lastRunAt && (
                <span className="text-muted-foreground">{fmtDateTime(s.lastRunAt)}</span>
              )}
              {vm.missedNote && <span className="text-muted-foreground">{vm.missedNote}</span>}
            </div>
          )}
          {vm.skipReason && (
            <p
              className={
                vm.outcomeTone === "ok"
                  ? "rounded-md bg-muted px-2.5 py-1.5 text-[12px] text-muted-foreground"
                  : "rounded-md bg-nov-likely/15 px-2.5 py-1.5 text-[12px] text-caution-text"
              }
            >
              {vm.skipReason}
            </p>
          )}
          {vm.capLabel &&
            (vm.capRevoked ? (
              <p className="rounded-md bg-nov-likely/15 px-2.5 py-1.5 text-[12px] text-caution-text">
                {vm.capLabel}
              </p>
            ) : (
              <FieldHint>{vm.capLabel}</FieldHint>
            ))}
          <CapEditor s={s} title={vm.title} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={s.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) => patch({ enabled })}
              aria-label={named(t("schedules.toggle"))}
            />
            {s.enabled ? t("schedules.on") : t("schedules.off")}
          </label>
          <Label className="sr-only" htmlFor={`interval-${s.id}`}>
            {named(t("schedules.field.interval"))}
          </Label>
          <Select
            id={`interval-${s.id}`}
            className="h-8 w-auto"
            value={s.intervalDays}
            disabled={update.isPending}
            onChange={(e) => patch({ intervalDays: Number(e.target.value) as IntervalDays })}
          >
            {INTERVALS.map((d) => (
              <option key={d} value={d}>
                {t(`schedules.interval.${d}` as TrKey)}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="outline"
            loading={runNow.isPending}
            onClick={() => void start(false)}
            aria-label={named(t("schedules.runNow"))}
          >
            <Play /> {t("schedules.runNow")}
          </Button>
          <Button
            size="sm"
            variant="dangerOutline"
            onClick={() => setConfirmDelete(true)}
            aria-label={named(t("schedules.delete"))}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        tone="danger"
        title={t("schedules.delete.title")}
        description={t("schedules.delete.body")}
        confirmLabel={t("schedules.delete")}
        onConfirm={async () => {
          try {
            await del.mutateAsync(s.id);
            toast.success(t("schedules.deleted"));
          } catch (e) {
            toast.error(errorText(e));
            throw e;
          }
        }}
      />
      <ConfirmDialog
        open={ack !== null}
        onOpenChange={(o) => !o && setAck(null)}
        tone="warning"
        title={t("builder.ack.title")}
        description={ack}
        confirmLabel={t("builder.ack.confirm")}
        onConfirm={() => start(true)}
      />
    </li>
  );
}

/**
 * Tarama başına onaylı üst sınır (M5 ön onayı). NEEDS_ACK ile atlanan ya da onayı geri alınan (Google'a geçiş) bir
 * zamanlama buradan yeniden onaylanır; boş bırakılırsa bugünkü liste fiyatlı yüksek tahmin onaylanır (oluşturucuyla
 * aynı kural, `parseCostCap`). Sunucu yeni tutarı denetim kaydıyla yazar.
 */
function CapEditor({ s, title }: { s: ScheduleItem; title: string }) {
  const id = useId();
  const update = useUpdateSchedule();
  const initial = s.maxCostUsd === null ? "" : String(s.maxCostUsd);
  const [text, setText] = useState(initial);
  const cap = parseCostCap(text);
  return (
    <form
      className="space-y-1 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cap.ok) return;
        update.mutate(
          { id: s.id, maxCostUsd: cap.value },
          {
            onSuccess: () => toast.success(t("schedules.cap.saved")),
            onError: (err: Error) => toast.error(errorText(err)),
          },
        );
      }}
    >
      {/* Görünür etiket; ekran okuyucu için satır başlığı da eklenir (birden çok zamanlamada hangisi?). */}
      <Label htmlFor={`${id}-cap`} className="block text-[12px] font-normal text-muted-foreground">
        {t("schedules.cap.edit")}
        <span className="sr-only">: {title}</span>
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-cap`}
          inputMode="decimal"
          className="h-8 w-44"
          placeholder={t("schedules.field.cap.placeholder")}
          value={text}
          aria-invalid={cap.ok ? undefined : true}
          aria-describedby={cap.ok ? undefined : `${id}-cap-error`}
          onChange={(e) => setText(e.target.value)}
          data-testid="schedule-cap-input"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!cap.ok}
          loading={update.isPending}
          aria-label={scheduleControlName(t("schedules.cap.save"), title)}
        >
          {t("schedules.cap.save")}
        </Button>
      </div>
      {!cap.ok && (
        <FieldError id={`${id}-cap-error`}>{t("schedules.field.cap.invalid")}</FieldError>
      )}
    </form>
  );
}

/**
 * Taramalar sayfasının üstündeki "Düzenli taramalar" bölümü. Zamanlama yoksa yalnızca kısa bir açıklama gösterilir;
 * liste yüklenemezse boş liste gibi davranmaz ("henüz yok" demek yanıltıcı olur), hata ve "Yeniden dene" gösterilir.
 */
export function SchedulesSection() {
  const { data, isLoading, isError, refetch, isFetching } = useSchedules();
  if (isLoading) return null;
  const list = data ?? [];
  return (
    <section aria-labelledby="schedules-title" className="rounded-xl border bg-card/60 p-4">
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="schedules-title" className="flex items-center gap-1.5 text-sm font-semibold">
            {t("schedules.title")}
            <HelpTip>{t("help.schedules")}</HelpTip>
          </h2>
          {!isError && (
            <p className="text-[13px] text-muted-foreground">
              {list.length === 0 ? t("schedules.empty") : t("schedules.whileOpen")}
            </p>
          )}
        </div>
      </div>
      {isError && !data ? (
        <EmptyState
          compact
          icon={CircleAlert}
          title={t("schedules.loadError")}
          testId="schedules-error"
          action={
            <Button size="sm" variant="outline" loading={isFetching} onClick={() => void refetch()}>
              {!isFetching && <RefreshCw />} {t("error.retry")}
            </Button>
          }
        />
      ) : (
        list.length > 0 && (
          <ul className="mt-3 space-y-2">
            {list.map((s) => (
              <ScheduleRow key={s.id} s={s} />
            ))}
          </ul>
        )
      )}
    </section>
  );
}
