"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
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
import { FieldError, Input, Label } from "@/components/ui/input";
import { HelpTip } from "@/components/ui/tooltip";
import { api, errorText } from "@/lib/client/api";
import { t } from "@/lib/i18n";
import { wipePhraseMatches } from "@/lib/lifecycle/wipe-phrase";
import { useRefreshBackups } from "./data";

/**
 * Faz 6 (paket Y.8/Y.6): "Tüm verilerimi sil" tehlike alanı. Onay ifadesi yazılmadan düğme açılmaz (sunucu da aynı
 * kuralı denetler). Silme hemen yapılmaz, yeniden başlatmada uygulanır; o zamana kadar bant üzerinden iptal edilebilir.
 */
export function WipeCard({ blocked }: { blocked: boolean }) {
  const refresh = useRefreshBackups();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = wipePhraseMatches(phrase);

  const schedule = useMutation({
    mutationFn: () =>
      api("/api/data/wipe", { method: "POST", json: { confirm: phrase, deleteBackups } }),
    onSuccess: () => {
      setOpen(false);
      refresh();
      toast.success(t("backup.wipe.scheduled"));
    },
    onError: (e: Error) => setError(errorText(e)),
  });

  const openDialog = () => {
    setPhrase("");
    setDeleteBackups(false);
    setError(null);
    setOpen(true);
  };

  return (
    <div
      className="space-y-2 rounded-lg border border-destructive/40 p-3"
      data-testid="backup-wipe"
    >
      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-destructive">
        <AlertTriangle className="size-4" aria-hidden />
        {t("backup.wipe.title")}
        <HelpTip>{t("backup.wipe.help")}</HelpTip>
      </h3>
      <p className="text-[12px] text-muted-foreground">{t("backup.wipe.desc")}</p>
      <Button size="sm" variant="dangerOutline" disabled={blocked} onClick={openDialog}>
        {t("backup.wipe.open")}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !schedule.isPending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span
                className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                aria-hidden
              >
                <AlertTriangle className="size-5" />
              </span>
              <div className="space-y-1.5">
                <DialogTitle>{t("backup.wipe.dialog.title")}</DialogTitle>
                <DialogDescription>
                  {t("backup.wipe.dialog.body", { phrase: t("backup.wipe.phrase") })}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <form
            id="wipe-form"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (matches && !schedule.isPending) schedule.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="wipe-phrase">{t("backup.wipe.input")}</Label>
              <Input
                id="wipe-phrase"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("backup.wipe.phrase")}
                value={phrase}
                onChange={(e) => {
                  setPhrase(e.target.value);
                  setError(null);
                }}
                aria-invalid={phrase !== "" && !matches}
                aria-describedby={error ? "wipe-error" : undefined}
              />
            </div>
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="wipe-backups"
                checked={deleteBackups}
                onCheckedChange={(v) => setDeleteBackups(v === true)}
                aria-describedby="wipe-backups-hint"
                className="mt-0.5"
              />
              <div>
                <label htmlFor="wipe-backups" className="text-[13px] font-medium">
                  {t("backup.wipe.deleteBackups")}
                </label>
                <p id="wipe-backups-hint" className="text-[12px] text-muted-foreground">
                  {t("backup.wipe.deleteBackups.hint")}
                </p>
              </div>
            </div>
            {error && <FieldError id="wipe-error">{error}</FieldError>}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={schedule.isPending}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              form="wipe-form"
              variant="destructive"
              disabled={!matches}
              loading={schedule.isPending}
            >
              {t("backup.wipe.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
