import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as arfRoute from "@/app/api/compliance/arf-reporters/route";
import * as baseUrlRoute from "@/app/api/compliance/unsubscribe/base-url/route";
import * as drainRoute from "@/app/api/compliance/unsubscribe/drain/route";
import * as healthRoute from "@/app/api/compliance/unsubscribe/health/route";
import * as channelRevokeRoute from "@/app/api/compliance/unsubscribe/keys/channel/[kid]/revoke/route";
import * as channelRoute from "@/app/api/compliance/unsubscribe/keys/channel/route";
import * as signingRevokeRoute from "@/app/api/compliance/unsubscribe/keys/signing/[kid]/revoke/route";
import * as signingRoute from "@/app/api/compliance/unsubscribe/keys/signing/route";
import * as relayKeysRoute from "@/app/api/compliance/unsubscribe/relay-keys/route";
import * as stateRoute from "@/app/api/compliance/unsubscribe/route";
import * as verifyRoute from "@/app/api/compliance/unsubscribe/verify/route";
import * as settingsRoute from "@/app/api/settings/route";
import { mapDomainError } from "@/lib/api/domain-route";
import type { Db } from "@/lib/db/client";
import { jobs, settings } from "@/lib/db/schema";
import { ArfConfigError } from "@/lib/mail/inbound/arf";
import { getSetting } from "@/lib/settings";
import {
  ChannelError,
  createSpoolPullHandler,
  exportChannelPublicKeys,
} from "@/lib/unsubscribe/channel";
import { UNSUBSCRIBE_DRAIN_JOB } from "@/lib/unsubscribe/drain-job";
import { EndpointError, VERIFICATION_TTL_MS } from "@/lib/unsubscribe/endpoint";
import { loadPublicKeys } from "@/lib/unsubscribe/keys";
import { createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool } from "@/lib/unsubscribe/spool";
import { openMemoryDb, seedBase } from "./helpers/campaign-fixture";

/**
 * TB-3 uçları: çıkış altyapısı anahtarları, temel adres, anahtar dosyası, doğrulama, sağlık, çekme anahtarı ve ARF
 * sağlayıcıları. Bellek içi veritabanı; "ağ" süreç içidir (aktarıcı ve çekme işleyicisi), gerçek alan adına istek yok.
 * Odak: gizli bilgi/`jti` sızmaz, anahtar işlemleri sıralıdır, hatalar doğru HTTP koduna eşlenir.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
const BASE = "https://cikis.firma-ornek.com";
const P = "/api/compliance/unsubscribe";
let client: Client;
let db: Db;
let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY", "UM_UNSUBSCRIBE_DRAIN_ENABLED"])
    saved[k] = process.env[k];
  delete process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED;
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-unsubapi-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("beklenmeyen ağ isteği");
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Json = Record<string, unknown>;
type R = { status: number; body: Json; text: string; headers: Headers };
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const kidCtx = (kid: string) => ({ params: Promise.resolve({ kid }) });
async function call(res: Promise<Response>): Promise<R> {
  const r = await res;
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as Json, text, headers: r.headers };
}

const state = () => call(stateRoute.GET(req("GET", P), undefined));
const signing = (action: string) =>
  call(signingRoute.POST(req("POST", `${P}/keys/signing`, { action }), undefined));
const channel = (action: string) =>
  call(channelRoute.POST(req("POST", `${P}/keys/channel`, { action }), undefined));
const revokeSigning = (kid: string, payload: unknown = { confirm: true }) =>
  call(
    signingRevokeRoute.POST(req("POST", `${P}/keys/signing/${kid}/revoke`, payload), kidCtx(kid)),
  );
const revokeChannel = (kid: string, payload: unknown = { confirm: true }) =>
  call(
    channelRevokeRoute.POST(req("POST", `${P}/keys/channel/${kid}/revoke`, payload), kidCtx(kid)),
  );
const setBase = (baseUrl: unknown) =>
  call(baseUrlRoute.PUT(req("PUT", `${P}/base-url`, { baseUrl }), undefined));
const relayKeys = () => call(relayKeysRoute.GET(req("GET", `${P}/relay-keys`), undefined));
const verify = () => call(verifyRoute.POST(req("POST", `${P}/verify`), undefined));
const health = () => call(healthRoute.POST(req("POST", `${P}/health`), undefined));
const drain = (payload: unknown) =>
  call(drainRoute.PUT(req("PUT", `${P}/drain`, payload), undefined));
const drainJobs = () => db.select().from(jobs).where(eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB));

async function configureAll(): Promise<void> {
  expect((await signing("ensure")).status).toBe(200);
  expect((await channel("ensure")).status).toBe(200);
  expect((await setBase(BASE)).status).toBe(200);
}

/** Süreç içi aktarıcı: /u/* aktarıcı işleyicisine, /spool/* çekme işleyicisine (gerçek ağ yok). */
function inProcessRelay(opts: { channelKeysKnown?: boolean } = {}): void {
  const spool = new FileSpool({ dir: path.join(dir, "spool") });
  const relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool });
  const pull = createSpoolPullHandler({
    spool,
    keys: () => (opts.channelKeysKnown === false ? [] : exportChannelPublicKeys(db)),
  });
  fetchSpy.mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    const r = new Request(url as string, init);
    const u = new URL(r.url);
    if (u.origin !== BASE) throw new Error("beklenmeyen adres");
    if (u.pathname.startsWith("/u/")) return relay(r);
    if (u.pathname.startsWith("/spool/")) return pull(r);
    return new Response("nope", { status: 404 });
  }) as typeof fetch);
}

describe("durum (GET)", () => {
  it("başlangıçta boş; yanıt gizli bilgi, genel anahtar baytı veya jti İÇERMEZ", async () => {
    const r = await state();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      baseUrl: null,
      signing: { current: null, keys: [] },
      channel: { current: null, keys: [] },
      verification: { verified: false, verifiedAt: null, expiresAt: null, lastAttempt: null },
      delivery: { status: "blocked", last: null },
      drain: { enabled: false, envForced: false, active: false },
      legalApproved: false,
      keyFileReady: false,
    });
    await configureAll();
    inProcessRelay();
    await verify();
    const after = await state();
    const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
    const keys = await getSetting(db, "mail.unsubscribeKeys");
    expect(after.text).not.toContain(cfg.verified!.jti);
    expect(after.text).not.toContain(keys.keys[0]!.x);
    expect(after.text).not.toMatch(/pkcs8|privateKey|"jti"|"pending"/);
    expect(fetchSpy).toHaveBeenCalled(); // yalnızca doğrulama isteği ağ kullandı
  });

  it("GET ağ isteği yapmaz", async () => {
    await configureAll();
    await state();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("anahtarlar", () => {
  it("imza: ensure idempotent; rotate yeni etkin + eski emekli; geçersiz eylem 400", async () => {
    const a = await signing("ensure");
    expect(a.body).toMatchObject({ rotated: false });
    expect((await signing("ensure")).body.kid).toBe(a.body.kid);
    const r = await signing("rotate");
    expect(r.body).toMatchObject({ rotated: true, previous: a.body.kid, reverifyRequired: true });
    const s = (await state()).body as { signing: { current: string; keys: Json[] } };
    expect(s.signing.current).toBe(r.body.kid);
    expect(s.signing.keys.find((k) => k.kid === a.body.kid)?.retiredAt).not.toBeNull();
    expect((await signing("delete")).status).toBe(400);
  });

  it("eşzamanlı ensure istekleri TEK anahtar üretir (süreç içi kilit)", async () => {
    const [x, y, z] = await Promise.all([signing("ensure"), signing("ensure"), signing("ensure")]);
    expect(new Set([x.body.kid, y.body.kid, z.body.kid]).size).toBe(1);
    expect((await getSetting(db, "mail.unsubscribeKeys")).keys).toHaveLength(1);
    const [c1, c2] = await Promise.all([channel("ensure"), channel("ensure")]);
    expect(c1.body.kid).toBe(c2.body.kid);
    expect((await getSetting(db, "mail.unsubscribeChannel")).keys).toHaveLength(1);
  });

  it("iptal: açık onay gerekir; geçersiz/bilinmeyen kimlik reddedilir; iptal sonrası etkin anahtar kalmaz", async () => {
    const kid = (await signing("ensure")).body.kid as string;
    expect((await revokeSigning(kid, {})).status).toBe(400);
    expect((await revokeSigning(kid, { confirm: false })).status).toBe(400);
    expect((await revokeSigning("../../x")).status).toBe(400);
    expect((await revokeSigning("0123456789abcdef")).status).toBe(404);
    expect((await revokeSigning(kid)).body).toEqual({ revoked: true });
    expect((await revokeSigning(kid)).status).toBe(404); // zaten iptal
    const s = (await state()).body as { signing: { current: string | null; keys: Json[] } };
    expect(s.signing.current).toBeNull();
    expect(s.signing.keys[0]!.revokedAt).not.toBeNull();

    const ck = (await channel("ensure")).body.kid as string;
    const r2 = await channel("rotate");
    expect(r2.body).toMatchObject({ rotated: true });
    expect((await revokeChannel(ck)).body).toEqual({ revoked: true });
    expect(await exportChannelPublicKeys(db)).toEqual([
      expect.objectContaining({ kid: r2.body.kid }),
    ]);
  });

  it("kullanım onayı yoksa anahtar üretilmez", async () => {
    await db.delete(settings).where(eq(settings.key, "consent"));
    const r = await signing("ensure");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await getSetting(db, "mail.unsubscribeKeys")).keys).toHaveLength(0);
  });
});

describe("temel adres ve anahtar dosyası", () => {
  it("güvensiz/portlu/yollu adres 400 INVALID_URL; geçerli adres origin olarak saklanır", async () => {
    for (const bad of [
      "http://cikis.firma-ornek.com",
      "https://cikis.firma-ornek.com:8443",
      "https://cikis.firma-ornek.com/yol",
      "https://localhost",
    ]) {
      const r = await setBase(bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.code, bad).toBe("INVALID_URL");
    }
    expect((await setBase(`${BASE}/`)).body).toEqual({ ok: true, drainScheduled: false });
    expect((await state()).body.baseUrl).toBe(BASE);
    expect((await setBase(null)).status).toBe(200);
    expect((await state()).body.baseUrl).toBeNull();
    expect((await setBase(42)).status).toBe(400);
  });

  it("çekme işi açıksa adres değişince hemen tur planlanır; kapalıysa planlanmaz", async () => {
    await setBase(BASE);
    expect(await drainJobs()).toHaveLength(0);
    expect((await drain({ enabled: true })).body).toMatchObject({ enabled: true, scheduled: true });
    await db.delete(jobs);
    expect((await setBase("https://cikis2.firma-ornek.com")).body).toEqual({
      ok: true,
      drainScheduled: true,
    });
    expect(await drainJobs()).toHaveLength(1);
  });

  it("anahtar dosyası: eksik yapılandırmada 409; tamamsa yalnızca GENEL anahtarlar + origin, ek olarak indirilir", async () => {
    const missing = await relayKeys();
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("NOT_CONFIGURED");
    await configureAll();
    const old = (await getSetting(db, "mail.unsubscribeKeys")).current!;
    await signing("rotate");
    const r = await relayKeys();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="relay-keys.json"');
    expect(Object.keys(r.body).sort()).toEqual([
      "channelKeys",
      "generatedAt",
      "origin",
      "tokenKeys",
      "v",
    ]);
    expect(r.body.v).toBe(1);
    expect(r.body.origin).toBe(BASE);
    const tokenKeys = r.body.tokenKeys as { kid: string; x: string }[];
    expect(tokenKeys.map((k) => k.kid)).toContain(old); // emekli anahtar eski bağlantılar için kalır
    for (const k of [...tokenKeys, ...(r.body.channelKeys as { kid: string; x: string }[])]) {
      expect(Object.keys(k).sort()).toEqual(["kid", "x"]);
      expect(k.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    await revokeSigning(old);
    const after = (await relayKeys()).body.tokenKeys as { kid: string }[];
    expect(after.map((k) => k.kid)).not.toContain(old);
  });
});

describe("doğrulama ve sağlık (yalnızca kullanıcı eylemi)", () => {
  it("yapılandırma yoksa 409 NOT_CONFIGURED ve ağ isteği yok", async () => {
    for (const r of [await verify(), await health()]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_CONFIGURED");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uçtan uca doğrulama başarılı: kanıt yazılır, bitiş 30 gün sonra", async () => {
    await configureAll();
    inProcessRelay();
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.outcome).toEqual({ ok: true, code: "verified" });
    const v = (await state()).body.verification as Json;
    expect(v.verified).toBe(true);
    expect(v.expiresAt).toBe((v.verifiedAt as number) + VERIFICATION_TTL_MS);
    expect(v.lastAttempt).toMatchObject({ ok: true, code: "verified", detail: null });
  });

  it("aktarıcı kanal anahtarını tanımıyorsa: 200 + channel_failed (http_error_401), son deneme kayıtlı", async () => {
    await configureAll();
    inProcessRelay({ channelKeysKnown: false });
    const r = await verify();
    expect(r.status).toBe(200);
    expect(r.body.outcome).toEqual({
      ok: false,
      code: "channel_failed",
      detail: "http_error_401",
    });
    const v = (await state()).body.verification as Json;
    expect(v.verified).toBe(false);
    expect(v.lastAttempt).toMatchObject({
      ok: false,
      code: "channel_failed",
      detail: "http_error_401",
    });
  });

  it("sağlık: kuyruk boşsa ok; kanal tanınmıyorsa unreachable olarak kaydedilir", async () => {
    await configureAll();
    inProcessRelay();
    expect((await health()).body).toEqual({ ok: true, code: "ok" });
    expect(((await state()).body.delivery as Json).status).toBe("ok");
    inProcessRelay({ channelKeysKnown: false });
    expect((await health()).body).toEqual({ ok: false, code: "unreachable" });
    expect(((await state()).body.delivery as Json).status).toBe("blocked");
  });
});

describe("çekme anahtarı", () => {
  it("aç/kapat ayarı yazar; kapatınca bekleyen tur iptal; geçersiz gövde 400", async () => {
    await setBase(BASE);
    expect((await drain({ enabled: true })).body).toEqual({
      enabled: true,
      active: true,
      scheduled: true,
    });
    expect((await state()).body.drain).toEqual({ enabled: true, envForced: false, active: true });
    expect((await drain({ enabled: false })).body).toMatchObject({ enabled: false, active: false });
    expect((await drainJobs()).map((j) => j.status)).toEqual(["cancelled"]);
    expect((await drain({ enabled: "evet" })).status).toBe(400);
    expect((await drain({})).status).toBe(400);
  });

  it("genel ayarlar API'si çekme anahtarını YAZAMAZ", async () => {
    const r = await call(
      settingsRoute.PUT(
        req("PUT", "/api/settings", { "mail.unsubscribeDrain": { enabled: true } }),
        undefined,
      ),
    );
    expect(r.status).toBe(400);
    expect(await getSetting(db, "mail.unsubscribeDrain")).toEqual({ enabled: false });
  });
});

describe("ARF sağlayıcıları", () => {
  const getArf = () => call(arfRoute.GET(req("GET", "/api/compliance/arf-reporters"), undefined));
  const putArf = (domains: unknown) =>
    call(arfRoute.PUT(req("PUT", "/api/compliance/arf-reporters", { domains }), undefined));

  it("liste okunur, normalleştirilip yazılır; geçersiz alan adı ve fazla kayıt 400", async () => {
    expect((await getArf()).body).toEqual({ domains: [] });
    expect((await putArf(["FBL.Saglayici-Ornek.com", "fbl.saglayici-ornek.com"])).body).toEqual({
      domains: ["fbl.saglayici-ornek.com"],
    });
    expect((await getArf()).body).toEqual({ domains: ["fbl.saglayici-ornek.com"] });
    const bad = await putArf(["com"]);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_DOMAIN");
    const many = await putArf(Array.from({ length: 51 }, (_, i) => `fbl${i}.saglayici-ornek.com`));
    expect(many.status).toBe(400);
    expect(many.body.code).toBe("TOO_MANY");
    expect((await putArf([])).body).toEqual({ domains: [] });
  });
});

describe("hata eşlemesi (domainRoute)", () => {
  it("EndpointError, ArfConfigError ve ChannelError 500 yerine anlamlı koda çevrilir", () => {
    expect(mapDomainError(new EndpointError("invalid_url", "x"))).toMatchObject({
      status: 400,
      body: { code: "INVALID_URL" },
    });
    expect(mapDomainError(new EndpointError("not_verified", "x"))?.status).toBe(409);
    expect(mapDomainError(new ArfConfigError("too_many", "x"))).toMatchObject({
      status: 400,
      body: { code: "TOO_MANY" },
    });
    expect(mapDomainError(new ChannelError("http_error", 401))).toMatchObject({
      status: 502,
      body: { code: "CHANNEL_HTTP_ERROR", upstreamStatus: 401 },
    });
    expect(mapDomainError(new ChannelError("insecure_url"))?.status).toBe(400);
    const timeout = mapDomainError(new ChannelError("timeout"));
    expect(timeout?.status).toBe(502);
    expect(timeout?.body).not.toHaveProperty("upstreamStatus");
  });
});
