/**
 * Arayüz tercihleri (tema, dil, oturum açılınca başlat) için ana süreç tarafı. Saf işlevler: Electron'a bağımlı değildir
 * ve tests/electron-ui-prefs.test.ts ile sınanır.
 *
 * Kaynak doğruluk: tercihler uygulamanın veritabanındaki ayarlardır (ui.theme, ui.language, app.openAtLogin). Arayüz
 * değişikliği kaydettikten sonra `um:set-ui-prefs` IPC ile ana sürece de bildirir; ana süreç bunları
 * `<userData>/ui-prefs.json` dosyasına yazar ki bir sonraki açılışta pencere doğru arka planla ve menüler doğru dilde,
 * web sunucusu hazır olmadan önce açılsın. IPC girdisi GÜVENİLMEZ kabul edilir: yalnızca bilinen alanlar ve değerler
 * alınır, gerisi yok sayılır (sayfa ele geçirilse bile ana sürece rastgele veri yazamaz).
 */
export type ThemeSource = "system" | "light" | "dark";
export type UiLanguage = "tr" | "en";

export interface UiPrefs {
  theme: ThemeSource;
  language: UiLanguage;
  openAtLogin: boolean;
}

export const DEFAULT_UI_PREFS: UiPrefs = { theme: "system", language: "tr", openAtLogin: false };
export const UI_PREFS_FILENAME = "ui-prefs.json";

const THEMES: readonly ThemeSource[] = ["system", "light", "dark"];
const LANGS: readonly UiLanguage[] = ["tr", "en"];

/**
 * IPC ile gelen kısmi tercihi doğrular. Bilinmeyen alanlar ve geçersiz değerler atılır ve `rejected` listesinde
 * raporlanır (günlüğe yazılır); geçerli alanlar `patch`'te döner.
 */
export function validateUiPrefsPatch(input: unknown): {
  patch: Partial<UiPrefs>;
  rejected: string[];
} {
  const patch: Partial<UiPrefs> = {};
  const rejected: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { patch, rejected: ["(gövde)"] };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "theme" && THEMES.includes(v as ThemeSource)) patch.theme = v as ThemeSource;
    else if (k === "language" && LANGS.includes(v as UiLanguage)) patch.language = v as UiLanguage;
    else if (k === "openAtLogin" && typeof v === "boolean") patch.openAtLogin = v;
    else rejected.push(k.slice(0, 40));
  }
  return { patch, rejected };
}

/** Dosyadan okunan değeri (bozuk/eski olabilir) varsayılanlarla birleştirerek güvenli tercihe çevirir. */
export function parseStoredPrefs(raw: string | null | undefined): UiPrefs {
  if (!raw) return { ...DEFAULT_UI_PREFS };
  try {
    return { ...DEFAULT_UI_PREFS, ...validateUiPrefsPatch(JSON.parse(raw)).patch };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

/** Electron `nativeTheme.themeSource` değeri (aynı adlar). */
export const themeSourceFor = (theme: ThemeSource): ThemeSource => theme;

/** Pencerenin ilk boyama rengi: globals.css `--background` (açık/koyu) ile aynı. */
export function windowBackground(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0f1113" : "#f6f6f3";
}

/**
 * Oturum açılınca başlatma yalnızca paketli uygulamada ve destekleyen platformlarda (macOS, Windows) uygulanır;
 * geliştirme sırasında Electron'un kendisini oturum öğesi yapmamak için atlanır.
 */
export function loginItemSupported(platform: string, packaged: boolean): boolean {
  return packaged && (platform === "darwin" || platform === "win32");
}
