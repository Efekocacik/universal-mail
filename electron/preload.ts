import { contextBridge, ipcRenderer } from "electron";

/**
 * Arayüze açılan YALNIZCA kısıtlı köprü. Node/Electron API'leri doğrudan açılmaz (contextIsolation).
 * Yeni yetenekler buraya ayrı ayrı, doğrulamalı olarak eklenir; ana süreç her girdiyi yeniden doğrular.
 *
 * Faz 4:
 *  - `setUiPrefs`: tema/dil/oturum açılınca başlat tercihini ana sürece bildirir (menüler, yerel iletişim kutuları,
 *    pencere arka planı, oturum öğesi). Ana süreç yalnızca bilinen alan ve değerleri alır (electron/ui-prefs.ts).
 *  - `osNotifications`: salt okunur yetenek bayrağı (Ayarlar'da ilgili anahtar görünsün diye).
 *  - `getDesktopCaps`: "oturum açılınca başlat" desteği ve işletim sistemindeki gerçek durum ANA SÜREÇTEN okunur
 *    (paketsiz geliştirme sürümünde destek yoktur; anahtar gösterilip hiçbir şey yapmaması önlenir).
 *  Arayüze genel bir "bildirim göster" işlevi BİLEREK açılmaz: bildirimleri yalnızca ana süreç, yerel sunucudan
 *  sahiplenerek gösterir (electron/notify.ts).
 *
 * Faz 6 (electron/lifecycle.ts; ana süreç yalnızca yerel kökenden gelen çağrıyı kabul eder):
 *  - `relaunch`: güvenli kapanış + yeniden başlatma (geri yükleme / verileri silme bekleyen işlemi uygulansın diye).
 *  - `chooseFolder`: yedek klasörü seçme penceresi (iptal → null).
 *  - `chooseBackupFile`: `.umbk` yedek dosyası seçme penceresi (iptal → null). Yol yalnızca sunucuya iletilir; sunucu
 *    yolu yeniden doğrular (mutlak, `.umbk`, normal dosya, boyut sınırı).
 */
contextBridge.exposeInMainWorld("universalMail", {
  platform: process.platform,
  openDataFolder: (): Promise<string> => ipcRenderer.invoke("um:open-data-folder"),
  osNotifications: true,
  getDesktopCaps: (): Promise<{ loginItem: boolean; openAtLogin: boolean | null }> =>
    ipcRenderer.invoke("um:desktop-caps"),
  setUiPrefs: (prefs: unknown): Promise<{ ok: boolean; openAtLogin?: boolean | null }> =>
    ipcRenderer.invoke("um:set-ui-prefs", prefs),
  relaunch: (): Promise<void> => ipcRenderer.invoke("um:relaunch").then(() => undefined),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("um:choose-folder"),
  chooseBackupFile: (): Promise<string | null> => ipcRenderer.invoke("um:choose-backup-file"),
});
