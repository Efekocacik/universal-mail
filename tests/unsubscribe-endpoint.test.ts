import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, settings, suppressions } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import {
  ChannelError,
  HttpEventSource,
  createSpoolPullHandler,
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
  revokeChannelKey,
  rotateChannelKey,
} from "@/lib/unsubscribe/channel";
import {
  DELIVERY_FRESH_MS,
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_DEPTH,
  EndpointError,
  VERIFICATION_TTL_MS,
  checkDeliveryHealth,
  evaluateDelivery,
  isOneClickEndpointVerified,
  prepareLiveUnsubscribe,
  setUnsubscribeBaseUrl,
  verifyOneClickEndpoint,
} from "@/lib/unsubscribe/endpoint";
import {
  PROBE_MAX_AGE_MS,
  drainUnsubscribeEvents,
  ingestUnsubscribeEvent,
} from "@/lib/unsubscribe/ingest";
import {
  ensureSigningKey,
  loadPublicKeys,
  mintProbeToken,
  mintUnsubscribeToken,
  rotateSigningKey,
  revokeSigningKey,
} from "@/lib/unsubscribe/keys";
import { createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool } from "@/lib/unsubscribe/spool";
import { verifyToken } from "@/lib/unsubscribe/token";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW, seedSent, type Sent } from "./helpers/inbound-fixture";

/**
 * HTTPS çıkış uç noktası: yapılandırma, uçtan uca doğrulama kanıtı, teslimat sağlığı ve gönderim bağlantısı
 * (Aşama 15.7). Tüm "ağ" süreç içidir (fetch, işleyicilere yönlendirilir); gerçek alan adına/ağa İSTEK ATILMAZ.
 */

const BASE = "https://cikis.firma-ornek.com";
const RCPT = "kisi@alici-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let spoolDir: string;
let spool: FileSpool;
let relay: (r: Request) => Promise<Response>;
let pull: (r: Request) => Promise<Response>;
let globalFetch: ReturnType<typeof vi.spyOn>;
let clock: number;
let a: Sent;
const saved: Record<string, string | undefined> = {};

/** Süreç içi "ağ": /u/* aktarıcıya, /spool/* çekme işleyicisine. */
const net = (async (url: string | URL | Request, init?: RequestInit) => {
  const req = new Request(url as string, init);
  const p = new URL(req.url).pathname;
  if (p.startsWith("/u/")) return relay(req);
  if (p.startsWith("/spool/")) return pull(req);
  return new Response("nope", { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-endp-"));
  spoolDir = path.join(dir, "spool");
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  globalFetch = vi.spyOn(globalThis, "fetch");
  clock = NOW;
  const campaign = await createCampaign(db, { status: "running" });
  a = await seedSent(db, campaign, { email: RCPT });
  await ensureSigningKey(db, clock);
  await ensureChannelKey(db, clock);
  spool = new FileSpool({ dir: spoolDir, now: () => clock });
  relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => clock });
  pull = createSpoolPullHandler({
    spool,
    keys: () => exportChannelPublicKeys(db),
    now: () => clock,
  });
  await setUnsubscribeBaseUrl(db, BASE, clock);
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled(); // gerçek ağ isteği YOK
  globalFetch.mockRestore();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function source(): Promise<HttpEventSource> {
  const signer = (await getChannelSigner(db))!;
  return new HttpEventSource({
    baseUrl: BASE,
    kid: signer.kid,
    privateKey: signer.privateKey,
    now: () => clock,
    fetch: net,
  });
}
const verify = async (over: Partial<Parameters<typeof verifyOneClickEndpoint>[1]> = {}) =>
  verifyOneClickEndpoint(db, {
    source: await source(),
    fetch: net,
    now: () => clock,
    sleep: async () => undefined,
    attempts: 2,
    ...over,
  });
const cfg = () => getSetting(db, "mail.unsubscribeEndpoint");
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

describe("temel adres yapılandırması", () => {
  it("yalnızca güvenli HTTPS kökü kabul edilir; origin'e normalleştirilir; denetim yalnızca ana bilgisayar adını yazar", async () => {
    for (const bad of [
      "http://cikis.firma-ornek.com",
      "https://u:p@cikis.firma-ornek.com",
      "https://cikis.firma-ornek.com:8443",
      "https://cikis.firma-ornek.com/yol",
      "https://cikis.firma-ornek.com/?q=1",
      "https://cikis.firma-ornek.com/#x",
      "https://127.0.0.1",
      "https://localhost",
      "https://cikis.invalid",
      "https://cikis.example",
      "javascript:alert(1)",
      "yok",
      "",
    ]) {
      await expect(setUnsubscribeBaseUrl(db, bad, clock), bad).rejects.toBeInstanceOf(
        EndpointError,
      );
    }
    await setUnsubscribeBaseUrl(db, "https://CIKIS.firma-ornek.com/", clock);
    expect((await cfg()).baseUrl).toBe(BASE);
    const detail = JSON.stringify((await audits("unsubscribe.endpoint_configured")).at(-1)!.detail);
    expect(detail).toBe('{"host":"cikis.firma-ornek.com"}');
  });

  it("adres değişince veya silinince önceki KANITLAR sıfırlanır", async () => {
    expect((await verify()).ok).toBe(true);
    expect(await isOneClickEndpointVerified(db, clock)).toBe(true);
    await setUnsubscribeBaseUrl(db, "https://baska.firma-ornek.com", clock);
    expect(await isOneClickEndpointVerified(db, clock)).toBe(false);
    expect(await cfg()).toMatchObject({
      verified: null,
      pending: null,
      lastAttempt: null,
      delivery: null,
    });
    await setUnsubscribeBaseUrl(db, null, clock);
    expect((await cfg()).baseUrl).toBeNull();
  });
});

describe("uçtan uca doğrulama (kanıt yalnızca başarıdan sonra yazılır)", () => {
  it("başarı: sınama belirteci → RFC 8058 POST → dayanıklı kuyruk → imzalı çekme → uygulama doğrular", async () => {
    const r = await verify();
    expect(r).toEqual({ ok: true, code: "verified" });
    const c = await cfg();
    expect(c.verified).toMatchObject({ baseUrl: BASE, verifiedAt: clock });
    expect(c.pending).toBeNull();
    expect(c.lastAttempt).toMatchObject({ ok: true, code: "verified" });
    expect(await isOneClickEndpointVerified(db, clock)).toBe(true);
    expect(spool.stats().depth).toBe(0); // olay çekildi ve onaylandı
    expect(await audits("unsubscribe.endpoint_verified")).toHaveLength(1);
  });

  it("sınama HİÇBİR alıcıya/engele/gelen kayda dokunmaz (kampanya alıcısı 1 olsa bile)", async () => {
    const before = JSON.stringify({
      s: await db.select().from(suppressions),
      m: await db.select().from(messages).where(eq(messages.direction, "in")),
      c: (await db.select().from(campaignLeads)).map((x) => [x.id, x.status]),
    });
    expect((await verify()).ok).toBe(true);
    const after = JSON.stringify({
      s: await db.select().from(suppressions),
      m: await db.select().from(messages).where(eq(messages.direction, "in")),
      c: (await db.select().from(campaignLeads)).map((x) => [x.id, x.status]),
    });
    expect(after).toBe(before);
  });

  const failures: [string, () => Partial<Parameters<typeof verifyOneClickEndpoint>[1]>, string][] =
    [
      [
        "aktarıcı 500",
        () => ({ fetch: (async () => new Response("x", { status: 500 })) as typeof fetch }),
        "bad_status",
      ],
      [
        "aktarıcı 400",
        () => ({ fetch: (async () => new Response("x", { status: 400 })) as typeof fetch }),
        "bad_status",
      ],
      [
        "yönlendirme 302",
        () => ({
          fetch: (async () =>
            new Response(null, {
              status: 302,
              headers: { Location: "https://x.example/y" },
            })) as typeof fetch,
        }),
        "bad_status",
      ],
      [
        "204 (200 değil)",
        () => ({ fetch: (async () => new Response(null, { status: 204 })) as typeof fetch }),
        "bad_status",
      ],
      [
        "ağ hatası",
        () => ({
          fetch: (async () => {
            throw new TypeError("fetch failed");
          }) as typeof fetch,
        }),
        "post_failed",
      ],
    ];
  it.each(failures)("%s → kanıt YAZILMAZ, neden saklanır", async (_n, over, code) => {
    const r = await verify(over());
    expect(r).toEqual({ ok: false, code });
    expect((await cfg()).verified).toBeNull();
    expect((await cfg()).lastAttempt).toMatchObject({ ok: false, code });
    expect(await isOneClickEndpointVerified(db, clock)).toBe(false);
  });

  it("yeniden doğrulama BAŞARISIZ olursa önceki kanıt da düşer (bozulan uç nokta 'doğrulanmış' kalmaz)", async () => {
    expect((await verify()).ok).toBe(true);
    expect(await isOneClickEndpointVerified(db, clock)).toBe(true);
    const down = (async () => new Response("x", { status: 503 })) as typeof fetch;
    expect(await verify({ fetch: down })).toEqual({ ok: false, code: "bad_status" });
    expect((await cfg()).verified).toBeNull();
    expect(await isOneClickEndpointVerified(db, clock)).toBe(false);
  });

  it("aktarıcı 200 verir ama olay uygulamaya ULAŞMAZ → not_delivered (200 tek başına kanıt değil)", async () => {
    const empty = { pull: async () => [], ack: async () => undefined };
    const r = await verify({ source: empty });
    expect(r).toEqual({ ok: false, code: "not_delivered" });
    expect((await cfg()).verified).toBeNull();
  });

  it("adres yok / imza anahtarı yok", async () => {
    await setUnsubscribeBaseUrl(db, null, clock);
    expect(await verify()).toEqual({ ok: false, code: "not_configured" });
    await setUnsubscribeBaseUrl(db, BASE, clock);
    await revokeSigningKey(db, (await getSetting(db, "mail.unsubscribeKeys")).current!, clock);
    expect(await verify()).toEqual({ ok: false, code: "no_key" });
  });

  it("aktarıcının anahtar kümesi eski/boşsa (imza reddedilir): doğrulama BAŞARISIZ, kanıt yok", async () => {
    relay = createRelayHandler({ keys: () => [], sink: spool, now: () => clock });
    expect(await verify()).toEqual({ ok: false, code: "bad_status" });
  });

  it("kanal anahtarı aktarıcıda tanınmıyorsa çekme başarısız → channel_failed; kanıt yok, son deneme KAYDEDİLİR", async () => {
    pull = createSpoolPullHandler({ spool, keys: () => [], now: () => clock });
    expect(await verify()).toEqual({
      ok: false,
      code: "channel_failed",
      detail: "http_error_401",
    });
    const c = await cfg();
    expect(c.verified).toBeNull();
    expect(c.lastAttempt).toEqual({
      at: clock,
      ok: false,
      code: "channel_failed",
      detail: "http_error_401",
    });
  });

  it("kanal ağ hatası (zaman aşımı/ağ) da channel_failed olarak kaydedilir; başka hatalar yukarı çıkar", async () => {
    const failing = (err: unknown) => ({
      pull: async () => {
        throw err;
      },
      ack: async () => undefined,
    });
    expect(await verify({ source: failing(new ChannelError("timeout")) })).toEqual({
      ok: false,
      code: "channel_failed",
      detail: "timeout",
    });
    expect((await cfg()).lastAttempt).toMatchObject({ code: "channel_failed", detail: "timeout" });
    await expect(verify({ source: failing(new Error("db")) })).rejects.toThrow("db");
  });
});

describe("sınama olaylarının işlenmesi: tekrar oynatma ve sahtecilik", () => {
  const ev = (token: string, at = clock + 1000) => ({
    v: 1,
    token,
    receivedAt: at,
    via: "one_click",
  });
  const arm = async (now = clock) => {
    const probe = await mintProbeToken(db, now);
    const c = await cfg();
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...c,
      pending: { jti: probe.jti, baseUrl: BASE, kid: probe.kid, issuedAt: now },
    });
    return probe;
  };

  it("eşleşen sınama bir kez doğrular; tekrar teslimat etkisizdir (bekleyen tüketildi)", async () => {
    const p = await arm();
    expect(await ingestUnsubscribeEvent(db, ev(p.token), { now: clock + 2000 })).toEqual({
      outcome: "probe",
      verified: true,
    });
    const v1 = (await cfg()).verified;
    expect(await ingestUnsubscribeEvent(db, ev(p.token), { now: clock + 3000 })).toEqual({
      outcome: "probe",
      verified: false,
    });
    expect((await cfg()).verified).toEqual(v1);
  });

  it("bekleyen sınama yoksa / başka jti / süresi dolmuş / adres değişmiş → doğrulanmaz", async () => {
    const stray = await mintProbeToken(db, clock);
    expect(await ingestUnsubscribeEvent(db, ev(stray.token), { now: clock + 1000 })).toEqual({
      outcome: "probe",
      verified: false,
    });
    await arm();
    expect(await ingestUnsubscribeEvent(db, ev(stray.token), { now: clock + 1000 })).toEqual({
      outcome: "probe",
      verified: false,
    });
    const p2 = await arm();
    expect(
      await ingestUnsubscribeEvent(db, ev(p2.token, clock + 1000), {
        now: clock + PROBE_MAX_AGE_MS + 2000,
      }),
    ).toEqual({ outcome: "probe", verified: false });
    const p3 = await arm();
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...(await cfg()),
      baseUrl: "https://baska.firma-ornek.com",
    });
    expect(await ingestUnsubscribeEvent(db, ev(p3.token), { now: clock + 1000 })).toEqual({
      outcome: "probe",
      verified: false,
    });
    expect((await cfg()).verified).toBeNull();
  });

  it("'u' kapsamlı belirteç uç noktayı DOĞRULAMAZ; 'p' belirteci alıcıyı ÇIKARMAZ; kapsam değiştirme imzayı bozar", async () => {
    const p = await arm();
    const u = await mintUnsubscribeToken(db, { campaignLeadId: a.cl, now: clock });
    expect((await ingestUnsubscribeEvent(db, ev(u.token), { now: clock + 1000 })).outcome).toBe(
      "unsubscribed",
    );
    expect((await cfg()).verified).toBeNull();
    expect((await cfg()).pending).not.toBeNull();
    // 'p' → 'u' kapsam değişikliği
    const [pre, pl, sg] = p.token.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(pl, "base64url").toString()), s: "u", c: a.cl }),
    ).toString("base64url");
    const before = (await db.select().from(suppressions)).length;
    expect(
      await ingestUnsubscribeEvent(db, ev(`${pre}.${forged}.${sg}`), { now: clock + 1000 }),
    ).toEqual({
      outcome: "rejected",
      reason: "invalid_token",
    });
    expect((await db.select().from(suppressions)).length).toBe(before);
  });

  it("iptal edilen anahtarla imzalı sınama reddedilir (unknown_key)", async () => {
    const p = await arm();
    const kid = (await getSetting(db, "mail.unsubscribeKeys")).current!;
    await revokeSigningKey(db, kid, clock);
    expect(await ingestUnsubscribeEvent(db, ev(p.token), { now: clock + 1000 })).toEqual({
      outcome: "rejected",
      reason: "unknown_key",
    });
  });
});

describe("saklanan kanıttan türeyen durum (isOneClickEndpointVerified)", () => {
  beforeEach(async () => {
    expect((await verify()).ok).toBe(true);
  });
  it("süre dolunca, imza anahtarı döndürülünce/iptal edilince, kanıt adresi uyuşmayınca geçersiz", async () => {
    expect(await isOneClickEndpointVerified(db, clock + VERIFICATION_TTL_MS - 1000)).toBe(true);
    expect(await isOneClickEndpointVerified(db, clock + VERIFICATION_TTL_MS + 1000)).toBe(false);
    expect(await isOneClickEndpointVerified(db, clock - 3600_000)).toBe(false); // gelecekte yazılmış kanıt
    const oldKeys = await loadPublicKeys(db);
    await rotateSigningKey(db, clock + 5);
    expect(await isOneClickEndpointVerified(db, clock + 10)).toBe(false); // aktarıcı yeni anahtarı aldı mı: yeniden doğrula
    // aktarıcı hâlâ ESKİ anahtar kümesindeyse yeni anahtarla imzalı sınama reddedilir
    relay = createRelayHandler({ keys: () => oldKeys, sink: spool, now: () => clock + 20 });
    expect((await verify({ now: () => clock + 20 })).ok).toBe(false);
    relay = createRelayHandler({
      keys: () => loadPublicKeys(db),
      sink: spool,
      now: () => clock + 30,
    });
    expect((await verify({ now: () => clock + 30 })).ok).toBe(true);
    expect(await isOneClickEndpointVerified(db, clock + 40)).toBe(true);
    const c = await cfg();
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...c,
      verified: { ...c.verified!, baseUrl: "https://baska.firma-ornek.com" },
    });
    expect(await isOneClickEndpointVerified(db, clock + 40)).toBe(false);
  });
  it("kullanıcı beyanıyla/ayar yazmayla kanıt OLUŞTURULAMAZ: adres olmadan ve anahtar uyuşmadan doğrulanmış sayılmaz", async () => {
    await setSetting(db, "mail.unsubscribeEndpoint", {
      baseUrl: BASE,
      pending: null,
      verified: { baseUrl: BASE, kid: "0".repeat(16), jti: "x", verifiedAt: clock },
      lastAttempt: null,
      delivery: null,
    });
    expect(await isOneClickEndpointVerified(db, clock)).toBe(false);
  });
});

describe("canlı ileti için çıkış bağlantısı (prepareLiveUnsubscribe)", () => {
  it("doğrulanmamış uç noktada bağlantı ÜRETİLMEZ (belirteç basılmaz)", async () => {
    await expect(
      prepareLiveUnsubscribe(db, { campaignLeadId: a.cl, now: clock }),
    ).rejects.toMatchObject({ code: "not_verified" });
    await setUnsubscribeBaseUrl(db, null, clock);
    await expect(
      prepareLiveUnsubscribe(db, { campaignLeadId: a.cl, now: clock }),
    ).rejects.toMatchObject({ code: "no_endpoint" });
  });
  it("doğrulandıktan sonra: https bağlantı, imzalı belirteç, oneClick doğrulanmış kanıttan; silinmiş alıcı reddedilir", async () => {
    expect((await verify()).ok).toBe(true);
    const r = await prepareLiveUnsubscribe(db, { campaignLeadId: a.cl, now: clock });
    expect(r.oneClick).toBe(true);
    expect(r.url).toMatch(/^https:\/\/cikis\.firma-ornek\.com\/u\/u2\.[\w-]+\.[\w-]+$/);
    const token = r.url.split("/u/")[1]!;
    const v = verifyToken(token, await loadPublicKeys(db), clock + 1000);
    expect(v.ok && v.claims).toMatchObject({ c: a.cl, s: "u" });
    await db
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: null, redactedAt: clock })
      .where(eq(campaignLeads.id, a.cl));
    await expect(
      prepareLiveUnsubscribe(db, { campaignLeadId: a.cl, now: clock }),
    ).rejects.toMatchObject({ code: "lead_unavailable" });
  });
  it("uçtan uca gerçek çıkış: bağlantıdaki POST → dosya kuyruğu → imzalı çekme → suppression", async () => {
    expect((await verify()).ok).toBe(true);
    const { url } = await prepareLiveUnsubscribe(db, { campaignLeadId: a.cl, now: clock });
    const res = await net(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    const s = await drainUnsubscribeEvents(db, await source(), { now: () => clock + 1000 });
    expect(s).toMatchObject({ unsubscribed: 1, error: null });
    expect((await db.select().from(suppressions)).length).toBe(1);
    expect(
      (await db.select().from(campaignLeads).where(eq(campaignLeads.id, a.cl)))[0]!.status,
    ).toBe("unsubscribed");
  });
});

describe("teslimat sağlığı (K11)", () => {
  const port = (st: { depth: number; oldestAgeMs: number | null; corrupt: number } | Error) => ({
    getStats: async () => {
      if (st instanceof Error) throw st;
      return st;
    },
  });
  it("sağlıklı/derin/eski/bozuk/ulaşılamıyor durumları kaydedilir; sağlıksızlar denetim kaydı bırakır", async () => {
    expect(
      await checkDeliveryHealth(db, port({ depth: 0, oldestAgeMs: null, corrupt: 0 }), clock),
    ).toEqual({ ok: true, code: "ok" });
    expect(
      await checkDeliveryHealth(
        db,
        port({ depth: DELIVERY_MAX_DEPTH + 1, oldestAgeMs: 10, corrupt: 0 }),
        clock,
      ),
    ).toEqual({ ok: false, code: "queue_deep" });
    expect(
      await checkDeliveryHealth(
        db,
        port({ depth: 1, oldestAgeMs: DELIVERY_MAX_AGE_MS + 1, corrupt: 0 }),
        clock,
      ),
    ).toEqual({ ok: false, code: "events_stale" });
    expect(
      await checkDeliveryHealth(db, port({ depth: 1, oldestAgeMs: 1, corrupt: 2 }), clock),
    ).toEqual({ ok: false, code: "corrupt_events" });
    expect(await checkDeliveryHealth(db, port(new Error("ağ")), clock)).toEqual({
      ok: false,
      code: "unreachable",
    });
    expect((await cfg()).delivery).toMatchObject({
      ok: false,
      code: "unreachable",
      checkedAt: clock,
    });
    expect(await audits("unsubscribe.delivery_unhealthy")).toHaveLength(4);
  });
  it("hazırlık durumu: kanal/adres yok → engel; hiç denetlenmedi/bayat → bilinmiyor; sağlıklı → tamam; sağlıksız → engel", async () => {
    expect(await evaluateDelivery(db, false, clock)).toBe("blocked");
    expect(await evaluateDelivery(db, true, clock)).toBe("unknown");
    await checkDeliveryHealth(db, port({ depth: 0, oldestAgeMs: null, corrupt: 0 }), clock);
    expect(await evaluateDelivery(db, true, clock + 1000)).toBe("ok");
    expect(await evaluateDelivery(db, true, clock + DELIVERY_FRESH_MS + 1000)).toBe("unknown");
    await checkDeliveryHealth(db, port({ depth: 5000, oldestAgeMs: 1, corrupt: 0 }), clock);
    expect(await evaluateDelivery(db, true, clock + 1000)).toBe("blocked");
    await setUnsubscribeBaseUrl(db, null, clock);
    expect(await evaluateDelivery(db, true, clock)).toBe("blocked");
  });
  it("gerçek dosya kuyruğunun istatistiği imzalı kanaldan okunur", async () => {
    await spool.push({ v: 1, token: "x", receivedAt: 1, via: "one_click" });
    const r = await checkDeliveryHealth(db, await source(), clock);
    expect(r).toEqual({ ok: true, code: "ok" });
    expect((await cfg()).delivery).toMatchObject({ depth: 1 });
  });
});

describe("kanal anahtarları", () => {
  it("üretim idempotent; özel anahtar yalnızca gizli depoda; döndürme/iptal; dışa aktarımda yalnızca genel anahtar", async () => {
    const k1 = await ensureChannelKey(db, clock);
    expect((await ensureChannelKey(db, clock)).kid).toBe(k1.kid);
    const k2 = await rotateChannelKey(db, clock + 1);
    expect((await exportChannelPublicKeys(db)).map((k) => k.kid).sort()).toEqual(
      [k1.kid, k2.kid].sort(),
    );
    expect((await getChannelSigner(db))!.kid).toBe(k2.kid);
    expect(await revokeChannelKey(db, k1.kid, clock + 2)).toBe(true);
    expect(await revokeChannelKey(db, k1.kid, clock + 3)).toBe(false);
    expect((await exportChannelPublicKeys(db)).map((k) => k.kid)).toEqual([k2.kid]);
    await revokeChannelKey(db, k2.kid, clock + 4);
    expect(await getChannelSigner(db)).toBeNull();
    const dump = JSON.stringify(await db.select().from(settings));
    expect(dump).not.toMatch(/"d":/);
    const secretsFile = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(secretsFile).not.toContain("MC4CAQAw");
  });
});
