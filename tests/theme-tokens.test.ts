import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
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

  /** `bg-nov-likely/15` sarı uyarı kutusu: `--nov-likely` %15, alttaki zemin %85. */
  function tint(tokens: Map<string, string>, under: string): string {
    const a = tokens.get("--nov-likely")!.replace("#", "");
    const b = tokens.get(under)!.replace("#", "");
    return (
      "#" +
      [0, 2, 4]
        .map((i) =>
          Math.round(
            parseInt(a.slice(i, i + 2), 16) * 0.15 + parseInt(b.slice(i, i + 2), 16) * 0.85,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }

  it.each([
    ["açık", light],
    ["koyu", dark],
  ] as const)("%s tema: sarı uyarı kutusundaki --caution-text AA (≥ 4.5)", (_name, tokens) => {
    for (const under of ["--background", "--card"]) {
      expect(contrast(tokens.get("--caution-text")!, tint(tokens, under))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

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

/**
 * Faz 4 F: bileşenlerde sabit renk yok. `src/features` ve `src/components` altındaki her .ts/.tsx dosyasının dize,
 * şablon ve JSX metinlerinde hex (`#1f2328`, `text-[#6b5200]`), `rgb()/rgba()` veya `hsl()/hsla()` aranır; renkler
 * globals.css belirteçlerinden (Tailwind sınıfı veya `var(--…)`) gelir, böylece koyu tema kendiliğinden doğru olur.
 * Yorumlar taranmaz. İstisnalar aşağıda gerekçesiyle listelenir ve listede kalan her dosyanın gerçekten istisna
 * gerektirdiği de denetlenir (eskimiş istisna kalmaz).
 */
describe("bileşenlerde sabit renk yok (src/features, src/components)", () => {
  const ROOT = path.resolve(__dirname, "..");
  const SCAN_DIRS = ["src/features", "src/components"];
  const ALLOW: Record<string, string> = {
    "src/features/campaigns/preview-doc.ts":
      "e-posta önizlemesi alıcının istemcisini taklit eder: temadan bağımsız beyaz zemin + koyu metin",
  };
  const COLOR_RE = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|(?<![a-zA-Z])(?:rgba?|hsla?)\(/;

  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return files(p);
      return /\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  function colorLiterals(file: string): string[] {
    const src = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const hits: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n) ||
        ts.isJsxText(n)
      ) {
        const m = COLOR_RE.exec(n.text);
        if (m) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart());
          hits.push(`${line + 1}: ${m[0]}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
    return hits;
  }

  const all = SCAN_DIRS.flatMap((d) => files(path.join(ROOT, d))).map((f) => ({
    rel: path.relative(ROOT, f).split(path.sep).join("/"),
    hits: colorLiterals(f),
  }));

  it("tarama gerçekten dosya buluyor", () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it("izin listesi dışındaki dosyalarda hex/rgb/hsl renk yok", () => {
    const offenders = all
      .filter((f) => f.hits.length > 0 && !(f.rel in ALLOW))
      .map((f) => `${f.rel} → ${f.hits.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("izin listesindeki her dosya hâlâ var ve istisnayı gerçekten kullanıyor", () => {
    for (const rel of Object.keys(ALLOW)) {
      const f = all.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      expect(f!.hits.length, rel).toBeGreaterThan(0);
    }
  });

  it("denetim gerçekten yakalar (örnek dizeler)", () => {
    for (const bad of [
      "text-[#6b5200]",
      "#fff",
      "rgba(20,112,90,0.12)",
      "shadow-[0_1px_8px_rgb(0_0_0/0.04)]",
      "hsl(0 0% 0%)",
    ])
      expect(COLOR_RE.test(bad), bad).toBe(true);
    for (const ok of [
      "text-caution-text",
      "var(--map-stroke)",
      "#main",
      "/#section",
      "bg-nov-likely/15",
    ])
      expect(COLOR_RE.test(ok), ok).toBe(false);
  });
});
