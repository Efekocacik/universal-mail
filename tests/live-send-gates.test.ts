import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suppressDomain, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, mailboxes, messages, settings } from "@/lib/db/schema";
import type { MailProvider } from "@/lib/mail/provider/provider";
import { sendCampaignStep, type SendStepOutcome } from "@/lib/mail/send-service";
import { setSetting } from "@/lib/settings";
import {
  HttpEventSource,
  createSpoolPullHandler,
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
} from "@/lib/unsubscribe/channel";
import { setUnsubscribeBaseUrl, verifyOneClickEndpoint } from "@/lib/unsubscribe/endpoint";
import { ensureSigningKey, loadPublicKeys } from "@/lib/unsubscribe/keys";
import { createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool } from "@/lib/unsubscribe/spool";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";
import { enableHealthyDrain } from "./helpers/drain-fixture";

/**
 * Canlı gönderim yolu, mevcut GERÇEK kontrolleri atlayamaz (Aşama 15.7 incelemesi). Bu dosyada YALNIZCA şu kapılar test
 * içinde "açık" varsayılır: canlı gönderim sabiti, hukuki onay sabitleri (değiştirilebilir sahte nesne) ve canlı ülke
 * politikası çözümü (değiştirilebilir). `evaluateSend` (suppression, durum, onay, sıklık...), zamanlama/kota kapıları,
 * posta kutusu durdurma, çıkış bağlantısı ve ileti kurucusu GERÇEKTİR (mock'lanmaz). Sağlayıcı sahte; ağ yok.
 */

const gates = vi.hoisted(() => ({
  legal: {} as Record<string, boolean>,
  policy: { mode: "allowed" as "allowed" | "blocked" },
}));
vi.mock("@/lib/compliance/policies", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/policies")>()),
  LIVE_SENDING_ENABLED: true,
  resolveCountryPolicy: async () => ({
    mode: gates.policy.mode,
    reason: gates.policy.mode === "blocked" ? "locked" : null,
  }),
}));
vi.mock("@/lib/compliance/legal-status", async (orig) => {
  const m = await orig<typeof import("@/lib/compliance/legal-status")>();
  gates.legal = Object.fromEntries(Object.keys(m.LEGAL_APPROVALS).map((k) => [k, true]));
  return { ...m, LEGAL_APPROVALS: gates.legal };
});

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
let calls: number;
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
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-livegates-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  globalFetch = vi.spyOn(globalThis, "fetch");
  for (const k of Object.keys(gates.legal)) gates.legal[k] = true;
  gates.policy.mode = "allowed";
  gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
  calls = 0;
  provider = {
    id: "gmail",
    send: async () => {
      calls++;
      return {
        status: "accepted",
        providerMessageId: `gm${calls}`,
        threadId: `gt${calls}`,
        acceptedAt: T0,
      };
    },
  };
  spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => T0 });
  relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => T0 });
  pull = createSpoolPullHandler({ spool, keys: () => exportChannelPublicKeys(db), now: () => T0 });
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
  const v = await verifyOneClickEndpoint(db, {
    source,
    fetch: net,
    now: () => T0,
    sleep: async () => undefined,
    attempts: 2,
  });
  expect(v.ok).toBe(true);
  await enableHealthyDrain(db, T0);
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

async function sequence(email = "info@alici-ornek.com", campaignId?: number) {
  const camp = campaignId ?? (await createCampaign(db, { status: "running", mailboxId: gid }));
  return { camp, ...(await addSequence(db, camp, { nextSendAt: null, email })) };
}
const send = (cl: number, now = T0): Promise<SendStepOutcome> =>
  sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { now: () => now, provider });
const outRows = () => db.select().from(messages).where(eq(messages.direction, "out"));
const noSendNoRecord = async () => {
  expect(calls).toBe(0);
  expect(await outRows()).toHaveLength(0);
};

describe("kontrol: tüm kapılar gerçekten açıkken gönderim çalışır (aşağıdaki engellerin sebebi gerçekten o engeldir)", () => {
  it("her şey uygun → sent", async () => {
    const s = await sequence();
    expect(await send(s.cl)).toMatchObject({ outcome: "sent" });
    expect(calls).toBe(1);
  });
});

describe("alıcı uygunluğu canlı yolda da gerçektir", () => {
  it("kişisel/adlandırılmış adrese (ör. kisi@) canlı gönderim yapılmaz (email_personal)", async () => {
    const s = await sequence("kisi@alici-ornek.com");
    const out = await send(s.cl);
    expect(out).toMatchObject({ outcome: "ineligible" });
    expect((out as { reasons: { code: string }[] }).reasons.map((r) => r.code)).toContain(
      "email_personal",
    );
    await noSendNoRecord();
  });
});

describe("hukuki onaylar GÖNDERİM yolunda zorunludur", () => {
  it("tek bir onay bile eksikse gönderim, belirteç ve ileti kaydı OLUŞMAZ (her onay anahtarı için)", async () => {
    const s = await sequence();
    const keys = Object.keys(gates.legal);
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) {
      gates.legal[k] = false;
      const out = await send(s.cl);
      expect(out, k).toMatchObject({ outcome: "ineligible" });
      expect(
        (out as { reasons: { code: string }[] }).reasons.map((r) => r.code),
        k,
      ).toContain("live_sending_disabled");
      gates.legal[k] = true;
    }
    await noSendNoRecord();
  });

  it("sağlayıcı kapısı da bağımsız: onay eksikken Gmail sağlayıcısı kurulmaz", async () => {
    const { getLiveProvider } = await import("@/lib/mail/gmail/provider");
    expect(getLiveProvider(db, { id: gid, provider: "gmail", address: ADDRESS }).id).toBe("gmail");
    gates.legal.lia = false;
    expect(() => getLiveProvider(db, { id: gid, provider: "gmail", address: ADDRESS })).toThrow();
  });
});

describe("suppression, durum, onay ve kampanya kontrolleri canlı yolda da uygulanır", () => {
  const codes = (o: SendStepOutcome) =>
    (o as { reasons: { code: string }[] }).reasons.map((r) => r.code);

  it("engellenmiş adres / alan adı → ineligible (suppressed)", async () => {
    const a = await sequence("info@alici-ornek.com");
    await suppressEmail(
      db,
      { email: "info@alici-ornek.com", reason: "unsubscribe", source: "link" },
      T0,
    );
    const out = await send(a.cl);
    expect(out.outcome).toBe("ineligible");
    expect(codes(out)).toContain("suppressed");
    const b = await sequence("contact@diger-alan.com");
    await suppressDomain(db, { domain: "diger-alan.com", reason: "manual", source: "manual" }, T0);
    expect(codes(await send(b.cl))).toContain("suppressed");
    await noSendNoRecord();
  });

  it("çıkış yapmış dizi (unsubscribed), duran kampanya, onay yok → ineligible", async () => {
    const a = await sequence("info@alici-ornek.com");
    await db
      .update(campaignLeads)
      .set({ status: "unsubscribed" })
      .where(eq(campaignLeads.id, a.cl));
    expect((await send(a.cl)).outcome).toBe("ineligible");
    const b = await sequence("info@baska-bir.com");
    await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, b.camp));
    expect(codes(await send(b.cl))).toContain("campaign_not_active");
    const c = await sequence("info@bir-baska.com");
    await db.delete(settings).where(eq(settings.key, "consent"));
    expect(codes(await send(c.cl))).toContain("consent_missing");
    await noSendNoRecord();
  });

  it("canlı ülke politikası engelliyse → ineligible (country_blocked)", async () => {
    const a = await sequence();
    gates.policy.mode = "blocked";
    const out = await send(a.cl);
    expect(out.outcome).toBe("ineligible");
    expect(codes(out)).toContain("country_blocked");
    await noSendNoRecord();
  });

  it("silinmiş (anonimleştirilmiş) alıcıya gönderilmez", async () => {
    const a = await sequence();
    await db
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: null, redactedAt: T0 })
      .where(eq(campaignLeads.id, a.cl));
    expect((await send(a.cl)).outcome).toBe("ineligible");
    await noSendNoRecord();
  });

  it("aynı alan adına aynı gün ikinci ileti engellenir (alan adı günlük sınırı)", async () => {
    const a = await sequence("info@alici-ornek.com");
    expect((await send(a.cl)).outcome).toBe("sent");
    const b = await sequence("sales@alici-ornek.com");
    const out = await send(b.cl, T0 + 2 * 3_600_000);
    expect(out.outcome).toBe("ineligible");
    expect(calls).toBe(1);
  });
});

describe("kota ve posta kutusu durdurma canlı yolda da uygulanır", () => {
  it("günlük kutu tavanı: ikinci ileti not_sendable (mailbox_daily_cap), sağlayıcı çağrılmaz", async () => {
    await db.update(mailboxes).set({ dailyCap: 1 }).where(eq(mailboxes.id, gid));
    const a = await sequence("info@alici-ornek.com");
    expect((await send(a.cl)).outcome).toBe("sent");
    const b = await sequence("info@diger-alan.com");
    const out = await send(b.cl, T0 + 2 * 3_600_000);
    expect(out).toMatchObject({ outcome: "not_sendable", code: "mailbox_daily_cap" });
    expect(calls).toBe(1);
  });

  it("gönderimler arası bekleme: hemen ikinci ileti not_sendable (mailbox_gap)", async () => {
    const a = await sequence("info@alici-ornek.com");
    expect((await send(a.cl)).outcome).toBe("sent");
    const b = await sequence("info@diger-alan.com");
    expect(await send(b.cl)).toMatchObject({ outcome: "not_sendable", code: "mailbox_gap" });
    expect(calls).toBe(1);
  });

  it("durdurulmuş posta kutusu: not_sendable (mailbox_halted); çıkış belirteci basılmadan durur", async () => {
    await setSetting(db, "mail.mailboxHalts", {
      [String(gid)]: { at: T0, recipients: 60, bounced: 9, reason: "bounce_rate" },
    });
    const a = await sequence();
    expect(await send(a.cl)).toMatchObject({ outcome: "not_sendable", code: "mailbox_halted" });
    await noSendNoRecord();
  });

  it("zamanlama penceresi dışında: not_sendable, gönderim yok", async () => {
    const a = await sequence();
    const out = await send(a.cl, Date.UTC(2026, 10, 1, 3, 0, 0)); // pazar gecesi
    expect(out.outcome === "not_sendable" || out.outcome === "ineligible").toBe(true);
    await noSendNoRecord();
  });
});

describe("çıkış bağlantısı canlı yolda ATLANAMAZ", () => {
  it("uç nokta kanıtı silinirse (ör. adres değişti) gönderim durur, kampanya duraklatılacak kodla", async () => {
    await setUnsubscribeBaseUrl(db, "https://baska.firma-ornek.com", T0); // kanıtları sıfırlar
    const a = await sequence();
    expect(await send(a.cl)).toMatchObject({
      outcome: "not_sendable",
      code: "unsubscribe_unavailable",
    });
    await noSendNoRecord();
  });
});
