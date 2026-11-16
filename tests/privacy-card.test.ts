import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setLocale, t, type Locale } from "@/lib/i18n";
import { EGRESS_ALLOWLIST, EGRESS_SERVICES } from "@/lib/net/egress-allowlist";
import { privacyServiceRows } from "@/lib/net/privacy-view";

/**
 * Faz 6 (paket G): Ayarlar > Güvenlik ve gizlilik kartı. Kart izin listesindeki HER hizmeti TR ve EN metniyle gösterir;
 * listede olmayan bir adres göstermez. Kart durumsuzdur; gerçek React ile sunucu tarafında işlenir. Projenin tsconfig'i
 * JSX'i "preserve" bıraktığı için bileşen burada esbuild ile (uygulama paketleyicisiyle aynı araç) derlenir.
 */

const ROOT = path.resolve(__dirname, "..");
let render: (locale: Locale) => string;

beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { PrivacyCard } from "@/features/settings/privacy-card";
        import { setLocale } from "@/lib/i18n";
        export function render(locale) { setLocale(locale); return renderToStaticMarkup(createElement(PrivacyCard)); }`,
      resolveDir: ROOT,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    alias: { "@": path.join(ROOT, "src") },
    external: ["react", "react-dom", "react/jsx-runtime"],
    logLevel: "silent",
  });
  const mod = { exports: {} as { render: typeof render } };
  const req = createRequire(path.join(ROOT, "package.json"));
  new Function("module", "exports", "require", out.outputFiles[0]!.text)(mod, mod.exports, req);
  render = mod.exports.render;
}, 60_000);

afterEach(() => setLocale("tr"));

describe("privacyServiceRows", () => {
  it("her hizmet bir kez, izin listesi sırasıyla; adresler izin listesinden", () => {
    const rows = privacyServiceRows();
    expect(rows.map((r) => r.service)).toEqual([...EGRESS_SERVICES]);
    const known = new Set(EGRESS_ALLOWLIST.map((e) => e.host));
    for (const r of rows) {
      expect(r.hosts.length, r.service).toBeLessThanOrEqual(3);
      for (const h of r.hosts) expect(known.has(h), h).toBe(true);
      // Gösterilen + gizlenen = hizmetin sabit adres sayısı.
      const fixed = EGRESS_ALLOWLIST.filter(
        (e) => e.service === r.service && e.category !== "dynamic",
      ).length;
      expect(r.hosts.length + r.moreHosts, r.service).toBe(fixed);
      // Her hizmetin ya sabit adresi ya da "duruma göre" notu vardır.
      expect(r.hosts.length > 0 || r.dynamic, r.service).toBe(true);
    }
    expect(rows.find((r) => r.service === "maps")!.moreHosts).toBeGreaterThan(0);
    expect(rows.find((r) => r.service === "websites")).toMatchObject({ hosts: [], dynamic: true });
  });
});

describe("PrivacyCard", () => {
  for (const locale of ["tr", "en"] as const) {
    it(`${locale}: başlık, dört güvence ve her hizmetin adı ile "ne zaman" metni görünür`, () => {
      setLocale(locale);
      const html = render(locale);
      expect(html).toContain(t("security.title"));
      expect(html).toContain('aria-labelledby="privacy-card-title"');
      for (const k of [
        "security.point.local",
        "security.point.secrets",
        "security.point.demo",
        "security.point.noTelemetry",
      ] as const)
        expect(html).toContain(escape(t(k)));
      for (const r of privacyServiceRows()) {
        expect(html, r.service).toContain(`data-service="${r.service}"`);
        expect(html, r.service).toContain(escape(t(r.nameKey)));
        expect(html, r.service).toContain(escape(t(r.whenKey)));
      }
      expect(html).toContain("places.googleapis.com");
      expect(html).toContain(escape(t("security.hosts.dynamic")));
      expect(html).not.toMatch(/security\.[a-z]/); // çevrilmemiş anahtar yok
    });
  }
});

/** React metin kaçışı (yalnızca metinlerde geçen karakterler). */
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;");
}
