import crypto from "node:crypto";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pixelRoute from "@/app/api/t/o/[token]/route";
import { getCampaignStats } from "@/lib/campaigns/stats";
import type { Db } from "@/lib/db/client";
import { messageOpens, messages } from "@/lib/db/schema";
import {
  buildEmailMessage,
  DEMO_OPEN_PIXEL_BASE,
  MessageBuildError,
} from "@/lib/mail/mime/message-builder";
import {
  createOpenToken,
  DEMO_OPEN_PERCENT,
  demoOpenDecision,
  demoOpenPixelUrl,
  MAX_OPEN_COUNT,
  pixelMessageQuery,
  pixelRateLimited,
  recordPixelOpen,
  resetPixelRateLimitForTests,
  simulateDemoOpen,
  TRANSPARENT_GIF,
  verifyOpenToken,
} from "@/lib/mail/open-tracking";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { setSetting, settingSchemas } from "@/lib/settings";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { parseMessage } from "./helpers/mime-parse";

/** İletinin bütün gövde parçaları (çözücü aktarım kodlamasını açar). */
const bodies = (raw: string) =>
  parseMessage(raw)
    .parts.map((p) => p.body)
    .join("\n");

/**
 * Faz 5 (paket T): açılma izleme — varsayılan KAPALI, yalnızca DEMO. Belirteç imzası ve kurcalama, demo benzetiminin
 * belirlenimciliği, pikselin yalnızca ayar açık + demo iletisinde bulunması (canlıda asla), yerel piksel ucunun her
 * durumda aynı GIF'i döndürmesi ve açılmaların sayılması. Ana anahtar test ortamında sabittir; gerçek `.data` açılmaz.
 */

const HANDLE = "__umDbHandle";
const KEY = "ab".repeat(32);
let savedKey: string | undefined;
let client: Client;
let db: Db;

beforeAll(() => {
  savedKey = process.env.UM_MASTER_KEY;
  process.env.UM_MASTER_KEY = KEY;
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.UM_MASTER_KEY;
  else process.env.UM_MASTER_KEY = savedKey;
});
beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  resetPixelRateLimitForTests();
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

const enable = () => setSetting(db, "tracking.opens", { enabled: true, ackAt: T0 });

async function sendOne(campaignId: number, at = T0) {
  const s = await addSequence(db, campaignId);
  const p = new FakeMailProvider({ now: () => at });
  const r = await sendCampaignStep(
    db,
    { campaignLeadId: s.cl, stepIndex: 0 },
    { provider: p, now: () => at },
  );
  expect(r.outcome).toBe("sent");
  const [m] = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
  return { s, p, m: m!, raw: p.outbox.at(-1)!.raw };
}

const pixel = (token: string) =>
  pixelRoute.GET(new Request(`http://127.0.0.1:3000/api/t/o/${token}`), {
    params: Promise.resolve({ token }),
  });

describe("belirteç", () => {
  it("imzalı, doğrulanır; kurcalanmış, biçimsiz veya başka anahtarla imzalı belirteç reddedilir", () => {
    const tok = createOpenToken({ campaignLeadId: 1234, stepIndex: 1 });
    expect(tok).toMatch(/^o1\.[0-9a-z]+\.1\.[A-Za-z0-9_-]{22}$/);
    expect(verifyOpenToken(tok)).toEqual({ campaignLeadId: 1234, stepIndex: 1 });
    // Kişisel veri yok: yalnızca dizi numarası ve adım.
    expect(tok).not.toMatch(/@/);

    const [v, id, step, mac] = tok.split(".");
    const flipped = mac!.startsWith("A") ? `B${mac!.slice(1)}` : `A${mac!.slice(1)}`;
    expect(verifyOpenToken(`${v}.${id}.${step}.${flipped}`)).toBeNull();
    expect(verifyOpenToken(`${v}.${id}.2.${mac}`)).toBeNull();
    expect(verifyOpenToken(`${v}.zz.${step}.${mac}`)).toBeNull();
    expect(verifyOpenToken("o1.1.0")).toBeNull();
    expect(verifyOpenToken("x".repeat(65))).toBeNull();
    expect(verifyOpenToken(null as unknown as string)).toBeNull();

    process.env.UM_MASTER_KEY = "cd".repeat(32);
    try {
      expect(verifyOpenToken(tok)).toBeNull();
    } finally {
      process.env.UM_MASTER_KEY = KEY;
    }
  });

  it("geçersiz girdiyle belirteç üretilmez", () => {
    expect(() => createOpenToken({ campaignLeadId: 0, stepIndex: 0 })).toThrow();
    expect(() => createOpenToken({ campaignLeadId: 1, stepIndex: 3 })).toThrow();
    expect(
      demoOpenPixelUrl({ campaignLeadId: 5, stepIndex: 0 }).startsWith(DEMO_OPEN_PIXEL_BASE),
    ).toBe(true);
  });
});

describe("demo benzetimi", () => {
  it("belirlenimci; ~%40 açılır; gecikme 5–240 dakika", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
    const ds = ids.map(demoOpenDecision);
    expect(ids.map(demoOpenDecision)).toEqual(ds);
    const rate = ds.filter((d) => d.opened).length / ids.length;
    expect(Math.abs(rate - DEMO_OPEN_PERCENT / 100)).toBeLessThan(0.04);
    expect(ds.every((d) => d.delayMin >= 5 && d.delayMin <= 240)).toBe(true);
    // Tanım: sha256(messageId) ilk 4 bayt % 100 < 40.
    const h = crypto.createHash("sha256").update("7").digest();
    expect(demoOpenDecision(7).opened).toBe(h.readUInt32BE(0) % 100 < 40);
  });
});

describe("ayar", () => {
  it("varsayılan kapalı; onaysız açma şemada reddedilir", () => {
    const s = settingSchemas["tracking.opens"];
    expect(s.safeParse({ enabled: true, ackAt: null }).success).toBe(false);
    expect(s.safeParse({ enabled: true, ackAt: T0 }).success).toBe(true);
  });
});

describe("gönderim yolu", () => {
  it("izleme kapalıyken piksel yok ve açılma yazılmaz", async () => {
    const campaignId = await createCampaign(db, { steps: 1 });
    const { raw } = await sendOne(campaignId);
    expect(bodies(raw)).not.toContain("open.invalid");
    expect(bodies(raw)).not.toMatch(/<img/i);
    expect(await db.select().from(messageOpens)).toHaveLength(0);
  });

  it("izleme açık + demo: HTML'de piksel; ileti açılanlardansa demo_simulated açılma (tekrarlanabilir)", async () => {
    await enable();
    const campaignId = await createCampaign(db, { steps: 1 });
    const results = [] as Awaited<ReturnType<typeof sendOne>>[];
    for (let i = 0; i < 6; i++) results.push(await sendOne(campaignId, T0 + i * 10 * 60_000));
    for (const r of results) {
      expect(bodies(r.raw)).toContain(`<img src="${DEMO_OPEN_PIXEL_BASE}o1.`);
    }
    const opens = await db.select().from(messageOpens);
    const expected = results.filter((r) => demoOpenDecision(r.m.id).opened);
    expect(opens.map((o) => o.messageId).sort()).toEqual(expected.map((r) => r.m.id).sort());
    for (const o of opens) {
      const m = results.find((r) => r.m.id === o.messageId)!.m;
      expect(o.source).toBe("demo_simulated");
      expect(o.firstOpenedAt - m.sentAt!).toBe(demoOpenDecision(m.id).delayMin * 60_000);
    }
    // Aynı ileti için ikinci benzetim satırı değiştirmez.
    if (expected[0]) {
      const m = expected[0].m;
      await simulateDemoOpen(db, { messageId: m.id, campaignId, sentAt: m.sentAt! + 1 });
      const [o] = await db.select().from(messageOpens).where(eq(messageOpens.messageId, m.id));
      expect(o!.firstOpenedAt).toBe(m.sentAt! + demoOpenDecision(m.id).delayMin * 60_000);
    }
    const stats = await getCampaignStats(db, campaignId);
    expect(stats.opens).toEqual({
      enabled: true,
      liveSupported: false,
      sent: 6,
      opened: expected.length,
    });
  });

  it("oluşturucu: piksel yalnızca demo ve demo tabanıyla; canlıda ileti oluşturulmaz", () => {
    const base = {
      composed: {
        sendable: true,
        errors: [],
        subject: "S",
        html: "<p>x</p>",
        text: "x",
        language: "en",
      },
      mailbox: { provider: "demo", address: "demo@universal-mail.invalid", status: "connected" },
      profile: { contactName: "Ayşe", legalName: "Örnek A.Ş." },
      recipient: "info@a.example",
      mode: "demo" as const,
      now: T0,
    };
    const ok = buildEmailMessage({
      ...base,
      openPixelUrl: demoOpenPixelUrl({ campaignLeadId: 3, stepIndex: 0 }),
    });
    expect(bodies(ok.raw)).toContain(`<img src="${DEMO_OPEN_PIXEL_BASE}o1.`);
    expect(() =>
      buildEmailMessage({ ...base, openPixelUrl: "https://evil.example/x.gif" }),
    ).toThrow(MessageBuildError);
    expect(() =>
      buildEmailMessage({ ...base, openPixelUrl: `${DEMO_OPEN_PIXEL_BASE}"><script>` }),
    ).toThrow(MessageBuildError);
    expect(() =>
      buildEmailMessage({
        ...base,
        mode: "live",
        mailbox: { provider: "gmail", address: "me@a.example", status: "connected" },
        openPixelUrl: demoOpenPixelUrl({ campaignLeadId: 3, stepIndex: 0 }),
      }),
    ).toThrow(MessageBuildError);
  });
});

describe("GET /api/t/o/:token", () => {
  async function gif(token: string) {
    const r = await pixel(token);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/gif");
    expect(r.headers.get("cache-control")).toContain("no-store");
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBe(43);
    expect(body.equals(TRANSPARENT_GIF)).toBe(true);
  }

  it("her durumda aynı GIF; yalnızca açık + geçerli belirteçte açılma yazılır ve sayaç artar", async () => {
    const campaignId = await createCampaign(db, { steps: 1 });
    const { s, m } = await sendOne(campaignId);
    const tok = createOpenToken({ campaignLeadId: s.cl, stepIndex: 0 });

    await gif(tok); // izleme kapalı
    expect(await db.select().from(messageOpens)).toHaveLength(0);

    await enable();
    await gif("bozuk");
    await gif(createOpenToken({ campaignLeadId: 99_999, stepIndex: 0 }));
    expect(await db.select().from(messageOpens)).toHaveLength(0);

    await gif(tok);
    await gif(tok);
    const [o] = await db.select().from(messageOpens);
    expect(o).toMatchObject({ messageId: m.id, campaignId, openCount: 2, source: "pixel" });
    expect(await recordPixelOpen(db, tok)).toBe("recorded");
  });

  it("açılma sayacı sınırlıdır; veritabanı hatasında da GIF döner", async () => {
    await enable();
    const campaignId = await createCampaign(db, { steps: 1 });
    const { s, m } = await sendOne(campaignId);
    const tok = createOpenToken({ campaignLeadId: s.cl, stepIndex: 0 });
    await recordPixelOpen(db, tok, T0 + 1000);
    await db
      .update(messageOpens)
      .set({ openCount: MAX_OPEN_COUNT })
      .where(eq(messageOpens.messageId, m.id));
    await recordPixelOpen(db, tok, T0 + 2000);
    const [o] = await db.select().from(messageOpens);
    expect(o!.openCount).toBe(MAX_OPEN_COUNT);

    (globalThis as Record<string, unknown>)[HANDLE] = Promise.reject(new Error("db down"));
    await gif(tok);
  });

  it("ileti araması kısmi idempotency dizinini kullanır (tablo taraması yok); gönderilmemiş ileti sayılmaz", async () => {
    const q = pixelMessageQuery(db, { campaignLeadId: 7, stepIndex: 0 }).toSQL();
    const plan = await client.execute({
      sql: `EXPLAIN QUERY PLAN ${q.sql}`,
      args: q.params as never,
    });
    const detail = plan.rows.map((r) => String(r.detail)).join("\n");
    expect(detail).toContain("messages_idempotency_uq");
    expect(detail).not.toMatch(/SCAN messages/);

    await enable();
    const campaignId = await createCampaign(db, { steps: 1 });
    const { s, m } = await sendOne(campaignId);
    const tok = createOpenToken({ campaignLeadId: s.cl, stepIndex: 0 });
    await db.update(messages).set({ status: "unknown" }).where(eq(messages.id, m.id));
    expect(await recordPixelOpen(db, tok)).toBe("unknown_message");
    // (Demo gönderimi benzetim açılması yazmış olabilir; piksel kaynaklı satır olmamalı.)
    const opens = await db.select().from(messageOpens);
    expect(opens.filter((o) => o.source === "pixel")).toHaveLength(0);
  });

  it("hız sınırı dakikada 120 kayıt", () => {
    for (let i = 0; i < 120; i++) expect(pixelRateLimited(T0)).toBe(false);
    expect(pixelRateLimited(T0)).toBe(true);
    expect(pixelRateLimited(T0 + 60_000)).toBe(false);
  });
});
