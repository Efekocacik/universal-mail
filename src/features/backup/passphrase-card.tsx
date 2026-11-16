"use client";

import { useMutation } from "@tanstack/react-query";
import { Check, CircleAlert, Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError, FieldHint, Input, Label } from "@/components/ui/input";
import { normalizePassphrase, PASSPHRASE_MIN, passphraseStrength } from "@/lib/backup/passphrase";
import { api, errorText } from "@/lib/client/api";
import { useUnsavedChanges } from "@/lib/client/locale-switch";
import { t, type TrKey } from "@/lib/i18n";
import { useRefreshBackups } from "./data";

const STRENGTH: TrKey[] = [
  "backup.pass.strength.weakest",
  "backup.pass.strength.weak",
  "backup.pass.strength.good",
  "backup.pass.strength.strong",
];

/**
 * Faz 6 (paket Y.8): yedek parolası (ayarla/değiştir, göster/gizle, güç ipucu). Parola sunucuda gizli bilgi deposunda
 * tutulur ve hiçbir yanıtta dönmez; burada yalnızca "ayarlı / yok" görünür. Kural sunucudadır (10–256 karakter, hepsi
 * aynı değil); arayüz aynı kuralı önceden gösterir.
 */
export function PassphraseCard({ isSet }: { isSet: boolean }) {
  const refresh = useRefreshBackups();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  useUnsavedChanges(pass !== "" || confirm !== "");

  const save = useMutation({
    mutationFn: () =>
      api("/api/backups/passphrase", { method: "PUT", json: { passphrase: pass, confirm } }),
    onSuccess: () => {
      setPass("");
      setConfirm("");
      setShown(false);
      refresh();
      toast.success(t("backup.pass.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });

  const n = normalizePassphrase(pass);
  const strength = passphraseStrength(pass);
  const tooShort = pass !== "" && [...n].length < PASSPHRASE_MIN;
  const mismatch = confirm !== "" && normalizePassphrase(confirm) !== n;
  const valid = pass !== "" && !tooShort && strength > 0 && confirm !== "" && !mismatch;

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="backup-passphrase">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-1.5 text-[13px] font-medium">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            {t("backup.pass.title")}
          </h3>
          <p className="text-[12px] text-muted-foreground">{t("backup.pass.desc")}</p>
        </div>
        {isSet ? (
          <Badge variant="success">
            <Check className="size-3" aria-hidden /> {t("backup.pass.set")}
          </Badge>
        ) : (
          <Badge variant="warning">
            <CircleAlert className="size-3" aria-hidden /> {t("backup.pass.missing")}
          </Badge>
        )}
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !save.isPending) save.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="backup-pass">{t("backup.pass.new")}</Label>
          <div className="relative">
            <Input
              id="backup-pass"
              type={shown ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              aria-invalid={tooShort}
              aria-describedby="backup-pass-hint"
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
          <FieldHint id="backup-pass-hint">
            {t("backup.pass.rule")}
            {pass !== "" && (
              <span aria-live="polite">
                {" · "}
                {t("backup.pass.strength", { level: t(STRENGTH[strength]!) })}
              </span>
            )}
          </FieldHint>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="backup-pass-confirm">{t("backup.pass.confirm")}</Label>
          <Input
            id="backup-pass-confirm"
            type={shown ? "text" : "password"}
            autoComplete="new-password"
            spellCheck={false}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch}
            aria-describedby={mismatch ? "backup-pass-mismatch" : undefined}
          />
          {mismatch && (
            <FieldError id="backup-pass-mismatch">{t("backup.pass.mismatch")}</FieldError>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={!valid} loading={save.isPending}>
            {t("backup.pass.save")}
          </Button>
          {isSet && <FieldHint>{t("backup.pass.changeWarn")}</FieldHint>}
        </div>
      </form>
    </div>
  );
}
