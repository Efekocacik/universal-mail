"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, FieldHint, Input, Label, Select } from "@/components/ui/input";
import { ApiError } from "@/lib/client/api";
import { fmtDateTime } from "@/lib/client/format";
import {
  INTERVALS,
  parseCostCap,
  useCreateSchedule,
  type IntervalDays,
} from "@/lib/client/schedules";
import { t, type TrKey } from "@/lib/i18n";

export interface RepeatValue {
  intervalDays: IntervalDays;
  /** Kullanıcının yazdığı üst sınır (boş = otomatik). */
  capText: string;
}

export const DEFAULT_REPEAT: RepeatValue = { intervalDays: 14, capText: "" };

/** Aralık seçimi ve isteğe bağlı tarama başına maliyet üst sınırı (oluşturucu ve "Düzenli tekrarla" penceresi ortak). */
export function RepeatFields({
  value,
  onChange,
}: {
  value: RepeatValue;
  onChange: (v: RepeatValue) => void;
}) {
  const id = useId();
  const cap = parseCostCap(value.capText);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-interval`}>{t("schedules.field.interval")}</Label>
        <Select
          id={`${id}-interval`}
          value={value.intervalDays}
          onChange={(e) =>
            onChange({ ...value, intervalDays: Number(e.target.value) as IntervalDays })
          }
        >
          {INTERVALS.map((d) => (
            <option key={d} value={d}>
              {t(`schedules.interval.${d}` as TrKey)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-cap`}>{t("schedules.field.cap")}</Label>
        <Input
          id={`${id}-cap`}
          inputMode="decimal"
          placeholder={t("schedules.field.cap.placeholder")}
          value={value.capText}
          aria-invalid={!cap.ok}
          onChange={(e) => onChange({ ...value, capText: e.target.value })}
        />
        {cap.ok ? (
          <FieldHint>{t("schedules.field.cap.hint")}</FieldHint>
        ) : (
          <FieldError>{t("schedules.field.cap.invalid")}</FieldError>
        )}
      </div>
      <FieldHint className="sm:col-span-2">{t("schedules.whileOpen")}</FieldHint>
    </div>
  );
}

/** Taramadan zamanlama oluşturur; hata iletisini (ör. zaten var) kullanıcıya gösterir. */
export function useRepeatScan() {
  const create = useCreateSchedule();
  return {
    pending: create.isPending,
    async run(scanId: number, v: RepeatValue): Promise<boolean> {
      const cap = parseCostCap(v.capText);
      if (!cap.ok) {
        toast.error(t("schedules.field.cap.invalid"));
        return false;
      }
      try {
        const r = await create.mutateAsync({
          fromScanId: scanId,
          intervalDays: v.intervalDays,
          maxCostUsd: cap.value,
        });
        toast.success(t("schedules.created", { at: fmtDateTime(r.nextRunAt) }));
        if (r.warning) toast.warning(r.warning.message);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "SCHEDULE_EXISTS") {
          toast.info(t("schedules.exists"));
          return true;
        }
        toast.error((e as Error).message);
        return false;
      }
    },
  };
}

/** Tarama kartındaki "Düzenli tekrarla" penceresi. */
export function RepeatScanDialog({
  scanId,
  open,
  onOpenChange,
}: {
  scanId: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [value, setValue] = useState<RepeatValue>(DEFAULT_REPEAT);
  const repeat = useRepeatScan();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="success"
      title={t("schedules.repeat.title")}
      description={t("schedules.repeat.body")}
      confirmLabel={t("schedules.repeat.confirm")}
      pending={repeat.pending}
      onConfirm={async () => {
        const ok = await repeat.run(scanId, value);
        if (!ok) throw new Error("not created");
      }}
    >
      <RepeatFields value={value} onChange={setValue} />
    </ConfirmDialog>
  );
}
