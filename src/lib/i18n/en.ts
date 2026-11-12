import type { TrKey } from "./tr";
import { base } from "./en/base";
import { core } from "./en/core";
import { dashboard } from "./en/dashboard";
import { explore } from "./en/explore";
import { notifications } from "./en/notifications";
import { outreach } from "./en/outreach";
import { scan } from "./en/scan";

/**
 * İngilizce sözlük (NFR-09). Türkçe parçalarla aynı adlı parçalardan birleştirilir. Şimdilik KISMİ: olmayan anahtar
 * `t()` içinde Türkçeye düşer; eksikler `tests/i18n.test.ts` kapsam raporunda listelenir (Paket D tamamlayınca rapor
 * katı moda alınır ve tür `Record<TrKey, string>` olur).
 */
export const en: Partial<Record<TrKey, string>> = {
  ...base,
  ...core,
  ...scan,
  ...notifications,
  ...explore,
  ...outreach,
  ...dashboard,
};

/** Parça adı → İngilizce parça (kapsam raporu için). */
export const EN_FRAGMENTS = {
  base,
  core,
  scan,
  notifications,
  explore,
  outreach,
  dashboard,
} as const;
