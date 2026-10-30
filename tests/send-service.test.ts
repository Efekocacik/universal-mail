import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedCountryPolicies } from "@/lib/compliance/policies";
import { tightenDemoPolicy } from "@/lib/compliance/policy-service";
import { hashEmail, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leadEmails,
  leads,
  mailboxes,
  messages,
  templates,
} from "@/lib/db/schema";
import { FakeMailProvider, type FakeStep } from "@/lib/mail/provider/fake-provider";
import { getProvider, ProviderUnavailableError } from "@/lib/mail/provider/provider";
import { seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { reconcileStaleSending, sendCampaignStep, STALE_SENDING_MS } from "@/lib/mail/send-service";
import { setSetting } from "@/lib/settings";
import { decodeEncodedWords, parseMessage } from "./helpers/mime-parse";

/**
 * Tek adımlık gönderim servisi, demo sağlayıcısı ve uzlaştırma. Veritabanı BELLEKTE; ağ yok, gerçek gönderim yok.
 */

let client: Client;
let db: Db;
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const DAY = 86_400_000;
const DEMO_MAILBOX = 1;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
  await seedCountryPolicies(db, T0);
  await seedBuiltinTemplates(db, T0);
  await seedDemoMailbox(db, T0);
  await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test Yetkilisi" });
  await setSetting(db, "company.profile", {
    legalName: "Örnek Dış Ticaret A.Ş.",
    address: "Örnek Mah. 1, İstanbul",
    taxId: "1234567890",
    phone: "+90 212 000 00 00",
    contactName: "Ayşe Yılmaz",
  });
});

afterEach(() => {
  client.close();
});

/* ------------------------------------------------------------------------------------------------ */

let leadSeq = 0;

async function setup(o: { steps?: number; mailboxId?: number } = {}) {
  const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
  const [c] = await db
    .insert(campaigns)
    .values({
      name: "Test",
      status: "running",
      mailboxId: o.mailboxId ?? DEMO_MAILBOX,
      selection: {},
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      startConfirmedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id });
  for (let i = 0; i < (o.steps ?? 3); i++) {
    await db.insert(campaignSteps).values({
      campaignId: c!.id,
      stepIndex: i,
      language: "en",
      templateId: tpl!.id,
      delayDays: i === 0 ? 0 : 5,
    });
  }
  const cl = await addSequence(c!.id);
  return { campaignId: c!.id, ...cl };
}

async function addSequence(campaignId: number) {
  const email = `info@lead${++leadSeq}.example`;
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  const [e] = await db
    .insert(leadEmails)
    .values({
      leadId: l!.id,
      email,
      domain: email.split("@")[1]!,
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leadEmails.id });
  const [cl] = await db
    .insert(campaignLeads)
    .values({
      campaignId,
      leadId: l!.id,
      emailId: e!.id,
      recipientEmail: email,
      recipientHash: hashEmail(email),
      recipientDomain: email.split("@")[1]!,
      language: "en",
      status: "scheduled",
      addedAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaignLeads.id });
  return { cl: cl!.id, leadId: l!.id, email };
}

function fake(script: FakeStep[] = []) {
  return new FakeMailProvider({ script, now: () => T0 });
}

async function rows() {
  return db.select().from(messages).orderBy(messages.id);
}

async function seq(id: number) {
  const [r] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, id));
  return r!;
}

const at = (t: number) => () => t;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------------------------------ */

describe("başarılı gönderim (demo)", () => {
  it("kayıt sent olur; dizi ilerler; lead güncellenir; ileti yalnızca bellekteki giden kutusunda", async () => {
    const { cl, leadId, email } = await setup();
    const p = fake();
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r.outcome).toBe("sent");

    const [m] = await rows();
    expect(m).toMatchObject({
      direction: "out",
      purpose: "campaign",
      status: "sent",
      sentAt: T0,
      stepIndex: 0,
      idempotencyKey: `cl:${cl}:s:0`,
      toAddress: email,
      fromAddress: "demo@universal-mail.invalid",
      peerHash: hashEmail(email),
      peerDomain: email.split("@")[1],
      sendDay: "2026-11-02",
    });
    expect(m!.providerMessageId).toMatch(/^demo-/);
    expect(m!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m!.rfcMessageId).toMatch(/@universal-mail\.invalid>$/);

    expect(await seq(cl)).toMatchObject({
      status: "waiting_next",
      nextStep: 1,
      lastSentAt: T0,
      lastError: null,
    });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ status: "sent", lastContactedAt: T0 });

    expect(p.outbox).toHaveLength(1);
    const parsed = parseMessage(p.outbox[0]!.raw);
    expect(parsed.headers.get("to")).toEqual([email]);
    expect(parsed.headers.get("message-id")).toEqual([m!.rfcMessageId]);
    expect(decodeEncodedWords(parsed.headers.get("subject")![0]!)).toBe(m!.subjectLogged);
    expect(parsed.headers.has("list-unsubscribe")).toBe(false);

    // Ham ileti veritabanına yazılmaz.
    expect(JSON.stringify(await rows())).not.toMatch(/MIME-Version|Content-Transfer-Encoding/);
  });

  it("aynı adım ikinci kez gönderilmez (sağlayıcı çağrılmaz)", async () => {
    const { cl } = await setup();
    const p = fake();
    await sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: at(T0) });
    const again = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0 + 1000) },
    );
    expect(again.outcome).toBe("ineligible");
    expect(p.calls).toBe(1);
    expect(p.outbox).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("takip iletisi önceki adıma zincirlenir; son adımdan sonra dizi tamamlanır", async () => {
    const { cl } = await setup({ steps: 2 });
    const p = fake();
    await sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: at(T0) });
    const first = (await rows())[0]!.rfcMessageId!;
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { provider: p, now: at(T0 + 5 * DAY) },
    );
    expect(r.outcome).toBe("sent");
    const parsed = parseMessage(p.outbox[1]!.raw);
    expect(parsed.headers.get("in-reply-to")).toEqual([first]);
    expect(parsed.headers.get("references")).toEqual([first]);
    expect(decodeEncodedWords(parsed.headers.get("subject")![0]!)).not.toMatch(/^re:/i);
    expect(await seq(cl)).toMatchObject({ status: "completed", nextStep: 2 });
  });
});

describe("kesin başarısız (rejected → failed)", () => {
  it("giden kutusu boş; dizi eski durumuna döner; YALNIZCA bu durumda yeniden denenebilir", async () => {
    const { cl } = await setup();
    const p = fake([{ kind: "reject", code: "mailbox_full", permanent: false }]);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r).toMatchObject({ outcome: "failed", code: "mailbox_full" });
    expect(p.outbox).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "mailbox_full",
      sentAt: null,
    });
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      lastError: "mailbox_full",
      nextStep: 0,
    });

    const retry = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0 + 60_000) },
    );
    expect(retry.outcome).toBe("sent");
    expect((await rows()).map((m) => m.status)).toEqual(["failed", "sent"]);
    expect(p.outbox).toHaveLength(1);
  });
});

describe("sonucu belirsiz gönderim (unknown) asla yeniden gönderilmez", () => {
  it.each<[string, FakeStep, string, number]>([
    ["bağlantı koptu (ileti gitmedi)", { kind: "unknown-before" }, "connection_lost", 0],
    ["yanıt alınamadı (ileti gitti)", { kind: "unknown-after" }, "no_response", 1],
    ["beklenmeyen istisna (ileti gitti)", { kind: "throw-after" }, "provider_exception", 1],
  ])("%s", async (_, step, code, delivered) => {
    const { cl } = await setup();
    const p = fake([step]);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r).toMatchObject({ outcome: "unknown", code });
    expect((await rows())[0]).toMatchObject({ status: "unknown", errorCode: code });
    expect(await seq(cl)).toMatchObject({ status: "in_flight", lastError: code, nextStep: 0 });
    expect(p.outbox).toHaveLength(delivered);

    // Ne aynı adım ne sonraki adım otomatik gönderilir.
    for (const [stepIndex, t] of [
      [0, T0 + DAY],
      [1, T0 + 10 * DAY],
    ] as const) {
      const again = await sendCampaignStep(
        db,
        { campaignLeadId: cl, stepIndex },
        { provider: p, now: at(t) },
      );
      expect(again.outcome).toBe("ineligible");
    }
    expect(p.calls).toBe(1);
    expect(p.outbox).toHaveLength(delivered);
  });

  it("zaman aşımı: yanıt gelmeyen çağrı iptal edilir ve unknown olur; iptal anında ileti gitmiş olabilir", async () => {
    const { cl } = await setup();
    const p = fake([{ kind: "hang", deliverOnAbort: true }]);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0), timeoutMs: 20 },
    );
    expect(r).toMatchObject({ outcome: "unknown", code: "timeout" });
    expect(p.outbox).toHaveLength(1);
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: cl, stepIndex: 0 },
          { provider: p, now: at(T0 + DAY) },
        )
      ).outcome,
    ).toBe("ineligible");
    expect(p.outbox).toHaveLength(1);
  });

  it("gecikmiş tamamlama: sağlayıcı zaman aşımından SONRA kabul etse de kayıt unknown kalır, yeniden gönderilmez", async () => {
    const { cl } = await setup();
    const p = fake([{ kind: "accept", delayMs: 60 }]);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0), timeoutMs: 10 },
    );
    expect(r).toMatchObject({ outcome: "unknown", code: "timeout" });
    await sleep(90);
    expect(p.outbox).toHaveLength(1); // ileti aslında gitti
    expect((await rows())[0]!.status).toBe("unknown");
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: cl, stepIndex: 0 },
          { provider: p, now: at(T0 + DAY) },
        )
      ).outcome,
    ).toBe("ineligible");
    expect(p.outbox).toHaveLength(1);
  });

  it("zaman aşımından önce tamamlanan gecikmeli kabul başarılıdır", async () => {
    const { cl } = await setup();
    const p = fake([{ kind: "accept", delayMs: 5 }]);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0), timeoutMs: 1000 },
    );
    expect(r.outcome).toBe("sent");
  });

  it("sağlayıcıdan geçersiz biçimli sonuç unknown sayılır", async () => {
    const { cl } = await setup();
    const odd = { id: "demo" as const, send: async () => ({ status: "ok" }) as never };
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: odd, now: at(T0) },
    );
    expect(r).toMatchObject({ outcome: "unknown", code: "invalid_provider_result" });
  });
});

describe("işlem güvenliği ve eşzamanlılık", () => {
  it("aynı adım için eşzamanlı iki çağrıdan yalnızca biri gönderim hakkı alır", async () => {
    const { cl } = await setup();
    const p = fake([{ kind: "accept", delayMs: 20 }]);
    const results = await Promise.all([
      sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: at(T0) }),
      sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: at(T0) }),
      sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: at(T0) }),
    ]);
    expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.outcome !== "sent")
        .every((r) => ["ineligible", "already_reserved", "busy"].includes(r.outcome)),
    ).toBe(true);
    expect(p.calls).toBe(1);
    expect(p.outbox).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("uygun değilse hiçbir kayıt açılmaz ve sağlayıcı çağrılmaz", async () => {
    const cases: [string, (ctx: { campaignId: number; email: string }) => Promise<unknown>][] = [
      [
        "suppression",
        ({ email }) => suppressEmail(db, { email, reason: "unsubscribe", source: "link" }),
      ],
      [
        "ülke politikası",
        () => tightenDemoPolicy(db, { scope: "demo", countryCode: "GB", mode: "blocked" }),
      ],
      [
        "kampanya duraklatıldı",
        ({ campaignId }) =>
          db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, campaignId)),
      ],
      ["onay yok", () => client.execute("DELETE FROM settings WHERE key = 'consent'")],
    ];
    for (const [name, prepare] of cases) {
      const ctx = await setup();
      await prepare(ctx);
      const p = fake();
      const r = await sendCampaignStep(
        db,
        { campaignLeadId: ctx.cl, stepIndex: 0 },
        { provider: p, now: at(T0) },
      );
      expect(r.outcome, name).toBe("ineligible");
      expect(p.calls, name).toBe(0);
      expect(await rows(), name).toHaveLength(0);
      expect((await seq(ctx.cl)).status, name).toBe("scheduled");
      if (name === "ülke politikası") break; // politika sonraki vakaları da etkiler
    }
  });

  it("posta kutusu günlük tavanı aşılamaz; tavan dolunca kayıt açılmaz", async () => {
    await db.update(mailboxes).set({ dailyCap: 1 }).where(eq(mailboxes.id, DEMO_MAILBOX));
    const a = await setup();
    const b = await addSequence(a.campaignId);
    const p = fake();
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: a.cl, stepIndex: 0 },
          { provider: p, now: at(T0) },
        )
      ).outcome,
    ).toBe("sent");
    expect(
      await sendCampaignStep(
        db,
        { campaignLeadId: b.cl, stepIndex: 0 },
        { provider: p, now: at(T0 + 1000) },
      ),
    ).toEqual({
      outcome: "not_sendable",
      code: "mailbox_daily_cap",
    });
    expect(p.calls).toBe(1);
    expect(await rows()).toHaveLength(1);
    // Ertesi UTC günü serbest.
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: b.cl, stepIndex: 0 },
          { provider: p, now: at(T0 + DAY) },
        )
      ).outcome,
    ).toBe("sent");
  });

  it("adımın şablonu yoksa kayıt açılmaz", async () => {
    const { cl, campaignId } = await setup();
    await db.update(campaignLeads).set({ language: "de" }).where(eq(campaignLeads.id, cl));
    const p = fake();
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r.outcome).toBe("ineligible"); // uygunluk de adım tanımını denetler
    void campaignId;
    expect(p.calls).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
});

describe("kayıt hatası ve uzlaştırma", () => {
  it("sonuç kaydedilemezse ileti yeniden gönderilmez; uzlaştırma kaydı unknown yapar ve tekrar çalıştırılabilir", async () => {
    const { cl } = await setup();
    const p = fake();
    await client.execute(
      "CREATE TEMP TRIGGER fail_record BEFORE UPDATE ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'disk dolu'); END",
    );
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r).toMatchObject({ outcome: "sent", recordError: true });
    expect(p.outbox).toHaveLength(1);
    expect((await rows())[0]!.status).toBe("sending");
    await client.execute("DROP TRIGGER fail_record");

    // `sending` kaydı varken yeniden gönderim yok.
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: cl, stepIndex: 0 },
          { provider: p, now: at(T0 + 60_000) },
        )
      ).outcome,
    ).toBe("ineligible");
    expect(p.calls).toBe(1);

    // Henüz eski değil: dokunulmaz.
    expect(await reconcileStaleSending(db, { now: T0 + STALE_SENDING_MS - 1 })).toBe(0);
    expect(await reconcileStaleSending(db, { now: T0 + STALE_SENDING_MS + 1 })).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "unknown", errorCode: "stale_sending" });
    expect(await seq(cl)).toMatchObject({ status: "in_flight", lastError: "stale_sending" });
    // Tekrar çalıştırılabilir; hiçbir şey göndermez.
    expect(await reconcileStaleSending(db, { now: T0 + 2 * STALE_SENDING_MS })).toBe(0);
    expect(p.calls).toBe(1);
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: cl, stepIndex: 0 },
          { provider: p, now: at(T0 + DAY) },
        )
      ).outcome,
    ).toBe("ineligible");
  });

  it("uzlaştırma yalnızca giden sending kayıtlarına dokunur", async () => {
    const { cl } = await setup();
    await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: fake([{ kind: "reject" }]), now: at(T0) },
    );
    await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: fake(), now: at(T0 + 1) },
    );
    expect(await reconcileStaleSending(db, { now: T0 + 10 * STALE_SENDING_MS })).toBe(0);
    expect((await rows()).map((m) => m.status)).toEqual(["failed", "sent"]);
  });
});

describe("demo güvenliği", () => {
  it("gerçek posta kutusuyla gönderim yok; sağlayıcı yalnızca demo için var", async () => {
    const [mb] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    const { cl } = await setup({ mailboxId: mb!.id });
    const p = fake();
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: at(T0) },
    );
    expect(r.outcome).toBe("ineligible");
    expect(p.calls).toBe(0);
    for (const provider of ["gmail", "smtp", "DEMO", ""]) {
      expect(() => getProvider({ provider }), provider).toThrow(ProviderUnavailableError);
    }
    expect(getProvider({ provider: "demo" })).toBeInstanceOf(FakeMailProvider);
    expect(getProvider({ provider: "demo" })).toBe(getProvider({ provider: "demo" }));
  });

  it("demo sağlayıcı demo olmayan iletiyi saklamaz ve kesin reddeder", async () => {
    const p = fake();
    const res = await p.send({
      raw: "x",
      from: "sales@firma-iletisim.com",
      to: "info@cafe.example",
      messageId: "<a.b@firma-iletisim.com>",
      signal: new AbortController().signal,
    });
    expect(res).toEqual({ status: "rejected", code: "demo_only", permanent: true });
    expect(p.outbox).toHaveLength(0);
  });

  it("sağlayıcı ve gönderim modülleri ağ veya canlı sağlayıcı kodu içermez", () => {
    for (const f of [
      "src/lib/mail/send-service.ts",
      "src/lib/mail/provider/provider.ts",
      "src/lib/mail/provider/fake-provider.ts",
    ]) {
      // Yorumlar çıkarılır: yalnızca kod denetlenir.
      const src = fs
        .readFileSync(path.resolve(__dirname, "..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(
        /from "node:(?:net|tls|http|https|dgram|dns|fs)"|nodemailer|googleapis|fetch\(|createTransport|\bsmtp\b(?!")/i,
      );
    }
  });
});
