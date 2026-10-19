import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { crawlSite, type CrawlOptions } from "@/lib/email/crawler";
import { RobotsPolicy } from "@/lib/email/robots";
import { FetchError, isPrivateAddress, safeFetch } from "@/lib/email/safe-fetch";
import { verifyEmail, type Resolver, type VerifyResult } from "@/lib/email/verify";

/* ------------------------------ yerel test sunucusu ------------------------------ */

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Yanıtı geciktir (ms). */
  delay?: number;
}
type Routes = Record<string, Route | ((req: http.IncomingMessage) => Route)>;

const servers: http.Server[] = [];

async function serve(routes: Routes): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    const entry = routes[path] ?? routes[path.split("?")[0]!] ?? { status: 404, body: "not found" };
    const r = typeof entry === "function" ? entry(req) : entry;
    const send = () => {
      res.writeHead(r.status ?? 200, { "content-type": "text/html; charset=utf-8", ...r.headers });
      res.end(r.body ?? "");
    };
    if (r.delay) setTimeout(send, r.delay);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        }),
    ),
  );
});

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

function opts(over: Partial<CrawlOptions> = {}): CrawlOptions & { waits: number[] } {
  const waits: number[] = [];
  return {
    fetch: safeFetch,
    sleep: async (ms) => void waits.push(ms),
    userAgent: "UniversalMail/test (+https://example.test)",
    agentToken: "UniversalMail",
    delayMs: 0,
    maxRequests: 6,
    timeoutMs: 2000,
    language: "en",
    allowPrivate: true,
    waits,
    ...over,
  };
}

/* ---------------------------------- doğrulama ---------------------------------- */

function fakeResolver(
  map: Record<string, "mx" | "a" | "none" | "nullmx" | "timeout">,
): Resolver & { calls: number } {
  const err = (code: string) => Object.assign(new Error(code), { code });
  const r = {
    calls: 0,
    resolveMx: async (h: string) => {
      r.calls++;
      const v = map[h] ?? "none";
      if (v === "mx") return [{ exchange: `mx.${h}`, priority: 10 }];
      if (v === "nullmx") return [{ exchange: "", priority: 0 }];
      if (v === "timeout") throw err("ETIMEOUT");
      throw err("ENODATA");
    },
    resolve4: async (h: string) => {
      const v = map[h] ?? "none";
      if (v === "a") return ["203.0.113.5"];
      if (v === "timeout") throw err("ETIMEOUT");
      throw err("ENOTFOUND");
    },
    resolve6: async () => {
      throw err("ENODATA");
    },
  };
  return r;
}

describe("e-posta doğrulama", () => {
  const resolver = fakeResolver({
    "good.test": "mx",
    "implicit.test": "a",
    "dead.test": "none",
    "null.test": "nullmx",
    "slow.test": "timeout",
    "gmail.com": "mx",
  });

  it.each<[string, string, string]>([
    ["info@good.test", "verified", "ok_mx"],
    ["info@implicit.test", "verified", "ok_a"],
    ["info@dead.test", "invalid", "no_mx"],
    ["info@null.test", "invalid", "null_mx"],
    ["info@slow.test", "unverified", "dns_timeout"],
    ["x@mailinator.com", "invalid", "disposable"],
    ["not-an-email", "invalid", "syntax"],
    ["someone@gmail.com", "unverified", "consumer_domain"],
  ])("%s → %s (%s)", async (email, status, reason) => {
    expect(await verifyEmail(email, resolver)).toEqual({ status, reason });
  });

  it("aynı alan adı için DNS bir kez sorulur; geçici hatalar önbelleğe alınmaz", async () => {
    const r = fakeResolver({ "good.test": "mx", "slow.test": "timeout" });
    const cache = new Map<string, VerifyResult>();
    await verifyEmail("a@good.test", r, cache);
    await verifyEmail("b@good.test", r, cache);
    expect(r.calls).toBe(1);
    await verifyEmail("a@slow.test", r, cache);
    await verifyEmail("b@slow.test", r, cache);
    expect(r.calls).toBe(3);
  });
});

/* ---------------------------------- robots.txt ---------------------------------- */

describe("robots.txt", () => {
  const token = "UniversalMail";

  it("özel grup varsa * grubunu yok sayar", () => {
    const p = RobotsPolicy.parse(
      "User-agent: *\nDisallow: /\n\nUser-agent: UniversalMail\nDisallow: /private\n",
      token,
    );
    expect(p.isAllowed("/contact")).toBe(true);
    expect(p.isAllowed("/private/x")).toBe(false);
  });

  it("* grubu: her şey yasak, Allow ile istisna; en uzun kural kazanır", () => {
    const p = RobotsPolicy.parse("User-agent: *\nDisallow: /\nAllow: /contact\n", token);
    expect(p.isAllowed("/")).toBe(false);
    expect(p.isAllowed("/menu")).toBe(false);
    expect(p.isAllowed("/contact")).toBe(true);
    expect(p.isAllowed("/contact-us")).toBe(true);
  });

  it("eşit uzunlukta Allow kazanır; boş Disallow her şeye izin verir", () => {
    expect(
      RobotsPolicy.parse("User-agent: *\nDisallow: /a\nAllow: /a\n", token).isAllowed("/a"),
    ).toBe(true);
    expect(RobotsPolicy.parse("User-agent: *\nDisallow:\n", token).isAllowed("/anything")).toBe(
      true,
    );
  });

  it("joker (*) ve satır sonu ($) desteklenir", () => {
    const p = RobotsPolicy.parse(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n",
      token,
    );
    expect(p.isAllowed("/menu.pdf")).toBe(false);
    expect(p.isAllowed("/menu.pdf?x=1")).toBe(true);
    expect(p.isAllowed("/tmp123/cache")).toBe(false);
  });

  it("birden çok User-agent satırı aynı grubu paylaşır; yorumlar ve bozuk satırlar atlanır; Crawl-delay okunur", () => {
    const p = RobotsPolicy.parse(
      "# merhaba\nUser-agent: Googlebot\nUser-agent: UniversalMail # bizim\nCrawl-delay: 3\nDisallow: /x\nbozuk satır\n",
      token,
    );
    expect(p.isAllowed("/x")).toBe(false);
    expect(p.crawlDelayMs).toBe(3000);
    expect(RobotsPolicy.allowAll().isAllowed("/")).toBe(true);
  });
});

/* ------------------------------- güvenli HTTP istemcisi ------------------------------- */

describe("iç ağ adresi denetimi", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2001:db8::1",
    "geçersiz",
  ])("özel/ayrılmış: %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "genel: %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("safeFetch", () => {
  const base = { userAgent: "UniversalMail/test", timeoutMs: 1500, allowPrivate: true };

  it("üretim ayarında iç ağ adreslerini, yerel adları ve olağan dışı portları reddeder", async () => {
    const srv = await serve({ "/": { body: "gizli" } });
    for (const url of [
      srv.origin,
      "http://localhost/",
      "http://10.0.0.5/",
      "http://[::1]/",
      "http://printer.local/",
    ])
      await expect(safeFetch(url, { userAgent: "x", timeoutMs: 800 })).rejects.toMatchObject({
        kind: "blocked_address",
      });
    expect(srv.hits).toEqual([]); // sunucuya hiç bağlanılmadı
    await expect(safeFetch("ftp://x.test/", { userAgent: "x" })).rejects.toMatchObject({
      kind: "bad_url",
    });
    await expect(safeFetch("https://user:pw@x.test/", { userAgent: "x" })).rejects.toMatchObject({
      kind: "bad_url",
    });
    await expect(safeFetch("kötü adres", { userAgent: "x" })).rejects.toMatchObject({
      kind: "bad_url",
    });
  });

  it("HTML gövdeyi okur, kimlik başlığını gönderir; 404 hata fırlatmaz", async () => {
    let seenUa = "";
    const srv = await serve({
      "/": (req) => {
        seenUa = String(req.headers["user-agent"]);
        return { body: page("merhaba") };
      },
    });
    const ok = await safeFetch(`${srv.origin}/`, base);
    expect(ok).toMatchObject({ status: 200, skippedBody: false, truncated: false });
    expect(ok.body).toContain("merhaba");
    expect(seenUa).toBe("UniversalMail/test");
    expect((await safeFetch(`${srv.origin}/yok`, base)).status).toBe(404);
  });

  it("gzip ve brotli yanıtları açar", async () => {
    const srv = await serve({
      "/gz": {
        headers: { "content-encoding": "gzip" },
        body: zlib.gzipSync(page("sıkıştırılmış gz")),
      },
      "/br": {
        headers: { "content-encoding": "br" },
        body: zlib.brotliCompressSync(page("sıkıştırılmış br")),
      },
    });
    expect((await safeFetch(`${srv.origin}/gz`, base)).body).toContain("sıkıştırılmış gz");
    expect((await safeFetch(`${srv.origin}/br`, base)).body).toContain("sıkıştırılmış br");
  });

  it("boyut sınırında keser (açılmış boyut dahil: gzip bombası)", async () => {
    const big = "a".repeat(200_000);
    const srv = await serve({
      "/big": { body: big },
      "/bomb": {
        headers: { "content-encoding": "gzip" },
        body: zlib.gzipSync("b".repeat(5_000_000)),
      },
    });
    const r = await safeFetch(`${srv.origin}/big`, { ...base, maxBytes: 50_000 });
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(50_000);
    const bomb = await safeFetch(`${srv.origin}/bomb`, { ...base, maxBytes: 100_000 });
    expect(bomb.truncated).toBe(true);
    expect(bomb.body.length).toBeLessThanOrEqual(100_000);
  });

  it("HTML olmayan içeriğin gövdesini indirmez", async () => {
    const srv = await serve({
      "/f.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.4 ..." },
    });
    expect(await safeFetch(`${srv.origin}/f.pdf`, base)).toMatchObject({
      skippedBody: true,
      body: "",
    });
  });

  it("başlıktaki karakter kümesini kullanır (ISO-8859-1)", async () => {
    const srv = await serve({
      "/": {
        headers: { "content-type": "text/html; charset=iso-8859-1" },
        body: Buffer.from("café", "latin1"),
      },
    });
    expect((await safeFetch(`${srv.origin}/`, base)).body).toBe("café");
  });

  it("yönlendirmeleri izler; izin verilmeyen siteye, sınırı aşan zincire ve bozuk adrese hata verir", async () => {
    const srv = await serve({
      "/a": { status: 301, headers: { location: "/b" } },
      "/b": { body: page("b sayfası") },
      "/loop": { status: 302, headers: { location: "/loop" } },
      "/out": { status: 302, headers: { location: "http://baska-site.test/" } },
      "/bad": { status: 302, headers: { location: "http://[bozuk" } },
    });
    const r = await safeFetch(`${srv.origin}/a`, base);
    expect(r.body).toContain("b sayfası");
    expect(r.url).toBe(`${srv.origin}/b`);
    expect(r.hops).toBe(1);
    await expect(safeFetch(`${srv.origin}/loop`, base)).rejects.toMatchObject({
      kind: "too_many_redirects",
    });
    await expect(
      safeFetch(`${srv.origin}/out`, {
        ...base,
        allowRedirect: (_f, to) => to.hostname === "127.0.0.1",
      }),
    ).rejects.toMatchObject({ kind: "cross_site_redirect" });
    await expect(safeFetch(`${srv.origin}/bad`, base)).rejects.toMatchObject({ kind: "bad_url" });
  });

  it("yanıt gelmezse zaman aşımına uğrar (geçici hata); bağlantı reddedilirse ağ hatası verir", async () => {
    const srv = await serve({ "/slow": { delay: 1500, body: "geç" } });
    const e = await safeFetch(`${srv.origin}/slow`, { ...base, timeoutMs: 200 }).catch((x) => x);
    expect(e).toBeInstanceOf(FetchError);
    expect(e).toMatchObject({ kind: "timeout", retryable: true });
    const closed = await safeFetch("http://127.0.0.1:1/", base).catch((x) => x);
    expect(closed).toMatchObject({ kind: "network", retryable: true });
  });
});

/* ------------------------------------ tarayıcı ------------------------------------ */

describe("crawlSite", () => {
  it("ana sayfadaki mailto'yu ve bir iletişim sayfasını bulur; kaynak sayfaları kaydeder", async () => {
    const srv = await serve({
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /admin\n",
      },
      "/": {
        body: page(
          `<a href="/contact">Contact</a><a href="mailto:hello@bean.test">mail</a><a href="https://www.instagram.com/beanroasters/">ig</a>`,
        ),
      },
      "/contact": {
        body: page(
          `<p>Manager: sarah@bean.test</p><form><input type="email" name="email"><textarea name="m"></textarea></form>`,
        ),
      },
    });
    const r = await crawlSite(srv.origin + "/", opts());
    expect(r.outcome).toBe("ok");
    expect(r.emails.map((e) => `${e.email}@${new URL(e.sourceUrl).pathname}`).sort()).toEqual([
      "hello@bean.test@/",
      "sarah@bean.test@/contact",
    ]);
    expect(r.contacts.map((c) => c.type).sort()).toEqual(["contact_form", "instagram"]);
    expect(r.pages).toHaveLength(2);
    expect(srv.hits[0]).toBe("/robots.txt"); // önce robots.txt
  });

  it("adresi ana sayfada bulunca en fazla bir sayfa daha dener (nazik tarama)", async () => {
    const srv = await serve({
      "/": { body: page(`<a href="mailto:info@quick.test">m</a>`) },
      "/contact": { body: page("boş") },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r.requests).toBeLessThanOrEqual(3);
    expect(r.emails).toHaveLength(1);
  });

  it("ana sayfadaki bağlantıdan keşfedilen, standart listede olmayan sayfayı bulur", async () => {
    const srv = await serve({
      "/": { body: page(`<a href="/ulasim-ve-iletisim">İletişim</a>`) },
      "/ulasim-ve-iletisim": { body: page("Yazın: bilgi@kafe-test.test") },
    });
    const r = await crawlSite(srv.origin, opts({ language: "tr" }));
    expect(r.emails.map((e) => e.email)).toEqual(["bilgi@kafe-test.test"]);
  });

  it("site başına istek sınırı: her sayfa 404 olsa bile en fazla 6 istek", async () => {
    const srv = await serve({ "/": { body: page("<p>hiçbir şey</p>") } });
    const r = await crawlSite(srv.origin, opts());
    expect(r.outcome).toBe("ok");
    expect(r.emails).toEqual([]);
    expect(r.requests).toBe(6);
    expect(srv.hits.length).toBe(6);
  });

  it("istekler arasında en az delayMs ve sitenin Crawl-delay değeri beklenir", async () => {
    const srv = await serve({
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nCrawl-delay: 2\n",
      },
      "/": { body: page("x") },
    });
    const o = opts({ delayMs: 1000, sleep: undefined as never });
    const clock = { now: Date.now() };
    const waits: number[] = [];
    o.sleep = async (ms) => {
      waits.push(ms);
      clock.now += ms;
    };
    const r = await crawlSite(srv.origin, o);
    expect(r.requests).toBe(6);
    // İlk istek beklemez; sonrakiler >= Crawl-delay (2 sn) ve delayMs'in büyüğü kadar bekler (gerçek süre kısa olduğundan ≈2000)
    expect(waits.length).toBe(5);
    expect(waits.every((w) => w >= 1500 && w <= 2000)).toBe(true);
  });

  it("robots.txt her şeyi yasaklıyorsa tek istek (robots.txt) yapılır ve sonuç 'blocked' olur", async () => {
    const srv = await serve({
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /\n",
      },
      "/": { body: page("a@b.test") },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r).toMatchObject({
      outcome: "blocked",
      retryable: false,
      reason: "robots_disallow",
      requests: 1,
    });
    expect(srv.hits).toEqual(["/robots.txt"]);
  });

  it("yasaklı iletişim sayfasını atlar, izinli olanı dener", async () => {
    const srv = await serve({
      "/robots.txt": {
        headers: { "content-type": "text/plain" },
        body: "User-agent: *\nDisallow: /contact\n",
      },
      "/": { body: page(`<a href="/contact">Contact</a><a href="/kontakt">Kontakt</a>`) },
      "/contact": { body: page("gizli@bean.test") },
      "/kontakt": { body: page("ok@bean.test") },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r.emails.map((e) => e.email)).toEqual(["ok@bean.test"]);
    expect(srv.hits).not.toContain("/contact");
  });

  it("robots.txt 403 → engel (yeniden denenmez); 404 → serbest; 5xx → geçici hata", async () => {
    const forbidden = await serve({
      "/robots.txt": { status: 403 },
      "/": { body: page("x@y.test") },
    });
    expect(await crawlSite(forbidden.origin, opts())).toMatchObject({
      outcome: "blocked",
      retryable: false,
      reason: "robots_forbidden",
    });
    const free = await serve({ "/": { body: page(`<a href="mailto:a@free.test">m</a>`) } });
    expect((await crawlSite(free.origin, opts())).emails).toHaveLength(1);
    const down = await serve({ "/robots.txt": { status: 503 } });
    expect(await crawlSite(down.origin, opts())).toMatchObject({
      outcome: "failed",
      retryable: true,
      reason: "robots_unavailable",
    });
  });

  it("ana sayfa hataları: 403/Cloudflare = engel; 429 ve 5xx = geçici; 404 = kalıcı", async () => {
    const run = async (route: Route) => crawlSite((await serve({ "/": route })).origin, opts());
    expect(await run({ status: 403 })).toMatchObject({ outcome: "blocked", retryable: false });
    expect(
      await run({
        status: 503,
        headers: { server: "cloudflare" },
        body: "<title>Just a moment...</title>",
      }),
    ).toMatchObject({ outcome: "blocked", retryable: false });
    expect(
      await run({ status: 200, headers: { "cf-mitigated": "challenge" }, body: "x" }),
    ).toMatchObject({
      outcome: "blocked",
    });
    expect(await run({ status: 429 })).toMatchObject({
      outcome: "failed",
      retryable: true,
      reason: "http_429",
    });
    expect(await run({ status: 502 })).toMatchObject({
      outcome: "failed",
      retryable: true,
      reason: "http_5xx",
    });
    expect(await run({ status: 404 })).toMatchObject({
      outcome: "failed",
      retryable: false,
      reason: "http_404",
    });
    expect(await run({ status: 418 })).toMatchObject({ outcome: "failed", retryable: false });
  });

  it("alt sayfa engeli (403/429) taramayı durdurur ama ana sayfadan bulunanlar korunur", async () => {
    const srv = await serve({
      "/": { body: page(`<a href="/contact">c</a><a href="mailto:keep@bean.test">m</a>`) },
      "/contact": { status: 429 },
      "/kontakt": { body: page("never@bean.test") },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r.outcome).toBe("ok");
    expect(r.emails.map((e) => e.email)).toEqual(["keep@bean.test"]);
    expect(srv.hits).not.toContain("/kontakt");
  });

  it("aynı site içi yönlendirmeleri izler ve her yönlendirmeyi istek sayar; başka siteye yönlenmeyi reddeder", async () => {
    const srv = await serve({
      "/": { status: 301, headers: { location: "/home" } },
      "/home": { body: page(`<a href="mailto:a@redir.test">m</a>`) },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r.outcome).toBe("ok");
    expect(r.requests).toBeGreaterThanOrEqual(3); // robots + ana sayfa + 1 yönlendirme (+ sonrası)

    const away = await serve({ "/": { status: 302, headers: { location: "http://baska.test/" } } });
    expect(await crawlSite(away.origin, opts())).toMatchObject({
      outcome: "failed",
      retryable: false,
      reason: "cross_site_redirect",
    });
  });

  it("yanıt vermeyen site geçici hata olarak işaretlenir", async () => {
    const srv = await serve({ "/robots.txt": { delay: 1500, body: "" } });
    expect(await crawlSite(srv.origin, opts({ timeoutMs: 200 }))).toMatchObject({
      outcome: "failed",
      retryable: true,
      reason: "timeout",
    });
  });

  it("üretim ayarında iç ağ adresindeki site taranmaz (kalıcı hata)", async () => {
    const r = await crawlSite(
      "http://169.254.169.254/latest/meta-data/",
      opts({ allowPrivate: false }),
    );
    expect(r).toMatchObject({ outcome: "failed", retryable: false, reason: "blocked_address" });
  });

  it("geçersiz adresi reddeder; şemasız adrese https ekler", async () => {
    expect(await crawlSite("javascript:alert(1)", opts())).toMatchObject({
      outcome: "failed",
      reason: "bad_url",
    });
    expect(await crawlSite("   ", opts())).toMatchObject({ outcome: "failed", reason: "bad_url" });
    const seen: string[] = [];
    await crawlSite(
      "kafe.test",
      opts({
        fetch: async (u) => (
          seen.push(u),
          { url: u, status: 404, headers: {}, body: "", skippedBody: false, truncated: false }
        ),
      }),
    );
    expect(seen[0]).toBe("https://kafe.test/robots.txt");
  });

  it("neredeyse boş (JavaScript ile oluşan) ana sayfa için ipucu verir", async () => {
    const srv = await serve({
      "/": { body: `<div id="root"></div><script src="/app.js"></script>` },
    });
    const r = await crawlSite(srv.origin, opts());
    expect(r.jsHint).toBe(true);
    expect(r.emails).toEqual([]);
  });

  it("durdurma isteği gelince yeni istek yapılmaz", async () => {
    const srv = await serve({ "/": { body: page("x") } });
    const r = await crawlSite(srv.origin, opts({ shouldStop: () => true }));
    expect(r).toMatchObject({ outcome: "failed", retryable: true, reason: "stopped", requests: 0 });
  });
});
