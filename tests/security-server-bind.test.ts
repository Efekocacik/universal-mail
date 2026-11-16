import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv } from "../electron/child-env";
import nextConfig, { CONTENT_SECURITY_POLICY, securityHeaders } from "../next.config";

/**
 * Faz 6 (paket G, yol haritası madde 8): yerel sunucu yalnızca 127.0.0.1'e bağlanır, telemetri kapalıdır ve güvenlik
 * başlıkları (CSP dahil) üretimde gönderilir.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("sunucu bağlama adresi", () => {
  const env = childEnv({
    port: 43210,
    masterKey: "a".repeat(64),
    dataDir: "/tmp/um-data",
    serverDir: "/tmp/um-server",
    // Kullanıcının ortamındaki tehlikeli değerler ezilir.
    baseEnv: {
      NODE_ENV: "development",
      HOSTNAME: "0.0.0.0",
      NEXT_TELEMETRY_DISABLED: "0",
      PATH: "/usr/bin",
    },
  });

  it("Electron alt süreçleri: HOSTNAME=127.0.0.1, telemetri kapalı, ana anahtar zorunlu, üretim kipi", () => {
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.NEXT_TELEMETRY_DISABLED).toBe("1");
    expect(env.UM_REQUIRE_MASTER_KEY).toBe("1");
    expect(env.NODE_ENV).toBe("production");
    expect(env.PORT).toBe("43210");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.UM_DATA_DIR).toBe("/tmp/um-data");
  });

  it("Electron boş bağlantı noktasını yalnızca 127.0.0.1'de arar ve sunucu adresi 127.0.0.1'dir", () => {
    const main = read("electron/main.ts");
    expect(main).toMatch(/srv\.listen\(0,\s*"127\.0\.0\.1"/);
    expect(main).toMatch(/`http:\/\/127\.0\.0\.1:\$\{port\}`/);
    expect(main).not.toMatch(/0\.0\.0\.0/);
    // Alt süreç ortamı yalnızca childEnv'den gelir.
    expect(main).toMatch(/childEnv\(/);
  });

  it("E2E sunucusu ve geliştirme sunucusu da yalnızca 127.0.0.1'e bağlanır", () => {
    expect(read("e2e/serve.mjs")).toMatch(/HOSTNAME:\s*"127\.0\.0\.1"/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:web"]).toMatch(/--hostname 127\.0\.0\.1/);
    for (const [name, cmd] of Object.entries(pkg.scripts))
      expect(cmd, name).not.toMatch(/0\.0\.0\.0|--hostname (?!127\.0\.0\.1)/);
  });

  it("işçi ve migrasyon süreçleri hiçbir bağlantı noktası dinlemez", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name)) {
          const s = read(rel);
          if (/\.listen\(|createServer\(/.test(s)) offenders.push(rel);
        }
      }
    };
    walk("src");
    // Tek istisna: ayrı dağıtılan abonelikten çıkış aktarıcısı (uygulamanın parçası değil; kendi sunucusunda çalışır).
    expect(offenders).toEqual(["src/relay/server.ts"]);
  });
});

describe("güvenlik başlıkları (next.config.ts)", () => {
  const csp = Object.fromEntries(
    CONTENT_SECURITY_POLICY.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  );

  it("üretimde CSP ve sıkı başlıklar gönderilir; geliştirmede CSP yok", async () => {
    const prod = securityHeaders(true);
    const byKey = Object.fromEntries(prod.map((h) => [h.key, h.value]));
    expect(byKey["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(byKey["Referrer-Policy"]).toBe("no-referrer");
    expect(byKey["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Permissions-Policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(securityHeaders(false).some((h) => h.key === "Content-Security-Policy")).toBe(false);
    // Yapılandırma her yola uygular; test ortamı (NODE_ENV=test) üretim sayılmaz.
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("CSP: kendi kökeni dışında yalnızca Google Maps (kullanıcı anahtarı girerse) ve hiçbir çerçeve/eklenti", () => {
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["frame-src"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    for (const [name, values] of Object.entries(csp)) {
      for (const v of values) {
        if (v.startsWith("'") || v === "data:" || v === "blob:") continue;
        // Her dış kaynak Google'ındır (Maps JS ve döşemeleri); joker karakterli genel kaynak (`*`, `https:`) yok.
        expect(v, `${name} ${v}`).toMatch(
          /^https:\/\/(\*\.)?(maps\.)?(googleapis|gstatic|google|ggpht|googleusercontent)\.com$|^https:\/\/fonts\.(googleapis|gstatic)\.com$/,
        );
      }
    }
    expect(csp["connect-src"]).toContain("'self'");
    expect(csp["script-src"]).not.toContain("https:");
    expect(csp["script-src"]).not.toContain("*");
  });
});
