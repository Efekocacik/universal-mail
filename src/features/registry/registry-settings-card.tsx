"use client";

import { PreparingCard } from "@/features/settings/preparing-card";
import { t } from "@/lib/i18n";

/**
 * Ayarlar → Siciller: Companies House / INSEE aç-kapa, faaliyet kodları, pencere (gün), anahtarlar ve sınama.
 * P0 yer tutucusu; sahibi: paket R (ayarlar `registry.companiesHouse`, `registry.insee`).
 */
export function RegistrySettingsCard() {
  return (
    <PreparingCard title={t("registry.settings.title")} description={t("registry.settings.desc")} />
  );
}
