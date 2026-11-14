"use client";

import { PreparingCard } from "@/features/settings/preparing-card";
import { t } from "@/lib/i18n";

/**
 * Ayarlar → Açılma izleme: aç/kapa, gizlilik notu onayı ("açılma verisi kesin değildir"), yalnızca demo notu.
 * P0 yer tutucusu; sahibi: paket T (ayar `tracking.opens`).
 */
export function OpenTrackingCard() {
  return (
    <PreparingCard title={t("tracking.settings.title")} description={t("tracking.settings.desc")} />
  );
}
