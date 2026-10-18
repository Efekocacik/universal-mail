import { contextBridge, ipcRenderer } from "electron";

/**
 * Arayüze açılan YALNIZCA kısıtlı köprü. Node/Electron API'leri doğrudan açılmaz (contextIsolation).
 * Sonraki fazlarda yeni yetenekler (örn. dosya seçici) buraya ayrı ayrı, doğrulamalı olarak eklenir.
 */
contextBridge.exposeInMainWorld("universalMail", {
  platform: process.platform,
  openDataFolder: (): Promise<string> => ipcRenderer.invoke("um:open-data-folder"),
});
