"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/misc";
import { Notice } from "@/features/campaigns/parts";
import { Section, ToggleRow, useSave } from "@/features/settings/shared";
import { fmtDateTime } from "@/lib/client/format";
import { useSettings } from "@/lib/client/queries";
import { t } from "@/lib/i18n";

/**
 * Ayarlar → Açılma izleme (Faz 5, ayar `tracking.opens`). Varsayılan KAPALI.
 *  - Açmak her zaman onay penceresinden geçer ("açılma verisi kesin değildir"); onay anı `ackAt` olarak kaydedilir
 *    (sunucu şeması onaysız açmayı 400 `VALIDATION` ile reddeder).
 *  - Kapatmak onaysızdır ve hemen kaydedilir; önceki onay anı saklanır (denetim için).
 *  - Hukuki not ve "yalnızca demo" notu her zaman görünür: canlı iletilere piksel eklenmez.
 */
export function OpenTrackingCard() {
  const settings = useSettings();
  const save = useSave();
  const [confirm, setConfirm] = useState(false);
  const value = settings.data?.settings["tracking.opens"] ?? { enabled: false, ackAt: null };

  return (
    <Section title={t("tracking.settings.title")} description={t("tracking.settings.desc")}>
      {settings.isLoading ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : (
        <>
          <ToggleRow
            id="tracking-opens"
            label={t("tracking.toggle")}
            hint={t("tracking.toggle.hint")}
            checked={value.enabled}
            disabled={save.isPending || settings.isError}
            onChange={(on) => {
              if (on) setConfirm(true);
              else save.mutate({ "tracking.opens": { enabled: false, ackAt: value.ackAt } });
            }}
          />
          <p
            className="text-[12px] text-muted-foreground"
            aria-live="polite"
            data-testid="tracking-state"
          >
            {value.enabled
              ? t("tracking.state.on", { at: fmtDateTime(value.ackAt) })
              : t("tracking.state.off")}
          </p>
          {/* Sabit not: `role="alert"` (uyarı tonu) sayfa açılışında okunmasın diye bilgi tonu. */}
          <Notice>{t("tracking.legal")}</Notice>
          <Notice>{t("tracking.demoOnly")}</Notice>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="warning"
        title={t("tracking.confirm.title")}
        description={t("tracking.confirm.body")}
        confirmLabel={t("tracking.confirm.ok")}
        pending={save.isPending}
        onConfirm={async () => {
          await save.mutateAsync({ "tracking.opens": { enabled: true, ackAt: Date.now() } });
        }}
      />
    </Section>
  );
}
