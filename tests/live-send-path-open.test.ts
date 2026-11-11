import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import { CampaignError } from "@/lib/campaigns/errors";
import { campaignBlockers } from "@/lib/campaigns/preflight";
import {
  assertSendableMailbox,
  createCampaign as createCampaignSvc,
  updateCampaign,
} from "@/lib/campaigns/service";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import type { Db } from "@/lib/db/client";
import { campaigns, jobs, mailboxes } from "@/lib/db/schema";
import { getLiveProvider } from "@/lib/mail/gmail/provider";
import type { MailProvider, ProviderSendInput } from "@/lib/mail/provider/provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  createMailSendHandler,
  isMailSchedulerEnabled,
  MAIL_SEND_JOB,
  SCHEDULER_FLAG,
  startMailScheduler,
} from "@/lib/mail/scheduler/job";
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
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox } from "./helpers/inbound-fixture";

// Bu dosyada YALNIZCA test içinde (mevcut geçersiz kılma yöntemi, bkz. live-send-wiring.test.ts): canlı kilit "açık",
// bütün hukuki onaylar "verilmiş" ve uygunluk "uygun" varsayılır. Gerçek sabitler DEĞİŞMEZ.
vi.mock("@/lib/compliance/policies", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/policies")>()),
  LIVE_SENDING_ENABLED: true,
}));
vi.mock("@/lib/compliance/legal-status", async (orig) => {
  const m = await orig<typeof import("@/lib/compliance/legal-status")>();
  return {
    ...m,
    LEGAL_APPROVALS: Object.fromEntries(Object.keys(m.LEGAL_APPROVALS).map((k) => [k, true])),
  };
});
vi.mock("@/lib/compliance/eligibility", async (orig) => ({
  ...(await orig<typeof import("@/lib/compliance/eligibility")>()),
  evaluateSend: async () => ({ eligible: true, reasons: [] }),
}));
// Canlı sağlayıcı fabrikası: gerçek Gmail bağdaştırıcısı yerine kaydeden sahte sağlayıcı (ağ YOK).
const live = vi.hoisted(() => ({
  sent: [] as ProviderSendInput[],
  calls: [] as { id: number; provider: string }[],
}));
vi.mock("@/lib/mail/gmail/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/mail/gmail/provider")>()),
  getLiveProvider: vi.fn((_db: unknown, mb: { id: number; provider: string }): MailProvider => {
    live.calls.push({ id: mb.id, provider: mb.provider });
    return {
      id: "gmail",
      send: async (input) => {
        live.sent.push(input);
        return { status: "accepted", providerMessageId: "gm1", threadId: "gt1", acceptedAt: T0 };
      },
    };
  }),
}));

/**
 * Canlı gönderim yolunun bağlantısı (go-live C1) — KAPI AÇIK (yalnızca testte). Gmail kampanyası kabul edilir,
 * dağıtıcı onu aday yapar ve ileti `getLiveProvider` üzerinden gider. Gerçek ağ isteği YOK.
 */

const BASE = "https://cikis.firma-ornek.com";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let dir: string;
let gid: number;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-livep-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "cd".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  gid = await addMailbox(db, { provider: "gmail", address: "satis@firma-ornek.com" });
  await grant(gid, true);
  live.sent.length = 0;
  live.calls.length = 0;
  vi.mocked(getLiveProvider).mockClear();
  delete process.env[SCHEDULER_FLAG];
  globalFetch = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled(); // gerçek ağ isteği YOK
  globalFetch.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function grant(id: number, send: boolean) {
  await setSetting(db, "mail.gmailGrants", { [String(id)]: { send, read: false, at: T0 } });
}

async function expectCode(p: Promise<unknown>, code: string, detail?: Record<string, unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CampaignError);
  expect((e as CampaignError).code).toBe(code);
  if (detail) expect((e as CampaignError).detail).toMatchObject(detail);
}

/** Süreç içi aktarıcıyla doğrulanmış tek tıklamalı çıkış uç noktası (canlı yolun zorunlu iç kapısı). */
async function verifiedEndpoint() {
  const spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => T0 });
  const relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => T0 });
  const pull = createSpoolPullHandler({
    spool,
    keys: () => exportChannelPublicKeys(db),
    now: () => T0,
  });
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url as string, init);
    const p = new URL(req.url).pathname;
    if (p.startsWith("/u/")) return relay(req);
    if (p.startsWith("/spool/")) return pull(req);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
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
}

describe("canlı kapı açık (test): zamanlayıcı", () => {
  it("kapı açıkken demo bayrağı olmadan da açılır ve dağıtımı planlar", async () => {
    expect(isLiveSendingPermitted()).toBe(true);
    expect(isMailSchedulerEnabled({})).toBe(true);
    const r = await startMailScheduler(db, { env: {}, now: () => T0, timers: false });
    expect(r.enabled).toBe(true);
    const rows = await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB));
    expect(rows).toHaveLength(1);
  });
});

describe("canlı kapı açık (test): kampanya posta kutusu", () => {
  it("bağlı ve gönderim izinli Gmail kutusu kabul edilir (oluşturma ve güncelleme)", async () => {
    await expect(assertSendableMailbox(db, gid)).resolves.toBeUndefined();
    const c = await createCampaignSvc(db, { name: "Canlı", mailboxId: gid }, { now: T0 });
    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, c.id));
    expect(row!.mailboxId).toBe(gid);
    const d = await createCampaignSvc(db, { name: "Demo", mailboxId: DEMO_MAILBOX }, { now: T0 });
    await expect(
      updateCampaign(db, d.id, { mailboxId: gid }, { expectedUpdatedAt: d.updatedAt, now: T0 }),
    ).resolves.toMatchObject({ updatedAt: expect.any(Number) });
  });

  it("gönderim izni yoksa (yalnızca okuma veya kayıt yok) reddedilir", async () => {
    await grant(gid, false);
    await expectCode(assertSendableMailbox(db, gid), "invalid_input", { sendGrant: false });
    await setSetting(db, "mail.gmailGrants", {});
    await expectCode(createCampaignSvc(db, { name: "Canlı", mailboxId: gid }), "invalid_input", {
      sendGrant: false,
    });
  });

  it("bağlı olmayan Gmail kutusu reddedilir; SMTP kapı açıkken de live_disabled", async () => {
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, gid));
    await expectCode(assertSendableMailbox(db, gid), "invalid_input", { mailboxStatus: "error" });
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
    await grant(m!.id, true);
    await expectCode(assertSendableMailbox(db, m!.id), "live_disabled");
  });

  it("ön denetim: izinli Gmail kampanyasında live_disabled ve scheduler_disabled YOK; izinsizde mailbox_not_ready", async () => {
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    const blockers = await campaignBlockers(db, c!, {});
    expect(blockers).not.toContain("live_disabled");
    expect(blockers).not.toContain("scheduler_disabled");
    expect(blockers).not.toContain("mailbox_not_ready");
    await grant(gid, false);
    expect(await campaignBlockers(db, c!, {})).toContain("mailbox_not_ready");
  });

  it("GET /api/mailboxes: izinli Gmail sendable=true, izinsiz sendable=false", async () => {
    const list = async () => {
      const res = await mailboxesRoute.GET(
        new Request("http://127.0.0.1:3000/api/mailboxes"),
        undefined,
      );
      return ((await res.json()) as { items: { id: number; sendable: boolean }[] }).items;
    };
    expect((await list()).find((m) => m.id === gid)!.sendable).toBe(true);
    await grant(gid, false);
    expect((await list()).find((m) => m.id === gid)!.sendable).toBe(false);
  });
});

describe("canlı kapı açık (test): dağıtıcı", () => {
  it("Gmail kampanyası aday olur ve ileti getLiveProvider üzerinden gider (sağlayıcı verilmeden)", async () => {
    await verifiedEndpoint();
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    await addSequence(db, id, { nextSendAt: null, email: "kisi@alici-ornek.com" });
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0 });
    expect(r.send).toMatchObject({ outcome: "sent", providerMessageId: "gm1" });
    expect(getLiveProvider).toHaveBeenCalledTimes(1);
    expect(live.calls).toEqual([{ id: gid, provider: "gmail" }]);
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]!.from).toBe("satis@firma-ornek.com");
    expect(live.sent[0]!.raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  });

  it("mail.send işleyicisi kapı açıkken demo bayrağı olmadan dağıtır", async () => {
    await verifiedEndpoint();
    const id = await createCampaign(db, { status: "running", mailboxId: gid });
    await addSequence(db, id, { nextSendAt: null, email: "kisi@alici-ornek.com" });
    const handler = createMailSendHandler({
      enabled: isMailSchedulerEnabled({}),
      dispatcher: new MailDispatcher(db),
      now: () => T0,
    });
    const [job] = await db
      .insert(jobs)
      .values({
        type: MAIL_SEND_JOB,
        payload: {},
        status: "running",
        priority: 0,
        maxAttempts: 1,
        runAt: T0,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning();
    await handler({
      db,
      job: job!,
      payload: {},
      log: () => undefined,
      shouldStop: () => false,
    });
    expect(live.sent).toHaveLength(1);
  });
});
