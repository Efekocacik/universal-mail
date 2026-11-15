import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as externalTestRoute from "@/app/api/enrichment/external/test/route";
import * as enrichmentRoute from "@/app/api/enrichment/route";
import * as secretsRoute from "@/app/api/secrets/route";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { createEmailDeps, externalStatus } from "@/lib/email/deps";
import {
  clearSnovTokenCache,
  createDemoExternalProvider,
  createSnovProvider,
  ExternalProviderError,
  type SnovFetch,
} from "@/lib/email/external";
import { setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Snov.io istemcisi (sahte HTTP, sentetik yanıt fikstürleri): OAuth belirteci ve önbelleği, alan adı araması (başlat →
 * yokla → tamamlandı), yanıttaki bağlantıların izlenmemesi, bakiye → kota, hata türleri; ayrıca sağlayıcı seçimi
 * (`externalStatus`, demo sağlayıcı) ve `/api/enrichment/external/test` sağlayıcı anahtarı. Gerçek Snov çağrılmaz.
 */

type Call = { url: string; method?: string; headers: Record<string, string>; body?: string };
type Reply = { status: number; body?: unknown } | Error;

function snovFake(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const fn: SnovFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const key = `${init.method ?? "GET"} ${url}`;
    const entry = routes[key];
    if (!entry) return { status: 404, json: async () => ({}) };
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const r = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)]! : entry;
    if (r instanceof Error) throw r;
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { fn, calls };
}

const TOKEN = "POST https://api.snov.io/v1/oauth/access_token";
const START = "POST https://api.snov.io/v2/domain-search/domain-emails/start";
const RESULT = (h: string) => `GET https://api.snov.io/v2/domain-search/domain-emails/result/${h}`;
const BALANCE = "GET https://api.snov.io/v1/get-balance";
const tokenOk = {
  status: 200,
  body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 },
};
const started = {
  status: 200,
  body: {
    data: [],
    meta: { domain: "kahve.example", task_hash: "abc123" },
    links: { result: "https://evil.example/steal" },
  },
};

const provider = (fn: SnovFetch, o: { now?: () => number } = {}) =>
  createSnovProvider({
    clientId: "client-id-test",
    clientSecret: "client-secret-test",
    fetchImpl: fn,
    sleep: async () => undefined,
    ...o,
  });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExternalProviderError) return e.kind;
    throw e;
  }
  return "ok";
}

beforeEach(() => clearSnovTokenCache());

describe("Snov istemcisi", () => {
  it("belirteç → arama başlat → yokla (sürüyor → tamamlandı); yalnızca alan adı gider; bağlantılar izlenmez", async () => {
    const { fn, calls } = snovFake({
      [TOKEN]: tokenOk,
      [START]: started,
      [RESULT("abc123")]: [
        { status: 200, body: { data: [], status: "in_progress" } },
        {
          status: 200,
          body: {
            status: "completed",
            data: [{ email: "info@kahve.example" }, { email: "owner@kahve.example" }, { nope: 1 }],
            meta: { total_count: 2 },
          },
        },
      ],
    });
    const hits = await provider(fn).search("kahve.example");
    expect(hits).toEqual([
      { email: "info@kahve.example", confidence: null, sourceUrl: null },
      { email: "owner@kahve.example", confidence: null, sourceUrl: null },
    ]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      TOKEN,
      START,
      RESULT("abc123"),
      RESULT("abc123"),
    ]);
    // Belirteç ucu: form gövdesi (Snov örnekleri ve OAuth 2 standardı), JSON değil
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body!))).toEqual({
      grant_type: "client_credentials",
      client_id: "client-id-test",
      client_secret: "client-secret-test",
    });
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ domain: "kahve.example" });
    expect(calls[1]!.headers.authorization).toBe("Bearer tok-1");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("belirteç süresi dolana kadar (−60 sn) yeniden kullanılır; dolunca yenilenir", async () => {
    let now = 1_000_000;
    const { fn, calls } = snovFake({
      [TOKEN]: tokenOk,
      [BALANCE]: {
        status: 200,
        body: { success: true, data: { balance: "25.00", limit_resets_in: 10 } },
      },
    });
    const p = provider(fn, { now: () => now });
    await p.quota();
    await p.quota();
    expect(calls.filter((c) => c.url.endsWith("access_token"))).toHaveLength(1);
    now += (3600 - 59) * 1000;
    await p.quota();
    expect(calls.filter((c) => c.url.endsWith("access_token"))).toHaveLength(2);
  });

  it("bakiye → kalan hak (aşağı yuvarlanır) ve yenilenme tarihi; bilinmeyen biçim → null", async () => {
    const now = Date.UTC(2026, 10, 15);
    const a = snovFake({
      [TOKEN]: tokenOk,
      [BALANCE]: { status: 200, body: { data: { balance: "149.75", limit_resets_in: 16 } } },
    });
    expect(await provider(a.fn, { now: () => now }).quota()).toEqual({
      remaining: 149,
      resetDate: "2026-12-01",
    });
    clearSnovTokenCache();
    const b = snovFake({
      [TOKEN]: tokenOk,
      [BALANCE]: { status: 200, body: { data: { balance: 7 } } },
    });
    expect(await provider(b.fn).quota()).toEqual({ remaining: 7, resetDate: null });
    clearSnovTokenCache();
    const c = snovFake({ [TOKEN]: tokenOk, [BALANCE]: { status: 200, body: {} } });
    expect(await provider(c.fn).quota()).toEqual({ remaining: null, resetDate: null });
  });

  it("yoklama süresi dolarsa sonuç yok; geçersiz görev kimliği bad_response", async () => {
    const pending = snovFake({
      [TOKEN]: tokenOk,
      [START]: started,
      [RESULT("abc123")]: { status: 200, body: { status: "in_progress", data: [] } },
    });
    expect(await provider(pending.fn).search("kahve.example")).toEqual([]);
    expect(pending.calls.filter((c) => c.url.includes("/result/"))).toHaveLength(6);
    clearSnovTokenCache();
    const weird = snovFake({
      [TOKEN]: tokenOk,
      [START]: { status: 200, body: { meta: { task_hash: "../../v1/get-balance" } } },
    });
    expect(await kindOf(provider(weird.fn).search("kahve.example"))).toBe("bad_response");
  });

  it.each<[string, Record<string, Reply>, string]>([
    ["belirteç 400", { [TOKEN]: { status: 400, body: { error: "invalid_client" } } }, "auth"],
    ["belirteç 401", { [TOKEN]: { status: 401 } }, "auth"],
    ["belirteçsiz yanıt", { [TOKEN]: { status: 200, body: {} } }, "bad_response"],
    ["arama 401", { [TOKEN]: tokenOk, [START]: { status: 401 } }, "auth"],
    ["arama 402", { [TOKEN]: tokenOk, [START]: { status: 402 } }, "quota"],
    ["arama 429", { [TOKEN]: tokenOk, [START]: { status: 429 } }, "rate_limit"],
    ["arama 500", { [TOKEN]: tokenOk, [START]: { status: 500 } }, "bad_response"],
    ["ağ hatası", { [TOKEN]: new Error("ECONNRESET") }, "network"],
  ])("%s → %s", async (_n, routes, kind) => {
    expect(await kindOf(provider(snovFake(routes).fn).search("kahve.example"))).toBe(kind);
  });

  it("401 sonrası önbellekteki belirteç atılır (anahtar değişince yeniden alınır)", async () => {
    const { fn, calls } = snovFake({
      [TOKEN]: tokenOk,
      [BALANCE]: [{ status: 401 }, { status: 200, body: { data: { balance: 3 } } }],
    });
    const p = provider(fn);
    expect(await kindOf(p.quota())).toBe("auth");
    expect(await p.quota()).toMatchObject({ remaining: 3 });
    expect(calls.filter((c) => c.url.endsWith("access_token"))).toHaveLength(2);
  });

  it("demo sağlayıcı: yalnızca .example alan adları, sabit kota, seçilen kimlikle", async () => {
    const d = createDemoExternalProvider("snov");
    expect(d.id).toBe("snov");
    expect(await d.search("Kahve.Example")).toEqual([
      { email: "contact@kahve.example", confidence: 60, sourceUrl: null },
    ]);
    expect(await d.search("kahve.co.uk")).toEqual([]);
    expect(await d.quota()).toEqual({ remaining: 25, resetDate: null });
  });
});

/* ------------------------------ seçim ve sınama ucu ------------------------------ */

const ORIGIN = "http://127.0.0.1:3000";
let t: TestDb;
let db: Db;
const req = (method: string, url: string, body?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const saveSecret = (name: string, value: string) =>
  secretsRoute.POST(req("POST", "/api/secrets", { name, value }), undefined);
const testExternal = (body?: unknown) =>
  externalTestRoute.POST(req("POST", "/api/enrichment/external/test", body), undefined);

describe("sağlayıcı seçimi ve /api/enrichment/external/test", () => {
  beforeEach(async () => {
    t = await createTestDb();
    await initDatabase();
    db = await getDb();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.cleanup();
  });

  it("externalStatus: Snov için kimlik VE sır gerekir; demo kipinde anahtarsız kullanılabilir", async () => {
    await setSetting(db, "places.provider", "google");
    await setSetting(db, "enrichment.external", { enabled: true, provider: "snov" });
    expect(await externalStatus(db)).toEqual({
      enabled: true,
      provider: "snov",
      configured: false,
      demo: false,
      available: false,
    });
    await saveSecret("snov.clientId", "client-id-test");
    expect((await externalStatus(db)).configured).toBe(false);
    await saveSecret("snov.clientSecret", "client-secret-test");
    expect(await externalStatus(db)).toMatchObject({ configured: true, available: true });
    expect((await createEmailDeps(db, { useExternal: true })).external?.id).toBe("snov");
    expect((await createEmailDeps(db, { useExternal: false })).external).toBeNull();

    await setSetting(db, "places.provider", "mock");
    await setSetting(db, "enrichment.external", { enabled: true, provider: "hunter" });
    expect(await externalStatus(db)).toMatchObject({
      demo: true,
      configured: false,
      available: true,
    });
    const demoExt = (await createEmailDeps(db, { useExternal: true })).external!;
    expect(demoExt.id).toBe("hunter");
    expect(await demoExt.search("kahve.example")).toHaveLength(1);

    await setSetting(db, "enrichment.external", { enabled: false, provider: "hunter" });
    expect((await createEmailDeps(db, { useExternal: true })).external).toBeNull();
    const status = await json(await enrichmentRoute.GET(req("GET", "/api/enrichment"), undefined));
    expect(status.external).toMatchObject({ enabled: false, provider: "hunter", demo: true });
  });

  it("demo: ağa çıkmadan sabit kota; sağlayıcı gövdeden seçilir; bilinmeyen sağlayıcı 400", async () => {
    await setSetting(db, "places.provider", "mock");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await json(await testExternal({ provider: "snov" }))).toEqual({
      ok: true,
      provider: "snov",
      demo: true,
      remaining: 25,
      resetDate: null,
    });
    expect((await json(await testExternal())).provider).toBe("hunter"); // gövdesiz: ayardaki sağlayıcı
    expect(spy).not.toHaveBeenCalled();
    expect((await testExternal({ provider: "apollo" })).status).toBe(400);
  });

  it("canlı Snov: anahtar yok 400 EXTERNAL_KEY_MISSING; geçerli 200; reddedilen 400 EXTERNAL_AUTH; kota 429", async () => {
    await setSetting(db, "places.provider", "google");
    const missing = await testExternal({ provider: "snov" });
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({ code: "EXTERNAL_KEY_MISSING", provider: "snov" });
    const hunterMissing = await testExternal({ provider: "hunter" });
    expect((await json(hunterMissing)).code).toBe("EXTERNAL_KEY_MISSING");

    await saveSecret("snov.clientId", "client-id-test");
    await saveSecret("snov.clientSecret", "client-secret-test");
    const stub = (routes: Record<string, Reply>) => {
      clearSnovTokenCache();
      const f = snovFake(routes);
      vi.stubGlobal("fetch", f.fn);
      return f;
    };
    stub({ [TOKEN]: tokenOk, [BALANCE]: { status: 200, body: { data: { balance: "40" } } } });
    expect(await json(await testExternal({ provider: "snov" }))).toEqual({
      ok: true,
      provider: "snov",
      demo: false,
      remaining: 40,
      resetDate: null,
    });
    stub({ [TOKEN]: { status: 401 } });
    const bad = await testExternal({ provider: "snov" });
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ code: "EXTERNAL_AUTH", kind: "auth" });
    stub({ [TOKEN]: tokenOk, [BALANCE]: { status: 402 } });
    expect((await json(await testExternal({ provider: "snov" }))).code).toBe("EXTERNAL_QUOTA");
    stub({ [TOKEN]: tokenOk, [BALANCE]: { status: 429 } });
    expect((await json(await testExternal({ provider: "snov" }))).code).toBe("EXTERNAL_RATE");
    stub({ [TOKEN]: new Error("ECONNRESET") });
    const down = await testExternal({ provider: "snov" });
    expect(down.status).toBe(502);
    expect((await json(down)).code).toBe("EXTERNAL_NETWORK");
    stub({ [TOKEN]: tokenOk, [BALANCE]: { status: 500 } });
    expect((await json(await testExternal({ provider: "snov" }))).code).toBe("UPSTREAM");
    expect(
      (
        await externalTestRoute.POST(
          new Request(`${ORIGIN}/x`, { method: "POST", body: "{bad" }),
          undefined,
        )
      ).status,
    ).toBe(400);
  });
});
