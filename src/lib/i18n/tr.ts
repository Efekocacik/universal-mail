import { base } from "./tr/base";
import { core } from "./tr/core";
import { dashboard } from "./tr/dashboard";
import { explore } from "./tr/explore";
import { notifications } from "./tr/notifications";
import { outreach } from "./tr/outreach";
import { scan } from "./tr/scan";

/**
 * Türkçe sözlük (birincil dil). Paket başına PARÇA dosyalarından birleştirilir; böylece paralel çalışan Faz 4 paketleri
 * aynı dosyaya yazmaz:
 *
 *   tr/base.ts           Faz 4 öncesi tüm anahtarlar (DONDURULDU; yeni anahtar eklenmez)
 *   tr/core.ts           D: tema, yardım, hata kodları, biçimlendirme, masaüstü
 *   tr/scan.ts           B: zamanlama, saklama, açılış izleme, RDAP
 *   tr/notifications.ts  B (P0 başlattı): bildirim metinleri
 *   tr/explore.ts        C: harita, seçim, kayıtlı süzgeçler, toplu işlemler, kısayollar
 *   tr/outreach.ts       E: gönderim, kampanya, takip
 *   tr/dashboard.ts      E (P0 başlattı): gösterge paneli
 *
 * Bir anahtar iki parçada birden olamaz (`tests/i18n.test.ts`). Her Türkçe parçanın İngilizce karşılığı `en/<aynı ad>.ts`.
 */
export const tr = {
  ...base,
  ...core,
  ...scan,
  ...notifications,
  ...explore,
  ...outreach,
  ...dashboard,
} as const;

/** Parça adı → parça (kapsam raporu ve çakışma testi için). */
export const TR_FRAGMENTS = {
  base,
  core,
  scan,
  notifications,
  explore,
  outreach,
  dashboard,
} as const;
export type FragmentName = keyof typeof TR_FRAGMENTS;
export type TrKey = keyof typeof tr;
