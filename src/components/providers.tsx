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
 * dilde değerlendirilir; dil değişimi seyrek ve bilinçli bir eylem olduğundan bu kabul edilebilir.
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
  // İlk çizimden ÖNCE (eşzamanlı) ayarlanır: sunucuda da istemcide de aynı dil kullanılır. Tek kullanıcılı yerel
  // uygulamada süreç içi dil değeri paylaşılır; API kodu dili her zaman açıkça verir (bkz. src/lib/i18n/index.ts).
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

const ThemeContext = createContext<{ pref: ThemePref; resolved: ResolvedTheme }>({
  pref: "system",
  resolved: "light",
});

/** Gösterilen tema (Toaster, Google haritası gibi CSS belirteci kullanamayan bileşenler için). */
export const useResolvedTheme = (): ResolvedTheme => useContext(ThemeContext).resolved;
export const useThemePref = (): ThemePref => useContext(ThemeContext).pref;

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

  return <ThemeContext.Provider value={{ pref, resolved }}>{children}</ThemeContext.Provider>;
}
