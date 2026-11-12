import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { enCoverage } from "@/lib/i18n/coverage";
import { EN_FRAGMENTS } from "@/lib/i18n/en";
import { TR_FRAGMENTS } from "@/lib/i18n/tr";

/**
 * Paket D (10a-2): İngilizce arayüz eşliği. `base` ve `core` parçaları TAM çevrilidir (eksik/fazla anahtar yok);
 * tüm parçalarda yer tutucular Türkçeyle aynıdır; "Bu nedir?" balonları kısa kalır; modül düzeyinde `t()` çağrısı yoktur
 * (dil değişince yeniden hesaplanmaz, ilk yüklemedeki dilde donar).
 */
const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe("i18n: İngilizce eşlik (Paket D)", () => {
  it.each(["base", "core"] as const)("%s parçası eksiksiz ve fazlasız çevrilidir", (name) => {
    const trFrag = TR_FRAGMENTS[name] as Record<string, string>;
    const enFrag = EN_FRAGMENTS[name] as Record<string, string>;
    const missing = Object.keys(trFrag).filter((k) => !(k in enFrag));
    const extra = Object.keys(enFrag).filter((k) => !(k in trFrag));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    for (const [k, v] of Object.entries(enFrag)) expect(v.trim().length, k).toBeGreaterThan(0);
  });

  it("base parçasının anahtar sırası Türkçeyle aynıdır (gözden geçirme kolaylığı)", () => {
    expect(Object.keys(EN_FRAGMENTS.base)).toEqual(Object.keys(TR_FRAGMENTS.base));
  });

  it("tüm parçalarda yer tutucular Türkçeyle birebir aynıdır (adet dahil)", () => {
    expect(enCoverage().flatMap((r) => r.placeholderMismatch)).toEqual([]);
    // Bağımsız ikinci kontrol: kapsam modülü değişse de bu test eşliği korur.
    const bad: string[] = [];
    for (const name of ["base", "core"] as const) {
      const trFrag = TR_FRAGMENTS[name] as Record<string, string>;
      const enFrag = EN_FRAGMENTS[name] as Record<string, string>;
      for (const [k, v] of Object.entries(trFrag))
        if (placeholders(v).join() !== placeholders(enFrag[k] ?? "").join()) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  it("İngilizce base/core metninde Türkçe harf kalmaz (dil adlarının kendi yazımı hariç)", () => {
    const allowed = new Set(["uiLang.tr"]);
    const leftovers: string[] = [];
    for (const name of ["base", "core"] as const)
      for (const [k, v] of Object.entries(EN_FRAGMENTS[name] as Record<string, string>))
        if (!allowed.has(k) && /[ğışĞİŞ]/.test(v)) leftovers.push(`${k}: ${v}`);
    expect(leftovers).toEqual([]);
  });

  it("çift süslü şablon değişkenleri ({{sehir|…}}) ve marka adları korunur", () => {
    const en = EN_FRAGMENTS.base;
    expect(en["tplEditor.fallback.hint"]).toContain("{{sehir|");
    expect(en["tplIssue.unclosed_variable"]).toContain("{{ ... }}");
    expect(en["provider.demo"]).toBe("DEMO");
    expect(en["health.dns.spf"]).toBe("SPF");
    expect(en["mbx.oauth.page.title"]).toContain("Universal Mail");
  });

  it('"Bu nedir?" (help.*) balonları her iki dilde en çok 240 karakterdir', () => {
    const long: string[] = [];
    for (const frags of [TR_FRAGMENTS, EN_FRAGMENTS])
      for (const frag of Object.values(frags))
        for (const [k, v] of Object.entries(frag as Record<string, string>))
          if (k.startsWith("help.") && v.length > 240) long.push(`${k} (${v.length})`);
    expect(long).toEqual([]);
  });
});

// ---- Modül düzeyinde t() koruması ----

const SRC = path.resolve(__dirname, "..", "src");
const I18N_DIR = path.join(SRC, "lib", "i18n") + path.sep;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Bir işlev gövdesine girmeden (yani modül yüklenirken) çalışan `t(...)` çağrılarını bulur. */
export function moduleScopeTCalls(fileName: string, text: string): number[] {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return; // gövde çağrı anında çalışır
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t"
    )
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return lines;
}

describe("i18n: modül düzeyinde t() yok", () => {
  it("koruma kendisi doğru çalışır", () => {
    expect(moduleScopeTCalls("a.ts", 'const A = t("x");\nfunction f() { return t("y"); }')).toEqual(
      [1],
    );
    expect(
      moduleScopeTCalls("b.tsx", 'const B = { k: () => t("x") };\nexport const C = [t("z")];'),
    ).toEqual([2]);
    expect(moduleScopeTCalls("c.ts", "class K { m() { return t('a'); } }")).toEqual([]);
  });

  it("src altında (sözlük dosyaları hariç) modül yüklenirken çalışan t() çağrısı yoktur", () => {
    const hits: string[] = [];
    for (const f of walk(SRC).filter((x) => !x.startsWith(I18N_DIR))) {
      const text = fs.readFileSync(f, "utf8");
      if (!/\bt\(/.test(text)) continue;
      for (const line of moduleScopeTCalls(f, text)) hits.push(`${path.relative(SRC, f)}:${line}`);
    }
    expect(hits).toEqual([]);
  });
});
