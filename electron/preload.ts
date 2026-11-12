import { contextBridge, ipcRenderer } from "electron";

/**
 * Arayüze açılan YALNIZCA kısıtlı köprü. Node/Electron API'leri doğrudan açılmaz (contextIsolation).
 * Yeni yetenekler buraya ayrı ayrı, doğrulamalı olarak eklenir; ana süreç her girdiyi yeniden doğrular.
 *
 * Faz 4:
 *  - `setUiPrefs`: tema/dil/oturum açılınca başlat tercihini ana sürece bildirir (menüler, yerel iletişim kutuları,
 *    pencere arka planı, oturum öğesi). Ana süreç yalnızca bilinen alan ve değerleri alır (electron/ui-prefs.ts).
 *  - `osNotifications` / `loginItem`: salt okunur yetenek bayrakları (Ayarlar'da ilgili anahtarlar görünsün diye).
 *  Arayüze genel bir "bildirim göster" işlevi BİLEREK açılmaz: bildirimleri yalnızca ana süreç, yerel sunucudan
 *  sahiplenerek gösterir (electron/notify.ts).
 */
const loginItem = process.platform === "darwin" || process.platform === "win32";

contextBridge.exposeInMainWorld("universalMail", {
  platform: process.platform,
  openDataFolder: (): Promise<string> => ipcRenderer.invoke("um:open-data-folder"),
  osNotifications: true,
  loginItem,
  setUiPrefs: (prefs: unknown): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("um:set-ui-prefs", prefs),
});
