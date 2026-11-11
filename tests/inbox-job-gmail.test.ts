import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_INBOX_READING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { jobs, mailboxes, messages, settings } from "@/lib/db/schema";
import { NonRetryableJobError, type JobContext } from "@/lib/jobs/registry";
import { GmailInboxError, GmailInboxReader } from "@/lib/mail/gmail/inbox";
import { resetOAuthMemoryForTests, type OAuthDeps } from "@/lib/mail/gmail/oauth";
import type { InboxReader } from "@/lib/mail/inbound/sync";
import { evaluateInboxSync } from "@/lib/mail/inbound/sync-status";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import {
  createInboxSyncHandler,
  INBOX_SYNC_INTERVAL_MS,
  INBOX_SYNC_JOB,
  isInboxSyncEnabled,
  MAX_INBOX_BACKOFF_MS,
  startInboxScheduler,
} from "@/lib/mail/scheduler/inbox-job";
import { mailboxRefreshTokenName, setSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { gmailWrap, startFakeGmailInbox, type FakeGmailInbox } from "./helpers/fake-gmail-inbox";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth-server";
import { NOW, rawMessage, seedSent, type Sent } from "./helpers/inbound-fixture";

/**
 * Gelen kutusu işinin Gmail bağlantısı (go-live C6). Kilit (`LIVE_INBOX_READING_ENABLED`) bu sürümde AÇIKTIR (sahip
 * kararı); kapalıyken korunması gereken davranış kilit testte kapatılarak sınanır (iş hiçbir Gmail kutusunu okumaz,
 * ağ isteği atmaz). Açıkken okuma izni olan Gmail kutusu yerel SAHTE Gmail/OAuth sunucularıyla eşitlenir ve
 * `mail.inboxSync` kanıtı yazılır. Gerçek Google'a istek yok.
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const RCPT = "kisi@alici-ornek.com";
const JOB_ID = 9_999;

let client: Client;
let db: Db;
let dir: string;
let oauth: FakeOAuth;
let inbox: FakeGmailInbox;
let deps: OAuthDeps;
let gid: number;
let sent: Sent;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-inboxjob-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  logs.length = 0;
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  oauth = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  inbox = await startFakeGmailInbox(ADDRESS);
  deps = oauth.deps(() => NOW);
  globalFetch = vi.spyOn(globalThis, "fetch");
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  gid = await connected();
  const campaign = await createCampaign(db, { status: "running" });
  sent = await seedSent(db, campaign, { mailboxId: gid, email: RCPT });
  await db.update(messages).set({ threadId: "t-out1" }).where(eq(messages.id, sent.outboundId));
});
afterEach(async () => {
  // 127.0.0.1 dışına (gerçek Google'a) HİÇBİR istek yok
  expect(
    globalFetch.mock.calls.filter((c: unknown[]) => !String(c[0]).startsWith("http://127.0.0.1:")),
  ).toHaveLength(0);
  globalFetch.mockRestore();
  resetOAuthMemoryForTests();
  await oauth.close();
  await inbox.close();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function connected(grants = { send: true, read: true }) {
  const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
  const refresh = "1//direct-refresh-token-zzzzzzzz";
  await setSecret(mailboxRefreshTokenName(id), refresh);
  oauth.validRefresh.add(refresh);
  await db
    .update(mailboxes)
    .set({ status: "connected", credentialsRef: mailboxRefreshTokenName(id), connectedAt: NOW })
    .where(eq(mailboxes.id, id));
  await db.insert(settings).values({
    key: "mail.gmailGrants",
    value: { [String(id)]: { ...grants, at: NOW } },
    updatedAt: NOW,
  });
  return id;
}

const reply = (nonce: string) =>
  gmailWrap(
    rawMessage({
      from: RCPT,
      to: ADDRESS,
      inReplyTo: sent.rfc,
      nonce,
      body: "Thanks, we would like to see your catalogue.",
    }),
    { mailbox: ADDRESS, headerFrom: RCPT.split("@")[1]! },
  );

/** Demo okuyucu casusu: hangi kutular için çağrıldığını kaydeder. */
function demoSpy(): InboxReader & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: "demo",
    calls,
    fetch: async (mailboxId) => {
      calls.push(mailboxId);
      return { items: [], nextCursor: null };
    },
  };
}

const fakeGmailReader = (d: Db) =>
  new GmailInboxReader({
    db: d,
    oauth: deps,
    apiBase: inbox.base,
    liveInboxEnabled: () => true,
    headerTrustVerified: () => true,
  });

const logs: string[] = [];
const ctx = (): JobContext => ({
  job: { id: JOB_ID } as never,
  payload: {},
  db,
  shouldStop: () => false,
  log: (m) => logs.push(m),
});

const inboundRows = () =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.direction, "in"), eq(messages.mailboxId, gid)));
const cursorOf = async () =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, gid)))[0]!.syncCursor;
const inboxJobs = () => db.select().from(jobs).where(eq(jobs.type, INBOX_SYNC_JOB));

/* ---------------------------------------------------------------------------------------------- */

describe("kilit kapalı (testte kapatılır): Gmail okunmaz, ağ isteği yok", () => {
  const CLOSED = () => false;

  it("demo bayrağı açık iş yalnızca demo kutusunu okur; okuma izni olan Gmail kutusuna dokunmaz", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("k1"), threadId: "t-out1" });
    const demo = demoSpy();
    await createInboxSyncHandler({
      enabled: true,
      reader: demo,
      liveInboxEnabled: CLOSED,
      now: () => NOW,
    })(ctx());

    expect(demo.calls).toEqual([DEMO_MAILBOX]); // demo davranışı değişmedi
    expect(globalFetch).not.toHaveBeenCalled();
    expect(inbox.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(0);
    expect(await cursorOf()).toBeNull();
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toBeUndefined();
  });

  it("demo bayrağı da kapalıyken iş reddedilir ve worker başlangıcı veritabanına yazmaz", async () => {
    expect(isInboxSyncEnabled({}, { liveInboxEnabled: CLOSED })).toBe(false);
    const factory = vi.fn(fakeGmailReader);
    await expect(
      createInboxSyncHandler({ enabled: false, gmailReader: factory, liveInboxEnabled: CLOSED })(
        ctx(),
      ),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(factory).not.toHaveBeenCalled();
    expect(
      await startInboxScheduler(db, { env: {}, now: () => NOW, liveInboxEnabled: CLOSED }),
    ).toEqual({
      enabled: false,
      demo: false,
      live: false,
    });
    expect(await inboxJobs()).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(inbox.requests).toHaveLength(0);
  });

  it("kilit geçersiz kılmaları ve okuyucu fabrikası üretimde kabul edilmez", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() =>
        createInboxSyncHandler({ enabled: false, liveInboxEnabled: () => true }),
      ).toThrow(/yalnızca testte/);
      expect(() =>
        createInboxSyncHandler({ enabled: false, gmailReader: fakeGmailReader }),
      ).toThrow(/yalnızca testte/);
      await expect(
        startInboxScheduler(db, { env: {}, liveInboxEnabled: () => true }),
      ).rejects.toThrow(/yalnızca testte/);
      expect(() => isInboxSyncEnabled({}, { liveInboxEnabled: () => true })).toThrow(
        /yalnızca testte/,
      );
    } finally {
      env.NODE_ENV = prev;
    }
    expect(await inboxJobs()).toHaveLength(0);
  });
});

describe("kilit açık (yalnızca test): okuma izni olan Gmail kutusu eşitlenir", () => {
  it("SAHTE Gmail sunucusundan yanıt işlenir, mail.inboxSync kaydedilir, demo kutu okunmaz, sonraki tur planlanır", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("k2"), threadId: "t-out1" });
    const demo = demoSpy();
    const factory = vi.fn(fakeGmailReader);
    await createInboxSyncHandler({
      enabled: false, // demo bayrağı kapalı
      reader: demo,
      gmailReader: factory,
      liveInboxEnabled: () => true,
      now: () => NOW,
    })(ctx());

    expect(factory).toHaveBeenCalledTimes(1);
    expect(demo.calls).toHaveLength(0); // demo bayrağı kapalıyken demo kutu okunmaz
    expect(inbox.requests.length).toBeGreaterThan(0);
    expect(await inboundRows()).toHaveLength(1);
    expect(await cursorOf()).not.toBeNull();
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toEqual({
      at: NOW,
      ok: true,
      code: "ok",
    });
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW + 1000)).toBe("ok");
    const next = await inboxJobs();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ status: "queued", runAt: NOW + INBOX_SYNC_INTERVAL_MS });
    expect(logs.some((l) => l.startsWith("gmail gelen kutusu: 1 işlendi"))).toBe(true);
  });

  it("hız sınırı (Retry-After): kutu bekleme süresince OKUNMAZ, süre dolunca yeniden denenir; üst sınır 6 saat", async () => {
    let t = NOW;
    const calls: number[] = [];
    let retryAfter: number | undefined = 15 * 60_000;
    const limited: InboxReader = {
      id: "gmail",
      fetch: async (mailboxId) => {
        calls.push(mailboxId);
        throw new GmailInboxError("rate_limited", retryAfter);
      },
    };
    const run = createInboxSyncHandler({
      enabled: false,
      gmailReader: () => limited,
      liveInboxEnabled: () => true,
      now: () => t,
    });
    await run(ctx());
    expect(calls).toEqual([gid]);
    expect(logs.some((l) => l.includes("15 dk ertelendi"))).toBe(true);
    t += 60_000;
    await run(ctx());
    expect(calls).toHaveLength(1); // bekleme sürüyor: istek yok
    t = NOW + 15 * 60_000;
    retryAfter = undefined; // Retry-After yoksa yine en az 5 dk
    await run(ctx());
    expect(calls).toHaveLength(2);
    t += 4 * 60_000;
    await run(ctx());
    expect(calls).toHaveLength(2);
    t += 60_000;
    retryAfter = 48 * 3_600_000; // aşırı değer 6 saate kırpılır
    await run(ctx());
    expect(calls).toHaveLength(3);
    t += MAX_INBOX_BACKOFF_MS - 1;
    await run(ctx());
    expect(calls).toHaveLength(3);
    t += 1;
    await run(ctx());
    expect(calls).toHaveLength(4);
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });

  it("okuma izni olmayan (yalnızca gönderim) Gmail kutusu okunmaz, okuyucu oluşturulmaz", async () => {
    await db.delete(settings).where(eq(settings.key, "mail.gmailGrants"));
    await db.insert(settings).values({
      key: "mail.gmailGrants",
      value: { [String(gid)]: { send: true, read: false, at: NOW } },
      updatedAt: NOW,
    });
    inbox.add({ labels: ["INBOX"], raw: reply("k3"), threadId: "t-out1" });
    const factory = vi.fn(fakeGmailReader);
    await createInboxSyncHandler({
      enabled: false,
      gmailReader: factory,
      liveInboxEnabled: () => true,
      now: () => NOW,
    })(ctx());
    expect(factory).not.toHaveBeenCalled();
    expect(inbox.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(0);
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toBeUndefined();
  });

  it("okuyucunun kendi kilidi kapalıysa (işinki açık olsa bile) ağa çıkılmaz (kanıt 'engel')", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("k4"), threadId: "t-out1" });
    await createInboxSyncHandler({
      enabled: false,
      liveInboxEnabled: () => true, // yalnızca işin kilidi; okuyucunun kilidi aşağıda kapalı
      gmailReader: (d) =>
        new GmailInboxReader({
          db: d,
          oauth: deps,
          apiBase: inbox.base,
          liveInboxEnabled: () => false,
        }),
      now: () => NOW,
    })(ctx());
    expect(globalFetch).not.toHaveBeenCalled();
    expect(inbox.requests).toHaveLength(0);
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toEqual({
      at: NOW,
      ok: false,
      code: "live_inbox_disabled",
    });
    expect(await inboundRows()).toHaveLength(0);
  });

  it("worker başlangıcı: GERÇEK kilit açık (geçersiz kılma yok), demo bayrağı olmadan da tur planlanır (tek iş, yinelenmez)", async () => {
    expect(LIVE_INBOX_READING_ENABLED).toBe(true);
    expect(isInboxSyncEnabled({})).toBe(true);
    const opts = { env: {}, now: () => NOW };
    expect(await startInboxScheduler(db, opts)).toEqual({ enabled: true, demo: false, live: true });
    await startInboxScheduler(db, opts);
    const rows = await inboxJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", runAt: NOW });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("GERÇEK kilitlerle (okuma açık, başlık güveni kapalı) iş okur; ileti yalnızca incelemeye kaydedilir, etki yok", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("k5"), threadId: "t-out1" });
    await createInboxSyncHandler({
      enabled: false,
      // Kilit geçersiz kılması YOK: yalnızca sahte sunucu adresleri verilir.
      gmailReader: (d) => new GmailInboxReader({ db: d, oauth: deps, apiBase: inbox.base }),
      now: () => NOW,
    })(ctx());
    expect(inbox.requests.length).toBeGreaterThan(0);
    const rows = await inboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "received", errorCode: "no_attestation" });
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toMatchObject({ ok: true });
  });
});
