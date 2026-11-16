import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../next.config";
import {
  EGRESS_ALLOWLIST,
  EGRESS_SERVICES,
  egressServices,
  findEgressEntry,
  hostMatches,
  isLoopbackHost,
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

  it("src ve electron altındaki her URL sabitinin ana bilgisayarı izin listesindedir", () => {
    expect(FILES.length).toBeGreaterThan(200);
    const unknown: string[] = [];
    let seen = 0;
    for (const f of FILES) {
      for (const host of urlHosts(fs.readFileSync(path.join(ROOT, f), "utf8"))) {
        seen++;
        if (!findEgressEntry(host)) unknown.push(`${f}: ${host}`);
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(unknown).toEqual([]);
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
    expect(findEgressEntry("evil.example.org")).toBeUndefined();
    for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["10.0.0.1", "0.0.0.0", "example.com", "128.0.0.1"])
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
