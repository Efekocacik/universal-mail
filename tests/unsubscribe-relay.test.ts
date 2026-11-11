import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  MemoryEventQueue,
  MemoryRateLimiter,
  MemoryReplayStore,
  createRelayHandler,
  type RelayOptions,
} from "@/lib/unsubscribe/relay";
import {
  kidOfPublicKey,
  newClaims,
  signToken,
  type PublicKeyEntry,
  type UnsubscribeClaims,
} from "@/lib/unsubscribe/token";

/**
 * Taşınabilir HTTPS çıkış aktarıcısı (Aşama 15.6, RFC 8058). Yalnızca yerel testler: Request/Response ve 127.0.0.1
 * üzerindeki gerçek bir Node HTTP sunucusu (gerçek HTTPS/alan adı YOK).
 */

const NOW = Date.UTC(2026, 10, 10, 10, 0, 0);
const TAG = "B".repeat(22);
const BASE = "https://cikis.example.test";

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { privateKey, entry: { kid: kidOfPublicKey(x), x } as PublicKeyEntry };
}
const K = keypair();
const OTHER = keypair();

const mint = (over: Partial<UnsubscribeClaims> = {}, key = K, now = NOW): string =>
  signToken(
    {
      ...newClaims({ kid: key.entry.kid, campaignLeadId: 5, messageId: 6, recipientTag: TAG, now }),
      ...over,
    },
    key.privateKey,
  );

let queue: MemoryEventQueue;
function setup(extra: Partial<RelayOptions> = {}, now = NOW + 60_000) {
  queue = new MemoryEventQueue();
  return createRelayHandler({ keys: () => [K.entry], sink: queue, now: () => now, ...extra });
}

const FORM = "application/x-www-form-urlencoded";
const post = (
  token: string,
  body = "List-Unsubscribe=One-Click",
  headers: Record<string, string> = {},
) =>
  new Request(`${BASE}/u/${token}`, {
    method: "POST",
    headers: { "Content-Type": FORM, ...headers },
    body,
  });
const get = (token: string, method = "GET") => new Request(`${BASE}/u/${token}`, { method });

/** Hiçbir yanıt yönlendirme olmamalı; çerez ayarlanmamalı; önbelleğe alınmamalı. */
async function assertSafe(res: Response) {
  expect(res.status < 300 || res.status >= 400).toBe(true);
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("RFC 8058: POST tek tıklamalı çıkış", () => {
  it("geçerli POST: 200, olay BİR kez kuyruğa girer, yanıt belirteci/alıcıyı yansıtmaz, yönlendirme yok", async () => {
    const h = setup();
    const t = mint();
    const res = await h(post(t));
    await assertSafe(res);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(t);
    expect(queue.events).toEqual([{ v: 1, token: t, receivedAt: NOW + 60_000, via: "one_click" }]);
  });

  it("idempotent / tekrar oynatma: aynı belirteç tekrar gelirse 200, ikinci olay İLETİLMEZ", async () => {
    const h = setup();
    const t = mint();
    expect((await h(post(t))).status).toBe(200);
    expect((await h(post(t))).status).toBe(200);
    expect((await h(post(t))).status).toBe(200);
    expect(queue.events).toHaveLength(1);
    // başka belirteç (başka jti) ayrı olaydır
    expect((await h(post(mint()))).status).toBe(200);
    expect(queue.events).toHaveLength(2);
  });

  it("kuyruk yazılamazsa 503 + Retry-After; başarılı SAYILMAZ, kayıt tutulmaz; yeniden denemede iletilir", async () => {
    const h = setup();
    const t = mint();
    queue.failNext = 1;
    const r1 = await h(post(t));
    await assertSafe(r1);
    expect(r1.status).toBe(503);
    expect(r1.headers.get("retry-after")).toBe("60");
    expect(queue.events).toHaveLength(0);
    expect((await h(post(t))).status).toBe(200);
    expect(queue.events).toHaveLength(1);
    expect((await h(post(t))).status).toBe(200); // artık tekrar
    expect(queue.events).toHaveLength(1);
  });

  it("anahtar kaynağı hata verirse 503 ve olay yok", async () => {
    const h = setup({
      keys: () => {
        throw new Error("x");
      },
    });
    const res = await h(post(mint()));
    expect(res.status).toBe(503);
    expect(queue.events).toHaveLength(0);
  });

  it("gövde kuralları: eksik/yanlış alan değeri 400; yanlış içerik türü 415; aşırı büyük 413", async () => {
    const h = setup();
    const t = mint();
    for (const body of [
      "",
      "foo=bar",
      "List-Unsubscribe=Other",
      "List-Unsubscribe=one-click",
      "list-unsubscribe=One-Click",
      "List-Unsubscribe=",
    ]) {
      expect((await h(post(t, body))).status, body).toBe(400);
    }
    for (const ct of ["application/json", "text/plain", "multipart/form-data; boundary=x", ""]) {
      const req = new Request(`${BASE}/u/${t}`, {
        method: "POST",
        headers: ct ? { "Content-Type": ct } : {},
        body: "List-Unsubscribe=One-Click",
      });
      expect((await h(req)).status, ct).toBe(415);
    }
    // charset parametresi kabul edilir
    expect(
      (await h(post(t, "List-Unsubscribe=One-Click", { "Content-Type": `${FORM}; charset=UTF-8` })))
        .status,
    ).toBe(200);
    // içerik uzunluğu bildirimiyle ve bildirimsiz (akış) aşırı büyük
    const big = `List-Unsubscribe=One-Click&x=${"a".repeat(MAX_BODY_BYTES + 10)}`;
    expect((await h(post(mint(), big))).status).toBe(413);
    const stream = new Request(`${BASE}/u/${mint()}`, {
      method: "POST",
      headers: { "Content-Type": FORM },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      // @ts-expect-error duplex Node/undici gerektirir
      duplex: "half",
    });
    expect((await h(stream)).status).toBe(413);
    expect(queue.events).toHaveLength(1); // yalnızca charset'li geçerli istek
  });

  it("geçerli POST fazladan form alanlarını yok sayar", async () => {
    const h = setup();
    expect((await h(post(mint(), "foo=bar&List-Unsubscribe=One-Click&baz=1"))).status).toBe(200);
    expect(queue.events).toHaveLength(1);
  });
});

describe("sahte ve geçersiz istekler olay ÜRETMEZ", () => {
  it("geçersiz imza, değiştirilmiş yük, başka anahtar, biçim bozuk → 400; süresi dolmuş → 410; olay yok", async () => {
    const h = setup();
    const t = mint();
    const [p, pl, sg] = t.split(".") as [string, string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(pl, "base64url").toString()), c: 99 }),
    ).toString("base64url");
    const flipped = Buffer.from(sg, "base64url");
    flipped[3]! ^= 1;
    const expired = mint({}, K, NOW - 400 * 86_400_000);
    const future = mint({}, K, NOW + 3600_000 * 5);
    const cases: [string, string, number][] = [
      ["imza bozuk", `${p}.${pl}.${flipped.toString("base64url")}`, 400],
      ["yük değişmiş", `${p}.${tampered}.${sg}`, 400],
      ["başka anahtar", mint({}, OTHER), 400],
      ["biçim bozuk", "u2.abc.def", 400],
      ["JWT benzeri", "eyJhbGciOiJub25lIn0.eyJjIjo1fQ.", 400],
      ["henüz geçerli değil", future, 400],
      ["süresi dolmuş", expired, 410],
    ];
    for (const [name, token, status] of cases) {
      const res = await h(post(token));
      await assertSafe(res);
      expect(res.status, name).toBe(status);
      expect(await res.text(), name).not.toContain(token);
    }
    expect(queue.events).toHaveLength(0);
  });

  it("iptal edilen/kaldırılan anahtarın belirteçleri artık kabul edilmez (anahtar kümesi dinamik)", async () => {
    let keys: PublicKeyEntry[] = [K.entry];
    const h = setup({ keys: () => keys });
    const t = mint();
    expect((await h(post(t))).status).toBe(200);
    keys = [];
    expect((await h(post(mint()))).status).toBe(400);
    keys = [OTHER.entry, K.entry]; // döndürme: eski anahtar hâlâ listede
    expect((await h(post(mint()))).status).toBe(200);
  });

  it("yol ve yöntem sınırları: yalnızca /u/<belirteç>; sorgu dizgisi/başka yol 404; diğer yöntemler 405", async () => {
    const h = setup();
    const t = mint();
    for (const url of [
      `${BASE}/`,
      `${BASE}/u/`,
      `${BASE}/u/${t}/x`,
      `${BASE}/x/${t}`,
      `${BASE}/u?t=${t}`,
      `${BASE}/u/${"a".repeat(800)}`,
      `${BASE}/u/${t}%2F..`,
    ]) {
      const res = await h(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": FORM },
          body: "List-Unsubscribe=One-Click",
        }),
      );
      expect(res.status, url.slice(0, 50)).toBe(404);
    }
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await h(new Request(`${BASE}/u/${t}`, { method }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    }
    expect(queue.events).toHaveLength(0);
  });

  it("hız sınırı: aşılınca 429 + Retry-After, olay işlenmez; istemci anahtarına göre ayrı kovalar", async () => {
    const h = setup({
      limiter: new MemoryRateLimiter(3, 60_000),
      clientKey: (r) => r.headers.get("x-client") ?? "global",
    });
    const t = mint();
    const call = (c: string) => h(post(t, "List-Unsubscribe=One-Click", { "X-Client": c }));
    for (let i = 0; i < 3; i++) expect((await call("a")).status).toBe(200);
    const limited = await call("a");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await call("b")).status).toBe(200); // başka istemci
    expect(queue.events).toHaveLength(1); // tek jti
    // hız sınırı GET'e de uygulanır
    expect((await h(new Request(`${BASE}/u/${t}`, { headers: { "X-Client": "a" } }))).status).toBe(
      429,
    );
  });
});

describe("GET/HEAD durum DEĞİŞTİRMEZ (tarayıcı/tarayıcı-bot/ön yükleme güvenliği)", () => {
  it("geçerli GET: onay formu gösterir (POST ile), olay YOK; sayfa belirteci içermez; CSP var", async () => {
    const h = setup();
    const t = mint();
    const res = await h(get(t));
    await assertSafe(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).toContain('method="post"');
    expect(page).toContain('name="List-Unsubscribe"');
    expect(page).not.toContain(t);
    expect(queue.events).toHaveLength(0);
    // tekrarlı GET/HEAD da hiçbir şey yapmaz
    for (let i = 0; i < 3; i++) await h(get(t));
    const head = await h(get(t, "HEAD"));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(queue.events).toHaveLength(0);
  });

  it("geçersiz GET 400, süresi dolmuş GET 410; ikisi de form ve belirteç içermez", async () => {
    const h = setup();
    const bad = await h(get("u2.abc.def"));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("<form");
    const exp = await h(get(mint({}, K, NOW - 400 * 86_400_000)));
    expect(exp.status).toBe(410);
    expect(await exp.text()).not.toContain("<form");
    expect(queue.events).toHaveLength(0);
  });

  it("onay formu (GET sonrası) POST ile çıkışı kaydeder", async () => {
    const h = setup();
    const t = mint();
    await h(get(t));
    expect(queue.events).toHaveLength(0);
    expect((await h(post(t))).status).toBe(200);
    expect(queue.events).toHaveLength(1);
  });
});

describe("bellek içi yardımcılar", () => {
  it("tekrar oynatma kaydı sınırlıdır (en eski atılır)", () => {
    const s = new MemoryReplayStore(3);
    for (const j of ["a", "b", "c", "d"]) s.remember(j, Date.now() + 100_000);
    expect(s.seen("d")).toBe(true);
    expect(s.seen("a")).toBe(false);
  });
  it("hız sınırlayıcı pencere dolunca sıfırlanır", () => {
    const l = new MemoryRateLimiter(1, 1000);
    expect(l.check("k", 0)).toBeNull();
    expect(l.check("k", 10)).not.toBeNull();
    expect(l.check("k", 1500)).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ */

let server: http.Server | null = null;
afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => {
      server!.closeAllConnections?.();
      server!.close(() => r());
    });
    server = null;
  }
});

/** Gerçek Node HTTP sunucusu (127.0.0.1): bir posta istemcisi gibi gerçek POST. */
async function serve(handler: (r: Request) => Promise<Response>): Promise<string> {
  server = http.createServer(async (req, res) => {
    const url = `http://127.0.0.1${req.url}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url.replace("http://127.0.0.1", BASE), {
      method: req.method,
      headers: req.headers as Record<string, string>,
      ...(hasBody
        ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" }
        : {}),
    } as RequestInit);
    const out = await handler(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("gerçek HTTP üzerinden (127.0.0.1), posta istemcisi gibi", () => {
  it("RFC 8058 isteği: POST, form gövdesi, yönlendirme izlenmez → 200; tekrar → 200, tek olay", async () => {
    const h = setup();
    const origin = await serve(h);
    const t = mint();
    const send = () =>
      fetch(`${origin}/u/${t}`, {
        method: "POST",
        headers: { "Content-Type": FORM },
        body: "List-Unsubscribe=One-Click",
        redirect: "manual",
      });
    const r1 = await send();
    expect(r1.status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(queue.events).toHaveLength(1);
    // tarayıcı önizleme/güvenlik tarayıcısı GET'i durum değiştirmez
    const g = await fetch(`${origin}/u/${mint()}`, { redirect: "manual" });
    expect(g.status).toBe(200);
    expect(queue.events).toHaveLength(1);
  });

  it("çerezli/kimlik doğrulamalı istek gerekmez ve çerez ayarlanmaz", async () => {
    const h = setup();
    const origin = await serve(h);
    const res = await fetch(`${origin}/u/${mint()}`, {
      method: "POST",
      headers: { "Content-Type": FORM },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
