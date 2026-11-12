import type { TrKey } from "./tr";
import { base } from "./en/base";
import { core } from "./en/core";
import { dashboard } from "./en/dashboard";
import { explore } from "./en/explore";
import { notifications } from "./en/notifications";
import { outreach } from "./en/outreach";
import { scan } from "./en/scan";

/**
 * İngilizce sözlük (NFR-09). Türkçe parçalarla aynı adlı parçalardan birleştirilir. `base` ve `core` TAM çevrilidir
 * (türü her anahtarı zorunlu kılar; `tests/i18n-en-parity.test.ts`). Diğer parçalar kendi paketlerince doldurulur;
 * olmayan anahtar `t()` içinde Türkçeye düşer ve `tests/i18n.test.ts` kapsam raporunda listelenir. Tüm parçalar
 * tamamlanınca tür `Record<TrKey, string>` yapılır.
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
