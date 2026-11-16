"use client";

import { useMutation } from "@tanstack/react-query";
import { CircleAlert, DatabaseBackup, Eye, EyeOff, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { api, ApiError, errorText } from "@/lib/client/api";
import { fmtDateTime, fmtNumber, fmtRelativeDays } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import { useRefreshBackups, type VerifyResponse } from "./data";

/** Geri yüklenecek yedeğin kaynağı: listedeki satır, masaüstünde seçilen dosya veya yüklenen dosya. */
export type RestoreSource =
  | { kind: "backup"; id: number; label: string }
  | { kind: "path"; path: string; label: string }
  | { kind: "upload"; file: File; label: string };

function verify(source: RestoreSource, passphrase: string): Promise<VerifyResponse> {
  const url = "/api/backups/restore/verify";
  if (source.kind === "upload") {
    const form = new FormData();
    form.set("file", source.file, source.file.name);
    form.set("passphrase", passphrase);
    return api<VerifyResponse>(url, { method: "POST", body: form });
  }
  const json =
    source.kind === "backup"
      ? { backupId: source.id, passphrase }
      : { path: source.path, passphrase };
  return api<VerifyResponse>(url, { method: "POST", json });
}

/**
 * Faz 6 (paket Y.8): geri yükleme penceresi. 1) yedeğin parolası → "Yedeği denetle" (şifre çözülür, bütünlük ve sürüm
 * denetlenir, hazırlanır); 2) özet (kaç işletme/kampanya, ne zaman, hangi sürüm, gerekirse "açılışta güncellenecek"),
 * anahtarları da geri yükleme seçimi ve açık onay kutusu → "Geri yüklemeyi başlat" (yeniden başlatmada uygulanır).
 * Pencere özet adımında kapatılırsa hazırlık silinir.
 */
export function RestoreDialog({
  source,
  onClose,
}: {
  source: RestoreSource | null;
  onClose: () => void;
}) {
  const refresh = useRefreshBackups();
  const [pass, setPass] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<VerifyResponse | null>(null);
  const [withSecrets, setWithSecrets] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    // Yeni kaynak = temiz pencere.
    setPass("");
    setShown(false);
    setError(null);
    setStage(null);
    setWithSecrets(true);
    setConfirmed(false);
  }, [source]);

  const check = useMutation({
    mutationFn: () => verify(source!, pass),
    onSuccess: (r) => {
      setStage(r);
      setPass("");
      setError(null);
    },
    onError: (e: Error) => setError(errorText(e)),
  });
  const schedule = useMutation({
    mutationFn: () =>
      api("/api/backups/restore", {
        method: "POST",
        json: {
          stageId: stage!.stageId,
          confirm: true,
          restoreSecrets: withSecrets && stage!.hasSecrets,
        },
      }),
    onSuccess: () => {
      setStage(null);
      refresh();
      toast.success(t("backup.restore.scheduled"));
      onClose();
    },
    onError: (e: Error) => {
      setError(errorText(e));
      // Hazırlığın süresi dolduysa parola adımına dönülür (yeniden denetlenebilsin).
      if (e instanceof ApiError && e.code === "RESTORE_STAGE_NOT_FOUND") setStage(null);
    },
  });

  const close = () => {
    // Planlanmamış hazırlık sunucuda bekletilmez (iptal idempotent; hata yok sayılır).
    if (stage)
      void api(`/api/backups/restore/${stage.stageId}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    onClose();
  };

  const s = stage?.summary;
  return (
    <Dialog open={source !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby="restore-desc">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseBackup className="size-5 text-muted-foreground" aria-hidden />
            {t("backup.restore.dialog.title")}
          </DialogTitle>
          <DialogDescription id="restore-desc" className="break-all font-mono text-[12px]">
            {source?.label}
          </DialogDescription>
        </DialogHeader>

        {!stage ? (
          <form
            id="restore-verify"
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (pass.trim() && !check.isPending) check.mutate();
            }}
          >
            <Label htmlFor="restore-pass">{t("backup.restore.dialog.passphrase")}</Label>
            <div className="relative">
              <Input
                id="restore-pass"
                type={shown ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? "restore-error" : "restore-pass-hint"}
                className="pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-0.5 right-0.5 size-8"
                aria-label={shown ? t("backup.pass.hide") : t("backup.pass.show")}
                aria-pressed={shown}
                onClick={() => setShown((v) => !v)}
              >
                {shown ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <FieldHint id="restore-pass-hint">{t("backup.restore.dialog.passHint")}</FieldHint>
          </form>
        ) : (
          <div className="space-y-3" data-testid="restore-summary">
            <div className="rounded-lg border bg-muted/30 p-3 text-[13px]">
              <p className="font-medium">
                {t("backup.restore.summary", {
                  leads: fmtNumber(s!.counts.leads),
                  campaigns: fmtNumber(s!.counts.campaigns),
                  messages: fmtNumber(s!.counts.messages),
                  templates: fmtNumber(s!.counts.templates),
                })}
              </p>
              <p className="text-muted-foreground">
                {t("backup.restore.summaryMeta", {
                  date: fmtDateTime(s!.createdAt),
                  ago: fmtRelativeDays(s!.createdAt),
                  version: s!.appVersion,
                })}
              </p>
            </div>
            <p className="flex items-start gap-1.5 text-[12px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t("backup.restore.desc")}
            </p>
            {stage.migrationNeeded && <FieldHint>{t("backup.restore.migration")}</FieldHint>}
            {stage.hasSecrets && (
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="restore-secrets"
                  checked={withSecrets}
                  onCheckedChange={(v) => setWithSecrets(v === true)}
                  aria-describedby="restore-secrets-hint"
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="restore-secrets" className="text-[13px] font-medium">
                    {t("backup.restore.secrets")}
                  </label>
                  <p id="restore-secrets-hint" className="text-[12px] text-muted-foreground">
                    {t("backup.restore.secrets.hint")}
                  </p>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="restore-confirm"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
                className="mt-0.5"
              />
              <label htmlFor="restore-confirm" className="text-[13px]">
                {t("backup.restore.confirm")}
              </label>
            </div>
            <FieldHint>{t("backup.restore.expires")}</FieldHint>
          </div>
        )}

        {error && (
          <FieldError id="restore-error" className="flex items-start gap-1.5">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </FieldError>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={close}
            disabled={check.isPending || schedule.isPending}
          >
            {t("common.cancel")}
          </Button>
          {!stage ? (
            <Button
              type="submit"
              form="restore-verify"
              disabled={!pass.trim()}
              loading={check.isPending}
            >
              {t("backup.restore.verify")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={!confirmed}
              loading={schedule.isPending}
              onClick={() => schedule.mutate()}
            >
              {t("backup.restore.schedule")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
