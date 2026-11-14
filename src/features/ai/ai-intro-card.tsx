"use client";

import { PreparingCard } from "@/features/settings/preparing-card";
import { t } from "@/lib/i18n";

/**
 * Ayarlar → Yapay zekâ: Claude anahtarı, model seçimi (Opus 5.5 varsayılan, Haiku 5.5 daha ucuz), maliyet notu ve onayı,
 * sınama, bu ayki kullanım. P0 yer tutucusu; sahibi: paket A (ayar `ai.intro`, gizli ad `anthropic.apiKey`).
 */
export function AiIntroCard() {
  return <PreparingCard title={t("ai.settings.title")} description={t("ai.settings.desc")} />;
}
