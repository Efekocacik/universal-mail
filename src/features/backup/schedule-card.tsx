"use client";

import { useMutation } from "@tanstack/react-query";
import { CalendarClock, CircleAlert, FolderOpen, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/tooltip";
import { SaveBar, ToggleRow } from "@/features/settings/shared";
import type { BackupSchedule } from "@/lib/backup/service";
import { api, errorText } from "@/lib/client/api";
import { useUnsavedChanges } from "@/lib/client/locale-switch";
import { t } from "@/lib/i18n";
import { desktop, useRefreshBackups, type BackupOverview } from "./data";

const inRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/**
 * Faz 6 (paket Y.8): otomatik yedek ayarları (açılış/haftalık, saklanacak sayı, anahtarları dahil etme) ve yedek
 * klasörü. Masaüstünde "Klasör seç…" işletim sistemi penceresini açar; tarayıcıda klasörün tam yolu yazılır. Klasör
 * sunucuda doğrulanır (var, yazılabilir, uygulama klasörü dışında).
 */
export function ScheduleCard({ data }: { data: BackupOverview }) {
  const refresh = useRefreshBackups();
  const initial = { ...data.schedule, folder: data.folderIsDefault ? null : data.folder };
  const [form, setForm] = useState<BackupSchedule & { folder: string | null }>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const dirty = JSON.stringify(form) !== baseline;
  useUnsavedChanges(dirty);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () =>
      api<{ schedule: BackupSchedule; folder: string | null }>("/api/backups/settings", {
        method: "PUT",
        json: form,
      }),
    onSuccess: (r) => {
      const next = { ...r.schedule, folder: r.folder };
      setForm(next);
      setBaseline(JSON.stringify(next));
      refresh();
      toast.success(t("backup.auto.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });

  const keepValid = inRange(form.keepStartup, 1, 30) && inRange(form.keepWeekly, 1, 52);
  const chooseFolder = desktop()?.chooseFolder;

  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      data-testid="backup-schedule"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && keepValid && !save.isPending) save.mutate();
      }}
    >
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
          {t("backup.auto.title")}
          <HelpTip>{t("backup.auto.help")}</HelpTip>
        </h3>
        <p className="text-[12px] text-muted-foreground">{t("backup.auto.desc")}</p>
      </div>
      {!data.passphraseSet && (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-md bg-nov-likely/16 p-2 text-[12px] text-warning-text"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("backup.auto.noPass")}
        </p>
      )}
      <ToggleRow
        id="backup-auto"
        label={t("backup.auto.enabled")}
        hint={t("backup.auto.enabled.hint")}
        checked={form.auto}
        onChange={(v) => set("auto", v)}
      />
      <div className="grid gap-3 pl-1 sm:grid-cols-2">
        <ToggleRow
          id="backup-startup"
          label={t("backup.auto.onStartup")}
          hint={t("backup.auto.onStartup.hint")}
          checked={form.onStartup}
          disabled={!form.auto}
          onChange={(v) => set("onStartup", v)}
        />
        <ToggleRow
          id="backup-weekly"
          label={t("backup.auto.weekly")}
          hint={t("backup.auto.weekly.hint")}
          checked={form.weekly}
          disabled={!form.auto}
          onChange={(v) => set("weekly", v)}
        />
        <div className="flex flex-col items-start gap-1.5">
          <Label htmlFor="backup-keep-startup">{t("backup.auto.keepStartup")}</Label>
          <Input
            id="backup-keep-startup"
            type="number"
            inputMode="numeric"
            min={1}
            max={30}
            className="w-24"
            value={Number.isFinite(form.keepStartup) ? form.keepStartup : ""}
            onChange={(e) => set("keepStartup", e.target.valueAsNumber)}
            aria-invalid={!inRange(form.keepStartup, 1, 30)}
          />
        </div>
        <div className="flex flex-col items-start gap-1.5">
          <Label htmlFor="backup-keep-weekly">{t("backup.auto.keepWeekly")}</Label>
          <Input
            id="backup-keep-weekly"
            type="number"
            inputMode="numeric"
            min={1}
            max={52}
            className="w-24"
            value={Number.isFinite(form.keepWeekly) ? form.keepWeekly : ""}
            onChange={(e) => set("keepWeekly", e.target.valueAsNumber)}
            aria-invalid={!inRange(form.keepWeekly, 1, 52)}
          />
        </div>
      </div>
      {keepValid ? (
        <FieldHint>{t("backup.auto.keepHint")}</FieldHint>
      ) : (
        <FieldError>{t("backup.auto.keepInvalid")}</FieldError>
      )}
      <ToggleRow
        id="backup-secrets"
        label={t("backup.auto.includeSecrets")}
        hint={t("backup.auto.includeSecrets.hint")}
        checked={form.includeSecrets}
        onChange={(v) => set("includeSecrets", v)}
      />

      <div className="space-y-1.5">
        <Label htmlFor="backup-folder">{t("backup.folder.label")}</Label>
        {chooseFolder ? (
          <p
            id="backup-folder"
            className="truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-[12px]"
            title={form.folder ?? data.defaultFolder}
          >
            {form.folder ?? `${t("backup.folder.default")} · ${data.defaultFolder}`}
          </p>
        ) : (
          <Input
            id="backup-folder"
            spellCheck={false}
            autoComplete="off"
            placeholder={`${t("backup.folder.default")} · ${data.defaultFolder}`}
            aria-label={t("backup.folder.input")}
            value={form.folder ?? ""}
            onChange={(e) => set("folder", e.target.value.trim() === "" ? null : e.target.value)}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {chooseFolder && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void chooseFolder().then((p) => {
                  if (p) set("folder", p);
                })
              }
            >
              <FolderOpen /> {t("backup.folder.choose")}
            </Button>
          )}
          {form.folder !== null && (
            <Button type="button" size="sm" variant="ghost" onClick={() => set("folder", null)}>
              <Undo2 /> {t("backup.folder.reset")}
            </Button>
          )}
        </div>
        <FieldHint>{t("backup.folder.hint")}</FieldHint>
      </div>
      <SaveBar dirty={dirty} valid={keepValid} pending={save.isPending} />
    </form>
  );
}
