import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyThemeClass,
  isThemePref,
  resolveTheme,
  THEME_PREFS,
  themeClass,
  WINDOW_BACKGROUND,
} from "@/lib/client/theme";
import { windowBackground } from "../electron/ui-prefs";

/**
 * Faz 4 10a-1 (koyu tema): renk belirteçleri üç blokta tutarlıdır (açık `:root`, `:root.dark`, "Sistem" + işletim
 * sistemi koyu) ve ana metin/zemin çiftleri WCAG AA (≥ 4.5:1) kontrastı sağlar.
 */
const CSS = fs.readFileSync(path.resolve(__dirname, "..", "src", "app", "globals.css"), "utf8");

function block(selectorRe: RegExp): Map<string, string> {
  const m = selectorRe.exec(CSS);
  if (!m) throw new Error(`blok yok: ${selectorRe}`);
  const start = CSS.indexOf("{", m.index) + 1;
  const end = CSS.indexOf("}", start);
  const out = new Map<string, string>();
  for (const d of CSS.slice(start, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out.set(d[1]!, d[2]!.trim());
  return out;
}

const light = block(/^:root \{/m);
const dark = block(/^:root\.dark \{/m);
const media = block(/^\s+:root:not\(\.light\) \{/m);

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe("tema belirteçleri (globals.css)", () => {
  it("her açık belirteç koyu blokta ve sistem-koyu blokta da tanımlıdır", () => {
    expect(light.size).toBeGreaterThan(30);
    const missingDark = [...light.keys()].filter((k) => !dark.has(k));
    const missingMedia = [...light.keys()].filter((k) => !media.has(k));
    expect(missingDark).toEqual([]);
    expect(missingMedia).toEqual([]);
  });

  it("`.dark` ve `prefers-color-scheme: dark` blokları birebir aynıdır", () => {
    expect(Object.fromEntries(media)).toEqual(Object.fromEntries(dark));
  });

  it("pencere arka planı (Electron ilk boyama) CSS --background ile aynıdır", () => {
    expect(WINDOW_BACKGROUND.light).toBe(light.get("--background"));
    expect(WINDOW_BACKGROUND.dark).toBe(dark.get("--background"));
    expect(windowBackground(false)).toBe(light.get("--background"));
    expect(windowBackground(true)).toBe(dark.get("--background"));
  });

  const PAIRS: [fg: string, bg: string][] = [
    ["--foreground", "--background"],
    ["--foreground", "--card"],
    ["--card-foreground", "--card"],
    ["--popover-foreground", "--popover"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--muted-foreground", "--muted"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--accent-foreground", "--accent"],
    ["--destructive-foreground", "--destructive"],
    ["--success-foreground", "--success"],
    ["--success-text", "--card"],
    ["--warning-text", "--card"],
    ["--danger-text", "--card"],
    ["--info-text", "--card"],
    ["--low-text", "--card"],
    ["--future-text", "--card"],
  ];

  it.each([
    ["açık", light],
    ["koyu", dark],
  ] as const)("%s tema: metin/zemin çiftleri WCAG AA (≥ 4.5)", (_name, tokens) => {
    const weak = PAIRS.map(([fg, bg]) => ({
      pair: `${fg} / ${bg}`,
      ratio: contrast(tokens.get(fg)!, tokens.get(bg)!),
    })).filter((p) => !(p.ratio >= 4.5));
    expect(weak).toEqual([]);
  });

  it("renk şeması bildirimi her blokta doğru", () => {
    expect(CSS).toMatch(/^:root \{[^}]*color-scheme: light;/m);
    expect(CSS).toMatch(/^:root\.dark \{[^}]*color-scheme: dark;/m);
  });
});

describe("tema modeli (src/lib/client/theme.ts)", () => {
  it("seçim + işletim sistemi → gösterilen tema", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("<html> sınıfı: system → yok; diğerleri kendi adı", () => {
    expect(themeClass("system")).toBeUndefined();
    expect(themeClass("dark")).toBe("dark");
    expect(themeClass("light")).toBe("light");
  });

  it("applyThemeClass yalnızca dark/light sınıflarını değiştirir", () => {
    const set = new Set(["font-sans", "dark"]);
    const list = {
      add: (...c: string[]) => c.forEach((x) => set.add(x)),
      remove: (...c: string[]) => c.forEach((x) => set.delete(x)),
    };
    applyThemeClass(list, "light");
    expect([...set].sort()).toEqual(["font-sans", "light"]);
    applyThemeClass(list, "system");
    expect([...set]).toEqual(["font-sans"]);
    applyThemeClass(list, "dark");
    expect([...set].sort()).toEqual(["dark", "font-sans"]);
  });

  it("isThemePref yalnızca bilinen değerleri kabul eder", () => {
    for (const p of THEME_PREFS) expect(isThemePref(p)).toBe(true);
    for (const v of ["auto", "", null, 1, "DARK"]) expect(isThemePref(v)).toBe(false);
  });
});
