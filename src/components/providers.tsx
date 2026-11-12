"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useConfig } from "@/lib/client/queries";
import {
  applyThemeClass,
  resolveTheme,
  type ResolvedTheme,
  type ThemePref,
} from "@/lib/client/theme";
import { getLocale, isLocale, onLocaleChange, setLocale, type Locale } from "@/lib/i18n";

/**
 * Uygulama sağlayıcıları: sorgu istemcisi, dil (I18nProvider) ve tema (ThemeSync).
 *
 * İlk dil ve tema SUNUCUDA ayarlardan okunur (kök yerleşim) ve buraya verilir; böylece sunucu çıktısı ile ilk istemci
 * çizimi aynıdır (yanıp sönme, hidrasyon uyuşmazlığı yok). Kullanıcı Ayarlar'dan değiştirince `/api/config` tazelenir;
 * buradaki dinleyiciler dili/temayı uygular. Dil değişince alt ağaç yeniden kurulur (`key`), böylece her `t()` yeni
 * dilde değerlendirilir; dil değişimi seyrek ve bilinçli bir eylem olduğundan bu kabul edilebilir. Yerel durum kaybı
 * şöyle önlenir (src/lib/client/locale-switch.ts): kaydedilmemiş değişikliği olan form varsa dil seçici önce onay
 * ister; kurulum sihirbazı taslağını yeni örneğe taşır; klavye odağı dil seçiciye geri döner.
 */
export function Providers({
  children,
  initialLocale = "tr",
  initialTheme = "system",
}: {
  children: React.ReactNode;
  initialLocale?: Locale;
  initialTheme?: ThemePref;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={initialLocale}>
        <ThemeSync initialTheme={initialTheme}>{children}</ThemeSync>
      </I18nProvider>
    </QueryClientProvider>
  );
}

/* ----------------------------------- dil ----------------------------------- */

function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  // İlk çizimden ÖNCE (eşzamanlı) ayarlanır: sunucu çıktısı ile istemcinin ilk çizimi aynı dilde olsun (hidrasyon).
  // Sunucuda bu süreç içi değer son çizilen sayfaya göre değişebilir; bu yüzden sunucu kodu (API, bildirim metni,
  // OAuth geri çağrı sayfası) `t()`'ye dili HER ZAMAN açıkça verir ve bu değere güvenmez (bkz. src/lib/i18n/index.ts).
  useState(() => {
    setLocale(initialLocale);
    return initialLocale;
  });
  const locale = useSyncExternalStore(onLocaleChange, getLocale, () => initialLocale);
  const { data } = useConfig();
  const wanted = data?.language;

  useEffect(() => {
    if (isLocale(wanted)) setLocale(wanted);
  }, [wanted]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <Fragment key={locale}>{children}</Fragment>;
}

/* ----------------------------------- tema ---------------------------------- */

const ThemeContext = createContext<{ pref: ThemePref; resolved: ResolvedTheme; ready: boolean }>({
  pref: "system",
  resolved: "light",
  ready: false,
});

/** Gösterilen tema (Toaster, Google haritası gibi CSS belirteci kullanamayan bileşenler için). */
export const useResolvedTheme = (): ResolvedTheme => useContext(ThemeContext).resolved;
export const useThemePref = (): ThemePref => useContext(ThemeContext).pref;
/**
 * Gösterilen tema istemcide kesinleşti mi? Hidrasyon çiziminde sistem teması bilinmez (sunucu anlık görüntüsü "açık");
 * hemen ardından düzeltilir. Tema değişince yeniden kurulması pahalı olan bileşenler (Google haritası: her kurulum
 * ayrı bir harita yüklemesi) bunu bekler.
 */
export const useThemeReady = (): boolean => useContext(ThemeContext).ready;

const noopSubscribe = () => () => {};

const DARK_QUERY = "(prefers-color-scheme: dark)";
function subscribeSystemDark(cb: () => void): () => void {
  const mq = window.matchMedia?.(DARK_QUERY);
  if (!mq) return () => {};
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const systemDarkSnapshot = () => window.matchMedia?.(DARK_QUERY).matches ?? false;

function ThemeSync({
  initialTheme,
  children,
}: {
  initialTheme: ThemePref;
  children: React.ReactNode;
}) {
  const { data } = useConfig();
  const pref: ThemePref = data?.theme ?? initialTheme;
  const systemDark = useSyncExternalStore(subscribeSystemDark, systemDarkSnapshot, () => false);
  // Hidrasyonda yanlış, istemci düzeltme çiziminde (systemDark ile AYNI geçişte) doğru.
  const ready = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const resolved = resolveTheme(pref, systemDark);

  useEffect(() => {
    applyThemeClass(document.documentElement.classList, pref);
  }, [pref]);

  // Masaüstü: menüler, yerel iletişim kutuları ve pencere arka planı aynı dil/temayı izlesin (tarayıcıda yok sayılır).
  const language = data?.language;
  useEffect(() => {
    if (!language) return;
    void window.universalMail?.setUiPrefs?.({ theme: pref, language }).catch(() => undefined);
  }, [pref, language]);

  return (
    <ThemeContext.Provider value={{ pref, resolved, ready }}>{children}</ThemeContext.Provider>
  );
}
