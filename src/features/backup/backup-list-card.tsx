"use client";

import { useMutation } from "@tanstack/react-query";
import { Archive, Download, FileUp, FolderOpen, History, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldHint } from "@/components/ui/input";
import type { BackupRow } from "@/lib/backup/shared";
import { api, errorText, localizeApiError } from "@/lib/client/api";
import { fmtDateTime, fmtNumber } from "@/lib/client/format";
import { t, type TrKey } from "@/lib/i18n";
import { desktop, fmtSize, useRefreshBackups, type BackupOverview } from "./data";
import { RestoreDialog, UPLOAD_MAX_MB, type RestoreSource } from "./restore-dialog";

const KIND: Record<BackupRow["kind"], TrKey> = {
  manual: "backup.kind.manual",
  startup: "backup.kind.startup",
  weekly: "backup.kind.weekly",
};

/** Başarısız satırın kodu → kısa kullanıcı metni (bilinmeyen/iç kodlarda genel metin). */
const failText = (code: string | null) =>
  localizeApiError(500, { code: code && /^BACKUP_/.test(code) ? code : "BACKUP_FAILED" }).message;

/**
 * Faz 6 (paket Y.8): yedek listesi ("Şimdi yedekle", indir, sil, listeden geri yükle) ve başka bir yerdeki yedeği açma
 * (masaüstünde "Dosya seç…", tarayıcıda dosya yükleme). Süren yedek varken düğme kilitli ve liste kendiliğinden
 * yenilenir. İndirilen dosya parolayla şifrelidir.
 */
export function BackupListCard({ data }: { data: BackupOverview }) {
  const refresh = useRefreshBackups();
  const [toDelete, setToDelete] = useState<BackupRow | null>(null);
  const [restore, setRestore] = useState<RestoreSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = data.backups.some((b) => b.status === "running");
  const blocked = data.pending !== null;

  const create = useMutation({
    mutationFn: () =>
      api<{ backup: BackupRow; secretsSkipped: number }>("/api/backups", {
        method: "POST",
        json: {},
      }),
    onSuccess: (r) => {
      refresh();
      if (r.secretsSkipped > 0)
        toast.warning(t("backup.now.skipped", { n: fmtNumber(r.secretsSkipped) }));
      else toast.success(t("backup.now.done"));
    },
    onError: (e: Error) => {
      refresh();
      toast.error(errorText(e));
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/backups/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      toast.success(t("backup.deleted"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const chooseFile = desktop()?.chooseBackupFile;

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="backup-list">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
            <Archive className="size-4 text-muted-foreground" aria-hidden />
            {t("backup.list.title")}
          </h3>
          <p className="text-[12px] text-muted-foreground">{t("backup.list.desc")}</p>
        </div>
        <Button
          onClick={() => create.mutate()}
          loading={create.isPending || running}
          disabled={!data.passphraseSet || running || blocked}
          aria-describedby={!data.passphraseSet ? "backup-now-hint" : undefined}
        >
          {t("backup.now")}
        </Button>
      </div>
      {!data.passphraseSet && (
        <FieldHint id="backup-now-hint">{t("apiError.BACKUP_PASSPHRASE_REQUIRED")}</FieldHint>
      )}

      {data.backups.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-center text-[13px] text-muted-foreground">
          {t("backup.list.empty")}
        </p>
      ) : (
        <div className="um-scroll max-h-80 overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">{t("backup.col.date")}</th>
                <th className="py-1 font-medium">{t("backup.col.kind")}</th>
                <th className="py-1 text-right font-medium">{t("backup.col.size")}</th>
                <th className="py-1 pl-3 text-right font-medium">{t("backup.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => {
                const usable = b.status === "ok" && b.fileExists;
                return (
                  <tr key={b.id} className="border-t align-middle" data-testid="backup-row">
                    <td className="py-1.5 tabular-nums">
                      <span title={b.fileName}>{fmtDateTime(b.createdAt)}</span>
                    </td>
                    <td className="py-1.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline">{t(KIND[b.kind])}</Badge>
                        {b.status === "running" && (
                          <Badge variant="info">{t("backup.status.running")}</Badge>
                        )}
                        {b.status === "failed" && (
                          <Badge variant="danger" title={failText(b.errorCode)}>
                            {t("backup.status.failed")}
                          </Badge>
                        )}
                        {b.status === "ok" && !b.fileExists && (
                          <Badge variant="warning">{t("backup.list.missing")}</Badge>
                        )}
                        {b.status === "ok" && b.includesSecrets && (
                          <Badge variant="default">{t("backup.list.secrets")}</Badge>
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{fmtSize(b.sizeBytes)}</td>
                    <td className="py-1.5 pl-3">
                      <span className="flex justify-end gap-1">
                        {usable && (
                          <Button asChild size="sm" variant="ghost">
                            <a
                              href={`/api/backups/${b.id}/download`}
                              download={b.fileName}
                              aria-label={`${t("backup.download")}: ${fmtDateTime(b.createdAt)}`}
                            >
                              <Download /> {t("backup.download")}
                            </a>
                          </Button>
                        )}
                        {usable && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={blocked}
                            onClick={() =>
                              setRestore({
                                kind: "backup",
                                id: b.id,
                                label: `${fmtDateTime(b.createdAt)} · ${b.fileName}`,
                              })
                            }
                          >
                            <History /> {t("backup.restore.this")}
                          </Button>
                        )}
                        {b.status !== "running" && (
                          <Button
                            size="icon"
                            variant="dangerGhost"
                            aria-label={`${t("common.delete")}: ${fmtDateTime(b.createdAt)}`}
                            onClick={() => setToDelete(b)}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.preMigrateCount > 0 && (
        <FieldHint>{t("backup.list.preMigrate", { n: fmtNumber(data.preMigrateCount) })}</FieldHint>
      )}

      <div className="space-y-2 border-t pt-3" data-testid="backup-restore-other">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
          <History className="size-4 text-muted-foreground" aria-hidden />
          {t("backup.restore.title")}
        </h3>
        <p className="text-[12px] text-muted-foreground">{t("backup.restore.otherHint")}</p>
        <p className="text-[12px] text-muted-foreground">
          {t("backup.restore.uploadLimit", { mb: fmtNumber(UPLOAD_MAX_MB) })}
        </p>
        <div className="flex flex-wrap gap-2">
          {chooseFile && (
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={() =>
                void chooseFile().then((p) => {
                  if (p) setRestore({ kind: "path", path: p, label: p });
                })
              }
            >
              <FolderOpen /> {t("backup.restore.chooseFile")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp /> {t("backup.restore.upload")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".umbk"
            className="sr-only"
            tabIndex={-1}
            aria-label={t("backup.restore.upload")}
            data-testid="backup-upload"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) setRestore({ kind: "upload", file: f, label: f.name });
            }}
          />
        </div>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        tone="danger"
        title={t("backup.delete.title")}
        description={t("backup.delete.body", { name: toDelete?.fileName ?? "" })}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (toDelete) await remove.mutateAsync(toDelete.id);
        }}
      />
      <RestoreDialog source={restore} onClose={() => setRestore(null)} />
    </div>
  );
}
