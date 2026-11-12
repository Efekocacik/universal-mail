import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { auditLog, messages } from "@/lib/db/schema";
import { DRAIN_GATE_RETRY_MS, sendCampaignStep } from "@/lib/mail/send-service";
import { getSetting, setSetting } from "@/lib/settings";
import { computeDrainGate } from "@/lib/unsubscribe/delivery-alert";
import type { MailProvider, ProviderSendInput } from "@/lib/mail/provider/provider";
import {
  HttpEventSource,
  createSpoolPullHandler,
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
} from "@/lib/unsubscribe/channel";
import {
  checkDeliveryHealth,
  DELIVERY_FRESH_MS,
  setUnsubscribeBaseUrl,
  verifyOneClickEndpoint,
} from "@/lib/unsubscribe/endpoint";
import { ensureSigningKey, loadPublicKeys, rotateSigningKey } from "@/lib/unsubscribe/keys";
import { createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool } from "@/lib/unsubscribe/spool";
import { verifyToken } from "@/lib/unsubscribe/token";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";
import { recordPassingDns } from "./helpers/dns-fixture";
import { enableHealthyDrain } from "./helpers/drain-fixture";

// Bu dosyada YALNIZCA test içinde: canlı kilit "açık" ve uygunluk denetimi "uygun" varsayılır, böylece canlı yolun
// iç kapıları (doğrulanmış çıkış uç noktası, iletiye özgü bağlantı, sağlayıcı) sınanabilir. Gerçek kod değişmez.
vi.mock("@/lib/compliance/policies", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/policies")>()),
  LIVE_SENDING_ENABLED: true,
}));
const legal = vi.hoisted(() => ({ a: {} as Record<string, boolean> }));
vi.mock("@/lib/compliance/legal-status", async (orig) => {
  const m = await orig<typeof import("@/lib/compliance/legal-status")>();
  // Test içinde: tüm hukuki onaylar "verilmiş" varsayılır (değiştirilebilir nesne); gerçek sabitler değişmez.
  legal.a = Object.fromEntries(Object.keys(m.LEGAL_APPROVALS).map((k) => [k, true]));
  return { ...m, LEGAL_APPROVALS: legal.a };
});
vi.mock("@/lib/compliance/eligibility", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/eligibility")>()),
  evaluateSend: async () => ({ eligible: true, reasons: [] }),
}));

/**
 * Canlı gönderim yolunun ENTEGRASYONU (Aşama 15.7). Gerçek e-posta, Google bağlantısı, alan adı veya ağ YOK:
 * sağlayıcı sahte, "ağ" süreç içi. Gerçek (mock'lanmamış) kapalı kapılar `live-send-closed.test.ts`'te sınanır.
 */

const BASE = "https://cikis.firma-ornek.com";
const ADDRESS = "satis@firma-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let spool: FileSpool;
let relay: (r: Request) => Promise<Response>;
let pull: (r: Request) => Promise<Response>;
let globalFetch: ReturnType<typeof vi.spyOn>;
let gid: number;
let sent: ProviderSendInput[];
let provider: MailProvider;
const saved: Record<string, string | undefined> = {};

const net = (async (url: string | URL | Request, init?: RequestInit) => {
  const req = new Request(url as string, init);
  const p = new URL(req.url).pathname;
  if (p.startsWith("/u/")) return relay(req);
  if (p.startsWith("/spool/")) return pull(req);
  return new Response("nope", { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-livew-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  globalFetch = vi.spyOn(globalThis, "fetch");
  gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
  sent = [];
  provider = {
    id: "gmail",
    send: async (input) => {
      sent.push(input);
      return { status: "accepted", providerMessageId: "gm1", threadId: "gt1", acceptedAt: T0 };
    },
  };
  spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => T0 });
  relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => T0 });
  pull = createSpoolPullHandler({ spool, keys: () => exportChannelPublicKeys(db), now: () => T0 });
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

async function verifiedEndpoint() {
  await ensureSigningKey(db, T0);
  await ensureChannelKey(db, T0);
  await setUnsubscribeBaseUrl(db, BASE, T0);
  const signer = (await getChannelSigner(db))!;
  const source = new HttpEventSource({
    baseUrl: BASE,
    kid: signer.kid,
    privateKey: signer.privateKey,
    now: () => T0,
    fetch: net,
  });
  const r = await verifyOneClickEndpoint(db, {
    source,
    fetch: net,
    now: () => T0,
    sleep: async () => undefined,
    attempts: 2,
  });
  expect(r.ok).toBe(true);
  await enableHealthyDrain(db, T0);
  await recordPassingDns(db, gid, T0);
}

async function liveSequence() {
  const camp = await createCampaign(db, { status: "running", mailboxId: gid });
  return addSequence(db, camp, { nextSendAt: null, email: "kisi@alici-ornek.com" });
}
const send = (cl: number, over: Parameters<typeof sendCampaignStep>[2] = {}) =>
  sendCampaignStep(
    db,
    { campaignLeadId: cl, stepIndex: 0 },
    { now: () => T0, provider, liveEnabled: () => true, ...over },
  );
const unfold = (raw: string) => raw.replace(/\r\n[ \t]/g, "");
const msgRows = () => db.select().from(messages).where(eq(messages.direction, "out"));

describe("canlı yol: çıkış bağlantısı olmadan ASLA gönderilmez", () => {
  it("uç nokta yapılandırılmamış / doğrulanmamış → unsubscribe_unavailable; sağlayıcı çağrılmaz, ileti kaydı açılmaz", async () => {
    const s = await liveSequence();
    expect(await send(s.cl)).toMatchObject({
      outcome: "not_sendable",
      code: "unsubscribe_unavailable",
      detail: "no_endpoint",
    });
    await ensureSigningKey(db, T0);
    await setUnsubscribeBaseUrl(db, BASE, T0);
    expect(await send(s.cl)).toMatchObject({
      outcome: "not_sendable",
      code: "unsubscribe_unavailable",
      detail: "not_verified",
    });
    expect(sent).toHaveLength(0);
    expect(await msgRows()).toHaveLength(0);
  });

  it("doğrulama süresi dolmuş veya imza anahtarı döndürülüp aktarıcı güncellenmemişse gönderilmez", async () => {
    await verifiedEndpoint();
    const s = await liveSequence();
    expect(await send(s.cl, { now: () => T0 + 31 * 86_400_000 })).toMatchObject({
      code: "unsubscribe_unavailable",
    });
    await rotateSigningKey(db, T0 + 5);
    expect(await send(s.cl)).toMatchObject({
      code: "unsubscribe_unavailable",
      detail: "not_verified",
    });
    expect(sent).toHaveLength(0);
  });
});

describe("canlı yol: doğrulanmış uç noktayla iletiye özgü imzalı bağlantı", () => {
  it("ileti gönderilir; List-Unsubscribe (HTTPS) ve List-Unsubscribe-Post başlıkları ve geçerli belirteç vardır", async () => {
    await verifiedEndpoint();
    const s = await liveSequence();
    const out = await send(s.cl);
    expect(out).toMatchObject({ outcome: "sent", providerMessageId: "gm1" });
    expect(sent).toHaveLength(1);
    const raw = unfold(sent[0]!.raw);
    const m = /^List-Unsubscribe: <(https:\/\/cikis\.firma-ornek\.com\/u\/([^>]+))>/m.exec(raw);
    expect(m, raw.slice(0, 600)).not.toBeNull();
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    const v = verifyToken(m![2], await loadPublicKeys(db), T0 + 1000);
    expect(v.ok && v.claims).toMatchObject({ c: s.cl, s: "u" });
    expect(sent[0]!.from).toBe(ADDRESS);
    expect(sent[0]!.to).toBe("kisi@alici-ornek.com");
  });

  it("her ileti için BENZERSİZ belirteç (jti); belirteçte adres yok", async () => {
    await verifiedEndpoint();
    const s1 = await liveSequence();
    const camp2 = await createCampaign(db, { status: "running", mailboxId: gid });
    const s2 = await addSequence(db, camp2, { nextSendAt: null, email: "diger@diger-alan.com" });
    await send(s1.cl);
    await send(s2.cl, { now: () => T0 + 2 * 3_600_000 }); // kutu gönderim aralığı
    const tokens = sent.map((i) => /\/u\/([^>]+)>/.exec(unfold(i.raw))![1]!);
    expect(new Set(tokens).size).toBe(2);
    for (const t of tokens)
      expect(Buffer.from(t.split(".")[1]!, "base64url").toString()).not.toMatch(
        /@|alici-ornek|diger-alan/,
      );
  });

  it("canlı kilit kapalıysa (opts) sağlayıcı kurulmaz ve çıkış belirteci BASILMAZ", async () => {
    await verifiedEndpoint();
    const s = await liveSequence();
    const auditsBefore = (await db.select().from(auditLog)).length;
    expect(await send(s.cl, { liveEnabled: () => false })).toMatchObject({
      outcome: "not_sendable",
      code: "provider_unavailable",
    });
    expect(sent).toHaveLength(0);
    expect(await msgRows()).toHaveLength(0);
    expect((await db.select().from(auditLog)).length).toBe(auditsBefore);
  });

  it("gönderim yolunun KENDİ hukuki onay kapısı: uygunluk 'uygun' olsa bile onay eksikse sağlayıcı kurulmaz ve belirteç basılmaz", async () => {
    await verifiedEndpoint();
    const s = await liveSequence();
    legal.a.lia = false;
    try {
      const out = await send(s.cl, { liveEnabled: undefined });
      expect(out).toMatchObject({ outcome: "not_sendable", code: "provider_unavailable" });
    } finally {
      legal.a.lia = true;
    }
    expect(sent).toHaveLength(0);
    expect(await msgRows()).toHaveLength(0);
    // onay geri gelince aynı çağrı varsayılan kapıyla gönderilir
    expect(await send(s.cl, { liveEnabled: undefined })).toMatchObject({ outcome: "sent" });
  });

  it("liveEnabled geçersiz kılması üretimde kabul edilmez", async () => {
    const s = await liveSequence();
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      await expect(send(s.cl)).rejects.toThrow(/yalnızca testte/);
    } finally {
      env.NODE_ENV = prev;
    }
    expect(sent).toHaveLength(0);
  });
});

describe("canlı yol: çıkış talepleri çekilmiyorsa kampanya gönderimi ERTELENİR (çekme kapısı)", () => {
  const drainBlocked = (detail: string) => ({
    outcome: "not_sendable",
    code: "unsubscribe_drain_unhealthy",
    detail,
    retryAt: T0 + DRAIN_GATE_RETRY_MS,
  });

  it("çekme işi kapalı → drain_disabled; sağlayıcı çağrılmaz, ileti kaydı açılmaz", async () => {
    await verifiedEndpoint();
    await setSetting(db, "mail.unsubscribeDrain", { enabled: false });
    const s = await liveSequence();
    expect(await send(s.cl)).toMatchObject(drainBlocked("drain_disabled"));
    expect(sent).toHaveLength(0);
    expect(await msgRows()).toHaveLength(0);
  });

  it("son sağlık kaydı yok veya 24 saatten eski → drain_stale", async () => {
    await verifiedEndpoint();
    const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
    await setSetting(db, "mail.unsubscribeEndpoint", { ...cfg, delivery: null });
    const s = await liveSequence();
    expect(await send(s.cl)).toMatchObject(drainBlocked("drain_stale"));
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...cfg,
      delivery: { ...cfg.delivery!, checkedAt: T0 - DELIVERY_FRESH_MS - 1 },
    });
    expect(await send(s.cl)).toMatchObject(drainBlocked("drain_stale"));
    expect(sent).toHaveLength(0);
    expect(await msgRows()).toHaveLength(0);
  });

  it("son sağlık kaydı kötü (ör. kuyruk birikmiş) → drain_unhealthy", async () => {
    await verifiedEndpoint();
    await checkDeliveryHealth(
      db,
      { getStats: async () => ({ depth: 5000, oldestAgeMs: 1000, corrupt: 0 }) },
      T0,
    );
    const s = await liveSequence();
    expect(await send(s.cl)).toMatchObject(drainBlocked("drain_unhealthy"));
    expect(sent).toHaveLength(0);
  });

  it("ortam bayrağı da çekmeyi açar; sağlıklı ve taze kayıtla gönderilir", async () => {
    await verifiedEndpoint();
    await setSetting(db, "mail.unsubscribeDrain", { enabled: false });
    const prev = process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED;
    process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED = "1";
    try {
      const s = await liveSequence();
      expect(await send(s.cl)).toMatchObject({ outcome: "sent" });
      expect(sent).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED;
      else process.env.UM_UNSUBSCRIBE_DRAIN_ENABLED = prev;
    }
  });
});

describe("çekme kapısı kararı (saf)", () => {
  const ok = { ok: true, checkedAt: T0 };
  it("kapalı / kayıt yok / bayat / gelecekte / kötü / sağlıklı", () => {
    expect(computeDrainGate({ active: false, delivery: ok }, T0)).toEqual({
      ok: false,
      code: "drain_disabled",
    });
    expect(computeDrainGate({ active: true, delivery: null }, T0)).toEqual({
      ok: false,
      code: "drain_stale",
    });
    expect(
      computeDrainGate({ active: true, delivery: ok }, T0 + DELIVERY_FRESH_MS + 1),
    ).toMatchObject({ code: "drain_stale" });
    expect(
      computeDrainGate({ active: true, delivery: { ok: true, checkedAt: T0 + 3_600_000 } }, T0),
    ).toMatchObject({ code: "drain_stale" });
    expect(
      computeDrainGate({ active: true, delivery: { ok: false, checkedAt: T0 } }, T0),
    ).toMatchObject({ code: "drain_unhealthy" });
    expect(computeDrainGate({ active: true, delivery: ok }, T0 + DELIVERY_FRESH_MS)).toEqual({
      ok: true,
    });
  });
});
