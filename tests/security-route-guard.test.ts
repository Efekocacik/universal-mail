import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { config, middleware } from "@/middleware";

/**
 * Faz 6 (paket G, NFR-02): yerel sunucu korumasının TÜM uç noktaları kapsadığının kanıtı.
 *
 * `src/app/**\/route.ts` dosyaları taranır (sabit liste yok): sonradan eklenen bir uç bu testlere kendiliğinden girer.
 *  - middleware eşleştiricisi her uç yolunu kapsar;
 *  - her durum değiştiren yöntem (POST/PUT/PATCH/DELETE): yabancı Host, Origin yok, bozuk/yabancı Origin, başka site
 *    (`cross-site`/`same-site`) → 403; doğru köken → geçer;
 *  - `/api/` altındaki GET: başka site → 403 (OAuth geri çağrısı hariç);
 *  - her dışa açık işleyici `route()` ailesiyle sarılıdır (hatalar tutarlı JSON; yığın izi sızmaz);
 *  - istek gövdesi okuyan her durum değiştiren işleyici gövdeyi zod şemasıyla doğrular.
 */

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "src", "app");
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;
const METHODS = ["GET", "HEAD", "OPTIONS", ...MUTATING] as const;
/** `route()` ailesi: hepsi sonunda `route()`'u çağırır (bkz. domain-route.ts, imports/http.ts). */
const WRAPPERS = ["route", "domainRoute", "importRoute"];
/**
 * Bilinçli olarak sarılmayan işleyiciler (gerekçeli). Yeni bir istisna buraya gerekçesiyle eklenmelidir.
 */
const UNWRAPPED_ALLOWLIST: Record<string, string> = {
  // Açılma pikseli: HER durumda aynı saydam GIF'i döndürür (hata dışarıdan anlaşılmasın); hatayı kendisi yakalar.
  "api/t/o/[token] GET": "sabit yanıtlı piksel",
  // OAuth geri çağrısı: tarayıcıya HTML/yönlendirme döner (JSON değil); hatalarını kendisi sayfaya çevirir.
  "api/oauth/gmail/callback GET": "HTML yanıtlı OAuth geri çağrısı",
};
/**
 * Gövdeyi zod dışında, kendi dar denetimiyle okuyan uçlar (gerekçeli).
 */
const BODY_VALIDATION_ALLOWLIST: Record<string, string> = {
  // RFC 8058 tek tıklama: form gövdesinde yalnızca `List-Unsubscribe=One-Click` ya da JSON `{confirm:true}` kabul edilir;
  // başka her şey 400 UNCONFIRMED.
  "api/unsubscribe/[token]": "yalnızca sabit onay değeri karşılaştırılır",
};

interface RouteFile {
  /** `src/app`'e göreli klasör (ör. `api/leads/[id]`). */
  rel: string;
  /** Örnek URL yolu (dinamik bölümler doldurulmuş). */
  urlPath: string;
  source: string;
  exports: { method: (typeof METHODS)[number]; wrapper: string | null }[];
}

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findRouteFiles(p));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function toUrlPath(rel: string): string {
  const segs = rel
    .split("/")
    .filter((s) => !/^\(.*\)$/.test(s)) // rota grupları URL'de görünmez
    .map((s) => (/^\[\[?\.\.\./.test(s) ? "a/b" : /^\[.+\]$/.test(s) ? "1" : s));
  return `/${segs.join("/")}`;
}

function parseExports(source: string): RouteFile["exports"] {
  const out: RouteFile["exports"] = [];
  const re = /export\s+(?:const\s+(\w+)\s*=\s*(\w+)?\s*\(?|(?:async\s+)?function\s+(\w+)\s*\()/g;
  for (const m of source.matchAll(re)) {
    const name = (m[1] ?? m[3]) as (typeof METHODS)[number];
    if (!(METHODS as readonly string[]).includes(name)) continue;
    out.push({ method: name, wrapper: m[1] ? (m[2] ?? null) : null });
  }
  return out;
}

const ROUTES: RouteFile[] = findRouteFiles(APP)
  .map((file) => {
    const rel = path.relative(APP, path.dirname(file)).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    return { rel, urlPath: toUrlPath(rel), source, exports: parseExports(source) };
  })
  .sort((a, b) => a.rel.localeCompare(b.rel));

const HOST = "127.0.0.1:3210";
const ORIGIN = `http://${HOST}`;

function call(method: string, urlPath: string, headers: Record<string, string>): Response {
  return middleware(new NextRequest(`${ORIGIN}${urlPath}`, { method, headers }));
}
const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

describe("uç nokta envanteri", () => {
  it("uç noktalar bulunur ve her dosya en az bir HTTP yöntemi dışa açar", () => {
    expect(ROUTES.length).toBeGreaterThan(100);
    for (const r of ROUTES) expect(r.exports.length, r.rel).toBeGreaterThan(0);
  });

  it("middleware eşleştiricisi her uç yolunu ve sayfaları kapsar; yalnızca statik varlıklar dışarıda", () => {
    const res = config.matcher.map((m) => new RegExp(`^${m}$`));
    const covered = (p: string) => res.some((r) => r.test(p));
    for (const r of ROUTES) expect(covered(r.urlPath), r.urlPath).toBe(true);
    for (const p of ["/", "/settings", "/u/abc", "/setup"]) expect(covered(p), p).toBe(true);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"])
      expect(covered(p), p).toBe(false);
  });
});

describe.each(ROUTES.filter((r) => r.exports.some((e) => MUTATING.includes(e.method as never))))(
  "$urlPath (durum değiştiren)",
  (r) => {
    const methods = r.exports.map((e) => e.method).filter((m) => MUTATING.includes(m as never));
    it.each(methods)(
      "%s: yabancı Host, kökensiz, yabancı/bozuk köken ve başka site reddedilir",
      (m) => {
        expect(call(m, r.urlPath, { host: "evil.example.com", origin: ORIGIN }).status).toBe(403);
        expect(call(m, r.urlPath, { host: "127.0.0.1.evil.example", origin: ORIGIN }).status).toBe(
          403,
        );
        expect(call(m, r.urlPath, { host: HOST }).status).toBe(403);
        expect(call(m, r.urlPath, { host: HOST, origin: "http://evil.example.com" }).status).toBe(
          403,
        );
        expect(call(m, r.urlPath, { host: HOST, origin: "http://127.0.0.1:9999" }).status).toBe(
          403,
        );
        expect(call(m, r.urlPath, { host: HOST, origin: "null" }).status).toBe(403);
        expect(call(m, r.urlPath, { host: HOST, origin: "file:///x" }).status).toBe(403);
        for (const site of ["cross-site", "same-site"])
          expect(
            call(m, r.urlPath, { host: HOST, origin: ORIGIN, "sec-fetch-site": site }).status,
            site,
          ).toBe(403);
      },
    );
    it.each(methods)("%s: uygulamanın kendi kökeni geçer", (m) => {
      expect(passes(call(m, r.urlPath, { host: HOST, origin: ORIGIN }))).toBe(true);
      expect(
        passes(call(m, r.urlPath, { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin" })),
      ).toBe(true);
    });
  },
);

describe("GET uçları", () => {
  const gets = ROUTES.filter((r) => r.exports.some((e) => e.method === "GET"));
  it("/api altındaki her GET başka siteden reddedilir (OAuth geri çağrısı hariç)", () => {
    for (const r of gets) {
      if (!r.urlPath.startsWith("/api/")) continue;
      for (const site of ["cross-site", "same-site"]) {
        const res = call("GET", r.urlPath, { host: HOST, "sec-fetch-site": site });
        if (r.urlPath === "/api/oauth/gmail/callback") expect(passes(res), r.urlPath).toBe(true);
        else expect(res.status, `${r.urlPath} ${site}`).toBe(403);
      }
      expect(call("GET", r.urlPath, { host: "evil.example.com" }).status, r.urlPath).toBe(403);
      expect(passes(call("GET", r.urlPath, { host: HOST })), r.urlPath).toBe(true);
      expect(
        passes(call("GET", r.urlPath, { host: HOST, "sec-fetch-site": "same-origin" })),
        r.urlPath,
      ).toBe(true);
      expect(
        passes(call("GET", r.urlPath, { host: HOST, "sec-fetch-site": "none" })),
        r.urlPath,
      ).toBe(true);
    }
  });

  it("yerel adlar kabul edilir: localhost, [::1]", () => {
    expect(passes(call("GET", "/api/health", { host: "localhost:3210" }))).toBe(true);
    expect(passes(call("GET", "/api/health", { host: "[::1]:3210" }))).toBe(true);
    expect(
      passes(call("POST", "/api/settings", { host: "[::1]:3210", origin: "http://[::1]:3210" })),
    ).toBe(true);
  });
});

describe("işleyici yapısı (statik)", () => {
  it("her dışa açık işleyici route() ailesiyle sarılıdır (gerekçeli istisnalar hariç)", () => {
    const unwrapped: string[] = [];
    for (const r of ROUTES)
      for (const e of r.exports) {
        const key = `${r.rel} ${e.method}`;
        if (e.wrapper && WRAPPERS.includes(e.wrapper)) continue;
        if (key in UNWRAPPED_ALLOWLIST) continue;
        unwrapped.push(key);
      }
    expect(unwrapped).toEqual([]);
    // İstisna listesi bayatlamasın: listedeki her giriş hâlâ var ve hâlâ sarılmamış.
    for (const key of Object.keys(UNWRAPPED_ALLOWLIST)) {
      const [rel, method] = key.split(" ");
      const r = ROUTES.find((x) => x.rel === rel);
      expect(r, key).toBeDefined();
      expect(r!.exports.find((e) => e.method === method)?.wrapper ?? null, key).toBeNull();
    }
  });

  it("istek gövdesi okuyan her durum değiştiren işleyici gövdeyi şemayla doğrular", () => {
    const READS = /\breq(?:uest)?\.(json|text|formData|arrayBuffer|blob)\(|\bbody\(|readUpload\(/;
    const VALIDATES = /\bbody\(\s*req(?:uest)?\s*,|\.(safeParse|parse)\(|readUpload\(/;
    const missing: string[] = [];
    for (const r of ROUTES) {
      if (!r.exports.some((e) => MUTATING.includes(e.method as never))) continue;
      if (!READS.test(r.source)) continue;
      if (VALIDATES.test(r.source) || r.rel in BODY_VALIDATION_ALLOWLIST) continue;
      missing.push(r.rel);
    }
    expect(missing).toEqual([]);
  });

  it("satır içi zod gövde şemaları bilinmeyen alanları reddeder (.strict)", () => {
    // `body(req, z.object({...}))` biçimindeki satır içi gövdeler `.strict()` olmalıdır: fazladan alan sessizce kabul
    // edilip ileride bir sütuna yazılmasın (toplu atama koruması). Ayrı dosyadaki şemalar kendi testleriyle sınanır.
    const loose: string[] = [];
    for (const r of ROUTES) {
      const sf = ts.createSourceFile(r.rel, r.source, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "body" &&
          n.arguments.length === 2
        ) {
          const schema = n.arguments[1]!;
          if (
            ts.isCallExpression(schema) &&
            ts.isPropertyAccessExpression(schema.expression) &&
            schema.expression.name.text === "object"
          )
            loose.push(r.rel);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // Faz 6 öncesinden kalan gevşek satır içi şemalar: zod bilinmeyen alanları ATAR ve işleyiciler alanları tek tek okur,
    // bu yüzden toplu atama yok. Yeni uçlar listeye eklenmemeli; mevcutlar sıkılaştırıldıkça listeden çıkarılır.
    expect(loose.filter((x) => !LEGACY_LOOSE_INLINE_SCHEMAS.includes(x))).toEqual([]);
    for (const x of LEGACY_LOOSE_INLINE_SCHEMAS) expect(loose, x).toContain(x);
  });
});

/** Bkz. yukarıdaki test; burada yalnızca var olan uçlar listelenir. */
const LEGACY_LOOSE_INLINE_SCHEMAS: string[] = [
  "api/dev/mock",
  "api/scans/[id]/control",
  "api/secrets",
  "api/setup/consent",
];
