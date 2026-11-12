import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";
import { Providers } from "@/components/providers";
import { themeClass, type ThemePref } from "@/lib/client/theme";
import { getDb } from "@/lib/db/client";
import type { Locale } from "@/lib/i18n";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Universal Mail",
  description: "Local tool that finds newly opened businesses and sends controlled B2B email",
  robots: { index: false, follow: false },
};

/**
 * Arayüz dili ve tema her istekte ayarlardan okunur (derleme anında değil: `connection()`), böylece ilk HTML doğru
 * dil (`lang`) ve tema sınıfıyla gelir. Veritabanı henüz hazır değilse (ilk açılış, geçiş sürüyor) varsayılanlara
 * düşülür: Türkçe ve sistem teması.
 */
async function uiPrefs(): Promise<{ locale: Locale; theme: ThemePref }> {
  try {
    const s = await getSettings(await getDb(), ["ui.language", "ui.theme"] as const);
    return { locale: s["ui.language"], theme: s["ui.theme"] };
  } catch {
    return { locale: "tr", theme: "system" };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const { locale, theme } = await uiPrefs();
  return (
    <html lang={locale} className={themeClass(theme)} suppressHydrationWarning>
      <body>
        <Providers initialLocale={locale} initialTheme={theme}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
