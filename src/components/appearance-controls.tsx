"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Segmented } from "@/components/ui/segmented";
import { api, errorText } from "@/lib/client/api";
import {
  hasUnsavedChanges,
  requestFocusAfterRemount,
  takeFocusAfterRemount,
} from "@/lib/client/locale-switch";
import { qk } from "@/lib/client/queries";
import { THEME_PREFS, type ThemePref } from "@/lib/client/theme";
import type { AppConfig } from "@/lib/client/types";
import { t, type Locale } from "@/lib/i18n";
import { useThemePref } from "./providers";

type Patch = { "ui.language"?: Locale; "ui.theme"?: ThemePref };

/**
 * Dil/tema değişikliği: yapılandırma önbelleği HEMEN güncellenir (arayüz anında değişir), ardından ayar kaydedilir;
 * hata olursa önceki değer geri yüklenir ve yerelleştirilmiş hata gösterilir. Masaüstünde ana süreç de bilgilendirilir
 * (providers.tsx ThemeSync). Aynı değeri yeniden kaydetmek zararsızdır (idempotent PUT).
 */
export function useUiPrefMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Patch) => api("/api/settings", { method: "PUT", json: patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.config });
      const prev = qc.getQueryData<AppConfig>(qk.config);
      if (prev)
        qc.setQueryData<AppConfig>(qk.config, {
          ...prev,
          ...(patch["ui.language"] ? { language: patch["ui.language"] } : {}),
          ...(patch["ui.theme"] ? { theme: patch["ui.theme"] } : {}),
        });
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.config, ctx.prev);
      toast.error(errorText(e));
    },
    onSuccess: (_d, patch) => {
      // Dil değişince alt ağaç yeni dilde yeniden kurulur; bildirim yeni dilde gösterilir.
      toast.success(
        patch["ui.language"]
          ? t("settings.language.changed", {}, patch["ui.language"])
          : t("settings.theme.changed"),
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.config });
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
  });
}

/** Dil seçenekleri her zaman KENDİ dillerinde yazılır: yanlışlıkla dil değiştiren kullanıcı yolunu bulabilir. */
export const LANGUAGE_OPTIONS = [
  { value: "tr", label: "Türkçe", lang: "tr" },
  { value: "en", label: "English", lang: "en" },
] as const satisfies readonly { value: Locale; label: string; lang: string }[];

/**
 * Dil seçici. Dil değişince arayüz yeni dilde yeniden kurulur (providers.tsx); bu sırada AYNI sayfadaki kaydedilmemiş
 * form değişiklikleri kaybolacağından önce onay istenir (`useUnsavedChanges` ile bildiren formlar). Kurulum sihirbazı
 * taslağını kendisi taşır (`useCarryOver`), onay gerekmez. Klavyeyle seçildiyse odak yeni dilde yine bu gruba döner.
 */
export function LanguageSwitch({ value, className }: { value: Locale; className?: string }) {
  const save = useUiPrefMutation();
  const [pending, setPending] = useState<Locale | null>(null);
  const apply = (v: Locale) => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.closest('[data-testid="language-switch"]'))
      requestFocusAfterRemount();
    save.mutate({ "ui.language": v });
  };
  return (
    <>
      <Segmented
        value={value}
        options={LANGUAGE_OPTIONS}
        label={t("settings.language")}
        disabled={save.isPending}
        onChange={(v) => (hasUnsavedChanges() ? setPending(v) : apply(v))}
        className={className}
        testId="language-switch"
        focusOnMount={takeFocusAfterRemount}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        tone="warning"
        title={t("settings.language.unsaved.title")}
        description={t("settings.language.unsaved.body")}
        confirmLabel={t("settings.language.unsaved.confirm")}
        cancelLabel={t("settings.language.unsaved.cancel")}
        onConfirm={() => {
          if (pending) apply(pending);
        }}
      />
    </>
  );
}

export function ThemeSwitch({ className }: { className?: string }) {
  const save = useUiPrefMutation();
  const pref = useThemePref();
  return (
    <Segmented
      value={pref}
      options={THEME_PREFS.map((p) => ({ value: p, label: t(`settings.theme.${p}`) }))}
      label={t("settings.theme")}
      disabled={save.isPending}
      onChange={(v) => save.mutate({ "ui.theme": v })}
      className={className}
      testId="theme-switch"
    />
  );
}
