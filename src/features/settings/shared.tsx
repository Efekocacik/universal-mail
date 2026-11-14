"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/tooltip";
import { api, errorText } from "@/lib/client/api";
import { useUnsavedChanges } from "@/lib/client/locale-switch";
import { qk } from "@/lib/client/queries";
import type { PublicSecretName, SecretInfo } from "@/lib/client/types";
import { t, type TrKey } from "@/lib/i18n";

/**
 * Ayarlar ekranının ortak yapı taşları (Faz 5 P0'da settings-page.tsx'ten DAVRANIŞ DEĞİŞMEDEN taşındı): bölüm kartı,
 * satır içi hata, kaydetme çubuğu, anahtar satırı ve gizli anahtar satırı. Faz 5 paketlerinin ayar kartları
 * (sicil, yapay zekâ, harici e-posta, açılma izleme) bunları kullanır; böylece settings-page.tsx'e dokunmazlar.
 */

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => {
    for (const key of [qk.settings, qk.config, qk.status, qk.budget, qk.categories])
      void qc.invalidateQueries({ queryKey: key });
  };
}

export function useSave() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api("/api/settings", { method: "PUT", json: patch }),
    onSuccess: () => {
      invalidate();
      toast.success(t("common.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
}

export function Section({
  title,
  description,
  help,
  children,
}: {
  title: string;
  description?: string;
  /** "Bu nedir?" balonu (yalnızca karmaşık kavramlarda; docs/07 §FR-UI-07). */
  help?: TrKey;
  children: React.ReactNode;
}) {
  return (
    <Card className="um-enter">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          {title}
          {help && <HelpTip>{t(help)}</HelpTip>}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 pt-3">{children}</CardContent>
    </Card>
  );
}

/** Satır içi hata: kırmızı metin + simge (renk tek başına anlam taşımaz). */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[12px] text-destructive">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** Tek tip kaydetme çubuğu: değişiklik yoksa soluk "Değişiklik yok", varsa yeşil Kaydet. */
export function SaveBar({
  dirty,
  valid = true,
  pending,
  onSave,
  type = "submit",
}: {
  dirty: boolean;
  valid?: boolean;
  pending: boolean;
  onSave?: () => void;
  type?: "submit" | "button";
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type={type} onClick={onSave} disabled={!dirty || !valid} loading={pending}>
        {t("common.save")}
      </Button>
      <span className="text-[12px] text-muted-foreground" aria-live="polite">
        {dirty ? t("settings.unsaved") : t("settings.noChange")}
      </span>
    </div>
  );
}

export function ToggleRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}

export function SecretRow({
  name,
  label,
  help,
  info,
  testable,
}: {
  name: PublicSecretName;
  label: string;
  help: string;
  info: SecretInfo;
  testable?: boolean;
}) {
  const invalidate = useInvalidateAll();
  const [value, setValue] = useState("");
  useUnsavedChanges(value.trim() !== "");
  const [shown, setShown] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const save = useMutation({
    mutationFn: () => api("/api/secrets", { method: "POST", json: { name, value } }),
    onSuccess: () => {
      setValue("");
      setShown(false);
      setResult(null);
      invalidate();
      toast.success(t("settings.key.saved"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/secrets?name=${name}`, { method: "DELETE" }),
    onSuccess: () => {
      setResult(null);
      invalidate();
      toast.success(t("settings.key.removed"));
    },
    onError: (e: Error) => toast.error(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>("/api/setup/test-places", { method: "POST" }),
    onSuccess: setResult,
    onError: (e: Error) => setResult({ ok: false, message: errorText(e) }),
  });

  const trimmed = value.trim();
  const tooShort = value.length > 0 && trimmed.length < 8;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={name} className="flex items-center gap-1.5">
          <KeyRound className="size-3.5" aria-hidden /> {label}
        </Label>
        {info.set ? (
          <Badge variant="success">
            <Check className="size-3" aria-hidden />
            {t("settings.key.set")} · {info.masked}
            {info.source === "env" ? ` · ${t("settings.key.fromEnv")}` : ""}
          </Badge>
        ) : (
          <Badge variant="warning">
            <CircleAlert className="size-3" aria-hidden />
            {t("settings.key.missing")}
          </Badge>
        )}
      </div>
      <p className="text-[12px] text-muted-foreground">{help}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length >= 8 && !save.isPending) save.mutate();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Input
            id={name}
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={info.set ? t("settings.key.replace") : t("settings.key.paste")}
            aria-invalid={tooShort}
            aria-describedby={tooShort ? `${name}-err` : undefined}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-0.5 right-0.5 size-8"
            aria-label={shown ? t("settings.key.hide") : t("settings.key.show")}
            aria-pressed={shown}
            onClick={() => setShown((v) => !v)}
          >
            {shown ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        <Button type="submit" disabled={trimmed.length < 8} loading={save.isPending}>
          {t("common.save")}
        </Button>
        {info.set && info.source === "store" && (
          <Button
            type="button"
            variant="dangerGhost"
            size="icon"
            aria-label={`${t("common.delete")}: ${label}`}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 />
          </Button>
        )}
      </form>
      {tooShort && <FieldError id={`${name}-err`}>{t("settings.key.tooShort")}</FieldError>}
      {testable && (
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            disabled={!info.set}
            loading={test.isPending}
          >
            {!test.isPending && <FlaskConical />} {t("settings.key.test")}
          </Button>
          {result && (
            <p
              className={`flex items-start gap-1.5 text-[13px] ${result.ok ? "text-success" : "text-destructive"}`}
              role="status"
            >
              {result.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}{" "}
              {result.message}
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        tone="danger"
        title={t("settings.key.remove.title")}
        description={t("settings.key.remove.body")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
      />
    </div>
  );
}
