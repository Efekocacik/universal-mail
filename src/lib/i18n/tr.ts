import { base } from "./tr/base";
import { core } from "./tr/core";
import { dashboard } from "./tr/dashboard";
import { explore } from "./tr/explore";
import { notifications } from "./tr/notifications";
import { outreach } from "./tr/outreach";
import { scan } from "./tr/scan";
import { sources } from "./tr/sources";
import { registry } from "./tr/registry";
import { variants } from "./tr/variants";
import { ai } from "./tr/ai";
import { imports } from "./tr/imports";
import { backup } from "./tr/backup";
import { install } from "./tr/install";
import { security } from "./tr/security";
import { restriction } from "./tr/restriction";

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
 *   tr/sources.ts        Faz 5 P0: kaynak alt gezinmesi, ayar bölüm adları, ortak etiketler, anahtar alan adları
 *   tr/registry.ts       Faz 5 R (P0 başlattı): resmî siciller ve eşleştirme
 *   tr/variants.ts       Faz 5 T (P0 başlattı): şablon dilleri, A/B konu, kategori varyantı, açılma izleme
 *   tr/ai.ts             Faz 5 A (P0 başlattı): Claude kişisel giriş, Hunter/Snov
 *   tr/imports.ts        Faz 5 I (P0 başlattı): CSV/XLSX içe aktarma
 *   tr/backup.ts         Faz 6 Y (P0 başlattı): yedekler, geri yükleme, saklama süresi, verileri silme
 *   tr/install.ts        Faz 6 K (P0 başlattı): kurulum listesi, geçiş hatası kurtarma, menü
 *   tr/security.ts       Faz 6 G (P0 başlattı): güvenlik ve gizlilik metinleri
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
  ...sources,
  ...registry,
  ...variants,
  ...ai,
  ...imports,
  ...backup,
  ...install,
  ...security,
  ...restriction,
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
  sources,
  registry,
  variants,
  ai,
  imports,
  backup,
  install,
  security,
  restriction,
} as const;
export type FragmentName = keyof typeof TR_FRAGMENTS;
export type TrKey = keyof typeof tr;
