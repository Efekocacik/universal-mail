/**
 * Tema seçimi (Faz 4, 10a-1). Saf işlevler: sunucu (kök yerleşim), tarayıcı (ThemeSync) ve Electron (pencere arka
 * planı) aynı kuralı kullanır. Renkler `globals.css` belirteçlerindedir; burada yalnızca seçim → sınıf/çözüm vardır.
 *
 *   system → `<html>` sınıfsız: CSS `prefers-color-scheme` ile çözer (JS gerekmez, ilk boyamada yanıp sönme yok).
 *   light  → `<html class="light">`: işletim sistemi koyu olsa da açık.
 *   dark   → `<html class="dark">`.
 */
export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

export const isThemePref = (v: unknown): v is ThemePref =>
  v === "system" || v === "light" || v === "dark";

/** Seçim + işletim sistemi tercihi → gerçekte gösterilen tema. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return systemDark ? "dark" : "light";
}

/** `<html>` için sınıf (system → yok). */
export function themeClass(pref: ThemePref): "dark" | "light" | undefined {
  return pref === "system" ? undefined : pref;
}

/** `<html>` sınıf listesini seçime göre günceller (diğer sınıflara dokunmaz). */
export function applyThemeClass(list: Pick<DOMTokenList, "add" | "remove">, pref: ThemePref): void {
  list.remove("dark", "light");
  const c = themeClass(pref);
  if (c) list.add(c);
}

/** Pencere boyanmadan önceki arka plan (globals.css `--background` ile aynı). */
export const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  light: "#f6f6f3",
  dark: "#0f1113",
};
