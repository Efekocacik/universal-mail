export {};

declare global {
  interface Window {
    /** Yalnızca Electron içinde bulunur (preload köprüsü). Ayrıntılar: electron/preload.ts. */
    universalMail?: {
      platform: string;
      openDataFolder: () => Promise<string>;
      /** Faz 4: masaüstü işletim sistemi bildirimleri gösterilebilir (Ayarlar'da anahtar görünür). */
      osNotifications?: boolean;
      /** Faz 4: "oturum açılınca başlat" bu platformda desteklenir (macOS/Windows, paketli uygulama). */
      loginItem?: boolean;
      /**
       * Faz 4: tema/dil/oturum açılınca başlatma tercihini ana sürece bildirir (menüler, yerel iletişim kutuları, pencere
       * arka planı, oturum öğesi). Ana süreç her alanı doğrular; geçersiz değer yok sayılır. Yeni değerleri döndürür.
       */
      setUiPrefs?: (prefs: {
        theme?: "system" | "light" | "dark";
        language?: "tr" | "en";
        openAtLogin?: boolean;
      }) => Promise<{ ok: boolean }>;
    };
  }
}
