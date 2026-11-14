import type { TrKey } from "./tr";
import { base } from "./en/base";
import { core } from "./en/core";
import { dashboard } from "./en/dashboard";
import { explore } from "./en/explore";
import { notifications } from "./en/notifications";
import { outreach } from "./en/outreach";
import { scan } from "./en/scan";
import { sources } from "./en/sources";
import { registry } from "./en/registry";
import { variants } from "./en/variants";
import { ai } from "./en/ai";
import { imports } from "./en/imports";

/**
 * İngilizce sözlük (NFR-09). Türkçe parçalarla aynı adlı parçalardan birleştirilir. Faz 4 entegrasyonundan beri TÜM
 * parçalar tam çevrilidir: tür `Record<TrKey, string>` olduğundan Türkçeye eklenip İngilizcesi unutulan bir anahtar tür
 * hatasıdır (`npm run typecheck`). Yer tutucu uyumu ve Türkçede olmayan fazla anahtar `tests/i18n.test.ts`'te denetlenir.
 */
export const en: Record<TrKey, string> = {
  ...base,
  ...core,
  ...scan,
  ...notifications,
  ...explore,
  ...outreach,
  ...dashboard,
  ...sources,
  ...registry,
  ...variants,
  ...ai,
  ...imports,
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
  sources,
  registry,
  variants,
  ai,
  imports,
} as const;
