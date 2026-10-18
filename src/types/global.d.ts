export {};

declare global {
  interface Window {
    /** Yalnızca Electron içinde bulunur (preload köprüsü). */
    universalMail?: {
      platform: string;
      openDataFolder: () => Promise<string>;
    };
  }
}
