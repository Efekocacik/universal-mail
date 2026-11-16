"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RotateCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { LifecyclePending } from "@/lib/backup/shared";
import { api, errorText } from "@/lib/client/api";
import { fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";
import type { LifecycleResult } from "@/lib/lifecycle/pending";
import { desktop, useRefreshBackups } from "./data";

/**
 * Faz 6 (paket Y.8): yeniden başlatmayı bekleyen işlem (geri yükleme / verileri silme) bandı ve son uygulanan işlemin
 * sonucu. Masaüstünde "Şimdi yeniden başlat" uygulamayı güvenle kapatıp açar; tarayıcıda kapatıp açma yönergesi
 * gösterilir. İptal idempotenttir.
 */
export function PendingBanner({ pending }: { pending: LifecyclePending }) {
  const refresh = useRefreshBackups();
  const [restarting, setRestarting] = useState(false);
  const cancel = useMutation({
    mutationFn: () => api<{ cancelled: boolean }>("/api/data/pending", { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      toast.success(t("backup.pending.cancelled"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const relaunch = desktop()?.relaunch;
  const wipe = pending.kind === "wipe";
  return (
    <div
      role="status"
      data-testid="lifecycle-pending"
      className={`space-y-2 rounded-lg border p-3 ${wipe ? "border-destructive/40 bg-destructive/5" : "border-info/40 bg-info/5"}`}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <RotateCw className="size-4 shrink-0" aria-hidden />
        {t(wipe ? "backup.pending.wipe.title" : "backup.pending.restore.title")}
      </p>
      <p className="text-[13px]">
        {t(wipe ? "backup.pending.wipe.body" : "backup.pending.restore.body")}
        {wipe && (
          <>
            {" "}
            {t(
              pending.deleteBackups
                ? "backup.pending.wipe.backups"
                : "backup.pending.wipe.keepBackups",
            )}
          </>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {relaunch ? (
          <Button
            size="sm"
            variant={wipe ? "destructive" : "default"}
            loading={restarting}
            onClick={() => {
              setRestarting(true);
              void relaunch().catch(() => setRestarting(false));
            }}
          >
            {t("backup.restart")}
          </Button>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("backup.restart.manual")}</span>
        )}
        <Button
          size="sm"
          variant="outline"
          loading={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t("backup.pending.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Son geri yükleme/silme sonucu (bir kez gösterilir; "Tamam" ile kapanır). */
export function ResultBanner({ result }: { result: LifecycleResult }) {
  const refresh = useRefreshBackups();
  const dismiss = useMutation({
    mutationFn: () => api("/api/data/result", { method: "DELETE" }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const text =
    result.kind === "restore"
      ? result.ok
        ? t(result.secretsRestored ? "backup.result.restore.okSecrets" : "backup.result.restore.ok")
        : t("backup.result.restore.fail")
      : result.ok
        ? t("backup.result.wipe.ok")
        : t("backup.result.wipe.partial");
  // Geri yüklemeden sonra yapılan güvenlik adımları (yalnızca olanlar gösterilir).
  const notes: string[] = [];
  if (result.kind === "restore" && result.ok) {
    if (result.campaignsPaused)
      notes.push(t("backup.result.restore.paused", { n: fmtNumber(result.campaignsPaused) }));
    if (result.suppressionsKept)
      notes.push(t("backup.result.restore.kept", { n: fmtNumber(result.suppressionsKept) }));
    if (result.sequencesStopped)
      notes.push(t("backup.result.restore.stopped", { n: fmtNumber(result.sequencesStopped) }));
    if (result.folderReset) notes.push(t("backup.result.restore.folderReset"));
    if (result.carryFailed) notes.push(t("backup.result.restore.carryFailed"));
  }
  const warn = !result.ok || !!result.carryFailed;
  const Icon = warn ? CircleAlert : CheckCircle2;
  return (
    <div
      role="status"
      data-testid="lifecycle-result"
      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-[13px] ${warn ? "border-destructive/40 bg-destructive/5" : "border-success/40 bg-success/5"}`}
    >
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <Icon
          className={`mt-0.5 size-4 shrink-0 ${warn ? "text-destructive" : "text-success"}`}
          aria-hidden
        />
        <span className="space-y-1">
          <span className="block">{text}</span>
          {notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4" data-testid="lifecycle-result-notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        loading={dismiss.isPending}
        onClick={() => dismiss.mutate()}
      >
        {t("backup.result.dismiss")}
      </Button>
    </div>
  );
}
