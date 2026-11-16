import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../next.config";
import {
  EGRESS_ALLOWLIST,
  EGRESS_SERVICES,
  egressServices,
  findEgressEntry,
  findSourceLiteralEntry,
  hostMatches,
  isLoopbackHost,
  isReservedName,
} from "@/lib/net/egress-allowlist";

/**
 * Faz 6 (paket G, NFR-01): statik dış adres envanteri. Kaynak koddaki her URL sabiti izin listesinde olmalıdır; ağ
 * modüllerini yalnızca belirlenmiş dinamik çıkış modülleri içe aktarabilir; CSP'deki her dış kaynak ve belge tablosu
 * izin listesiyle tutarlıdır. Yeni bir dış hizmet bu testi kırar: önce izin listesine ve belgeye eklenmelidir.
 */

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "electron"];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|svg|css|html)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else if (TEXT.test(e.name)) out.push(rel);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap(walk);

/** Dosyadaki URL sabitlerinin ana bilgisayarları (şablon parçaları `${…}` ve Türkçe örnek sözcükler hariç). */
function urlHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/([^/\s"'`)\\<>{}?#,;|$]*)/g)) {
    let host = m[1]!;
    const after = text[m.index! + m[0].length];
    if (after === "$" || after === "<" || after === "{") continue; // dinamik: `https://${host}`
    host = host.replace(/^[^@]*@/, ""); // kullanıcı bilgisi
    host = host.startsWith("[")
      ? host.slice(0, host.indexOf("]") + 1)
      : host.replace(/[:[].*$/, ""); // bağlantı noktası, `ana.makine[:port]` gibi açıklama
    if (!host || host.endsWith(".") || host === "[") continue;
    out.push(host.toLowerCase());
  }
  return out;
}

/**
 * Adres olmayan, tırnaklı çıplak ana bilgisayar sabitleri: ana bilgisayar benzeri bir ada (`host`, `hostname`, `domain`,
 * `origin`, `endpoint`, `server`, `baseUrl`, `apiBase`… ve büyük harfli `API_HOST` gibi) atanan ya da nesne alanı olarak
 * verilen `"api.ornek.com"` biçimindeki değerler. Sınır: birleştirmeyle kurulan adresler (`"https://" + HOST`) ancak
 * `HOST` bu biçimde bir sabitse yakalanır; çalışma anında hesaplanan adresler `e2e/privacy.spec.ts` ile denetlenir.
 */
function bareHosts(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b[A-Za-z_$]*(?:host|hostname|domain|origin|endpoint|server|baseurl|base_url|apibase|api_base)[A-Za-z_$]*\??\s*[:=]\s*["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})["'`]/gi;
  for (const m of text.matchAll(re)) out.push(m[1]!.toLowerCase());
  return out;
}

describe("dış adres izin listesi", () => {
  it("izin listesi tutarlıdır: kategoriler bilinen dört türdür, geliştirici/telemetri girişi yoktur", () => {
    const allowed = new Set(["user-enabled-api", "user-link", "placeholder", "dynamic"]);
    for (const e of EGRESS_ALLOWLIST) {
      expect(allowed.has(e.category), e.host).toBe(true);
      // Hizmet yalnızca bağlantı kurulan girişlerde; tıklanan bağlantı ve yer tutucu hizmet değildir.
      if (e.category === "user-enabled-api" || e.category === "dynamic")
        expect(e.service, e.host).not.toBeNull();
      else expect(e.service, e.host).toBeNull();
      expect(e.note.length, e.host).toBeGreaterThan(3);
    }
    const hosts = EGRESS_ALLOWLIST.map((e) => e.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    // Bilinen telemetri/analiz/hata izleme ve geliştirici altyapısı adresleri hiçbir kategoride yok.
    for (const bad of [
      "telemetry.nextjs.org",
      "sentry.io",
      "o1.ingest.sentry.io",
      "api.segment.io",
      "www.google-analytics.com",
      "api.mixpanel.com",
      "app.posthog.com",
      "api.github.com",
      "update.electronjs.org",
      "registry.npmjs.org",
    ])
      expect(findEgressEntry(bad), bad).toBeUndefined();
    // Her hizmetin en az bir girişi var.
    for (const s of EGRESS_SERVICES)
      expect(
        EGRESS_ALLOWLIST.some((e) => e.service === s),
        s,
      ).toBe(true);
  });

  it("src ve electron altındaki her URL ve ana bilgisayar sabiti izin listesinde TAM olarak var", () => {
    expect(FILES.length).toBeGreaterThan(200);
    const unknown: string[] = [];
    let urls = 0;
    let bare = 0;
    for (const f of FILES) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const host of urlHosts(text)) {
        urls++;
        if (!findSourceLiteralEntry(host)) unknown.push(`${f}: ${host}`);
      }
      for (const host of bareHosts(text)) {
        bare++;
        if (!findSourceLiteralEntry(host)) unknown.push(`${f}: ${host} (çıplak ana bilgisayar)`);
      }
    }
    expect(urls).toBeGreaterThan(50);
    expect(bare).toBeGreaterThan(3);
    expect(unknown).toEqual([]);
  });

  it("kaynak sabitleri için joker yok: Google jokerleri yalnızca CSP içindir, örnek jokerleri yalnızca ayrılmış adlarda", () => {
    for (const e of EGRESS_ALLOWLIST.filter((x) => x.host.startsWith("*."))) {
      if (e.category === "placeholder") expect(isReservedName(e.host), e.host).toBe(true);
      else expect(e.service, e.host).toBe("maps"); // CSP kaynağı
    }
    // Geliştiriciye ait bir aktarıcı ya da Google telemetri/günlük adresi "harita"/"örnek" diye geçemez.
    for (const host of [
      "my-relay.someone.workers.dev",
      "logging.googleapis.com",
      "play.googleapis.com",
      "tile.googleapis.com",
      "evil.firma.com",
      "telemetry.google.com",
    ])
      expect(findSourceLiteralEntry(host), host).toBeUndefined();
    // Kodda sabit yazılmış örnek ve ayrılmış adlar geçer.
    for (const host of [
      "cikis.firma.com",
      "um-relay.youraccount.workers.dev",
      "rdap.demo.example",
      "unsubscribe.invalid",
      "evil.example.com",
      "places.googleapis.com",
    ])
      expect(findSourceLiteralEntry(host), host).toBeDefined();
  });

  it("çıplak ana bilgisayar taraması: ana bilgisayar benzeri adlara atanan sabitleri yakalar", () => {
    expect(
      bareHosts(
        `const API_HOST = "api.gizli.io"; x = { hostname: 'log.dev.net', path: "/a.b" }; baseUrl = "c.d.org"; name = "e.f.com"`,
      ),
    ).toEqual(["api.gizli.io", "log.dev.net", "c.d.org"]);
  });

  it("ağ modüllerini yalnızca belirlenmiş dinamik çıkış modülleri içe aktarır", () => {
    const NET_IMPORT =
      /(?:from\s+|require\(\s*|import\(\s*)["'](?:node:)?(dns|dns\/promises|net|tls|http|https|http2|dgram|undici|axios|node-fetch|got|ws)["']/g;
    const ALLOWED: Record<string, string> = {
      "src/lib/email/safe-fetch.ts": "işletme web sitesi okuyucu (özel ağ adresleri engelli)",
      "src/lib/email/verify.ts": "e-posta alan adı MX denetimi",
      "src/lib/mail/dns-check.ts": "gönderim hesabı SPF/DKIM/DMARC denetimi",
      "electron/main.ts": "yerel sunucu sağlık yoklaması ve boş bağlantı noktası (127.0.0.1)",
    };
    const offenders: string[] = [];
    for (const f of FILES) {
      // Ayrı dağıtılan çıkış aktarıcısı (Cloudflare Worker / kendi sunucunuz) uygulamanın parçası değildir.
      if (f.startsWith("src/relay/")) continue;
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const m of text.matchAll(NET_IMPORT)) {
        if (!(f in ALLOWED)) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const f of Object.keys(ALLOWED)) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
  });

  it("CSP'deki her dış kaynak izin listesinde ve bir hizmete (Google Maps) bağlı", () => {
    const sources = CONTENT_SECURITY_POLICY.split(";")
      .flatMap((d) => d.trim().split(/\s+/).slice(1))
      .filter((v) => v.startsWith("https://"))
      .map((v) => v.slice("https://".length));
    expect(sources.length).toBeGreaterThan(3);
    for (const s of sources) {
      const entry = EGRESS_ALLOWLIST.find((e) => e.host === s);
      expect(entry, s).toBeDefined();
      expect(entry!.service, s).toBe("maps");
    }
  });

  it("docs/GUVENLIK.md her izin listesi girişini ve her hizmeti listeler", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs", "GUVENLIK.md"), "utf8");
    for (const e of EGRESS_ALLOWLIST) expect(doc, e.host).toContain(`\`${e.host}\``);
  });
});

describe("yardımcılar", () => {
  it("hostMatches / findEgressEntry / isLoopbackHost", () => {
    expect(hostMatches("*.firma.com", "kafe-1.firma.com")).toBe(true);
    expect(hostMatches("*.firma.com", "a.b.firma.com")).toBe(true);
    expect(hostMatches("*.firma.com", "firma.com")).toBe(false);
    expect(hostMatches("*.firma.com", "kotufirma.com")).toBe(false);
    expect(hostMatches("api.hunter.io", "API.HUNTER.IO.")).toBe(true);
    expect(findEgressEntry("maps.googleapis.com")?.note).toBe("Maps JavaScript API");
    expect(findEgressEntry("tile.googleapis.com")?.host).toBe("*.googleapis.com");
    expect(findEgressEntry("evil.example.net")).toBeUndefined();
    for (const h of ["a.example", "x.invalid", "a.b.example.com", "example.org", "t.test"])
      expect(isReservedName(h), h).toBe(true);
    for (const h of ["example.co", "firma.com", "examples.com", "my.workers.dev"])
      expect(isReservedName(h), h).toBe(false);
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "::ffff:127.0.0.2"])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["10.0.0.1", "0.0.0.0", "example.com", "128.0.0.1", "::ffff:10.0.0.1"])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it("egressServices: arayüz grupları her hizmeti bir kez içerir", () => {
    const groups = egressServices();
    expect(groups.map((g) => g.service)).toEqual([...EGRESS_SERVICES]);
    expect(groups.find((g) => g.service === "websites")).toMatchObject({
      hosts: [],
      dynamic: true,
    });
    expect(groups.find((g) => g.service === "places")).toMatchObject({
      hosts: ["places.googleapis.com"],
      dynamic: false,
    });
  });
});
