import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import { gmailClientSchema } from "@/app/api/mail/schema";
import { CampaignError } from "@/lib/campaigns/errors";
import { campaignBlockers } from "@/lib/campaigns/preflight";
import {
  assertSendableMailbox,
  createCampaign as createCampaignSvc,
} from "@/lib/campaigns/service";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, jobs, mailboxes } from "@/lib/db/schema";
import type { MailProvider, ProviderSendInput } from "@/lib/mail/provider/provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  isMailSchedulerEnabled,
  SCHEDULER_FLAG,
  startMailScheduler,
} from "@/lib/mail/scheduler/job";
import { setSetting } from "@/lib/settings";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

// Bu sürümde gerçek kapı AÇIKTIR (sahip kararı). Kapı yeniden kapatılırsa (ör. acil geri alma sürümü) davranışın önceki
// demo-yalnız sürümle aynı kalacağını korumak için birleşik kapı bu dosyada YALNIZCA test içinde kapatılır.
vi.mock("@/lib/compliance/live-gate", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/live-gate")>()),
  isLiveSendingPermitted: () => false,
}));

/**
 * Canlı gönderim yolunun bağlantısı (go-live C1) — KAPI KAPALI (testte kapatılır). Davranış önceki demo-yalnız sürümle
 * aynı olmalı: Gmail kampanyası reddedilir, dağıtıcı Gmail kampanyalarını aday bile yapmaz, zamanlayıcı yalnızca demo
 * bayrağıyla açılır. Kapı açıkken davranış: `live-send-path-open.test.ts` ve (gerçek sabitlerle)
 * `live-gates-open.test.ts`.
 */

const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let gid: number;
let sent: ProviderSendInput[];
let provider: MailProvider;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  gid = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  // Gönderim izni bile verilmiş olsa kapı kapalıyken kutu kullanılamaz.
  await setSetting(db, "mail.gmailGrants", { [String(gid)]: { send: true, read: false, at: T0 } });
  sent = [];
  provider = {
    id: "demo",
    send: async (input) => {
      sent.push(input);
      return { status: "accepted", providerMessageId: "x", threadId: "t", acceptedAt: T0 };
    },
  };
  delete process.env[SCHEDULER_FLAG];
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  delete process.env[SCHEDULER_FLAG];
  client.close();
});

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CampaignError);
  expect((e as CampaignError).code).toBe(code);
}

describe("canlı kapı kapalı: önceki demo-yalnız davranış korunur", () => {
  it("kapı bu dosyada kapalı (gerçek sabitler açık; yalnızca birleşik kapı testte kapatıldı)", async () => {
    expect(isLiveSendingPermitted()).toBe(false);
    const real = await vi.importActual<typeof import("@/lib/compliance/live-gate")>(
      "@/lib/compliance/live-gate",
    );
    expect(real.isLiveSendingPermitted()).toBe(true);
  });

  it("zamanlayıcı yalnızca demo bayrağıyla açılır; kapalıyken veritabanına yazmaz", async () => {
    expect(isMailSchedulerEnabled({})).toBe(false);
    expect(isMailSchedulerEnabled({ [SCHEDULER_FLAG]: "1" })).toBe(true);
    const r = await startMailScheduler(db, { env: {}, now: () => T0, timers: false });
    expect(r.enabled).toBe(false);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("Gmail kutusu (bağlı + gönderim izinli) kampanyaya atanamaz: live_disabled", async () => {
    await expectCode(assertSendableMailbox(db, gid), "live_disabled");
    await expectCode(createCampaignSvc(db, { name: "Canlı", mailboxId: gid }), "live_disabled");
    expect(await db.select().from(campaigns)).toHaveLength(0);
    // Demo kutusu her zaman atanabilir.
    await expect(assertSendableMailbox(db, DEMO_MAILBOX)).resolves.toBeUndefined();
  });

  it("ön denetim: live_disabled ve scheduler_disabled engelleri sürer", async () => {
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    const blockers = await campaignBlockers(db, c!, {});
    expect(blockers).toContain("live_disabled");
    expect(blockers).toContain("scheduler_disabled");
  });

  it("dağıtıcı Gmail kampanyasını aday yapmaz: sağlayıcı çağrılmaz, dizi ve kampanya değişmez", async () => {
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    const s = await addSequence(db, id, { nextSendAt: null });
    const before = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider });
    expect(r.send).toBeNull();
    expect(r.pausedCampaigns).toEqual([]);
    expect(r.deferred + r.excluded).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl))).toEqual(before);
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    expect(c!.status).toBe("running");
  });

  it("demo kampanyası aynı turda gönderilir (demo yolu değişmedi)", async () => {
    const live = await createCampaign(db, { status: "running", mailboxId: gid });
    await addSequence(db, live, { nextSendAt: null });
    const demo = await createCampaign(db, { status: "running", mailboxId: DEMO_MAILBOX });
    await addSequence(db, demo, { nextSendAt: null });
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider });
    expect(r.send).toMatchObject({ outcome: "sent" });
    expect(sent).toHaveLength(1);
  });

  it("GET /api/mailboxes: Gmail kutusu sendable=false (izin olsa bile), demo sendable=true", async () => {
    const res = await mailboxesRoute.GET(
      new Request("http://127.0.0.1:3000/api/mailboxes"),
      undefined,
    );
    const items = ((await res.json()) as { items: { id: number; sendable: boolean }[] }).items;
    expect(items.find((m) => m.id === gid)!.sendable).toBe(false);
    expect(items.find((m) => m.id === DEMO_MAILBOX)!.sendable).toBe(true);
  });

  it("SMTP (sağlayıcısı olmayan) kutu: live_disabled", async () => {
    const [m] = await db
      .insert(mailboxes)
      .values({
        provider: "smtp",
        label: "SMTP",
        address: "smtp@firma-ornek.com",
        credentialsRef: "x",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    await expectCode(assertSendableMailbox(db, m!.id), "live_disabled");
  });
});

describe("OAuth istemci sırrı sınırı (C15): şema servisle aynı (200)", () => {
  it("200 karakter kabul, 201 karakter şemada reddedilir", () => {
    const clientId = "123456789012-abcdefgh.apps.googleusercontent.com";
    expect(gmailClientSchema.safeParse({ clientId, clientSecret: "s".repeat(200) }).success).toBe(
      true,
    );
    expect(gmailClientSchema.safeParse({ clientId, clientSecret: "s".repeat(201) }).success).toBe(
      false,
    );
  });
});
