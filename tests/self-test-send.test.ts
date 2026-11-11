import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes, messages, settings, templates } from "@/lib/db/schema";
import { GmailProvider, getSelfTestProvider } from "@/lib/mail/gmail/provider";
import { resetOAuthMemoryForTests, type OAuthDeps } from "@/lib/mail/gmail/oauth";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { buildEmailMessage, MessageBuildError } from "@/lib/mail/mime/message-builder";
import { ProviderUnavailableError } from "@/lib/mail/provider/provider";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import { sendTestEmail, TEST_SEND_DAILY_LIMIT, TestSendError } from "@/lib/mail/test-send";
import { mailboxRefreshTokenName, setSecret } from "@/lib/secrets/store";
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
import { verifyToken } from "@/lib/unsubscribe/token";
import { addSequence, createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { startFakeGmail, type FakeGmail } from "./helpers/fake-gmail-server";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth-server";
import { decodeEncodedWords } from "./helpers/mime-parse";

/**
 * GERÇEK kutuyla "kendime test gönder" (C11). HİÇBİR kilit veya onay mock'lanmaz. Kendine test `LIVE_SENDING_ENABLED`
 * ve `LEGAL_APPROVALS`'tan BAĞIMSIZDIR (kapı açma sürümünde bu sabitler açıktır; kendine test onlara bakmaz): gerçek
 * Gmail bağdaştırıcısı (yerel SAHTE Gmail/OAuth sunucusuna) ve gerçek MIME/alt bilgi kod yoluyla ileti YALNIZCA kutunun
 * kendi adresine gider. Gerçek Google'a istek yok.
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const BASE = "https://cikis.firma-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let oauth: FakeOAuth;
let gmail: FakeGmail;
let deps: OAuthDeps;
let clock: number;
let globalFetch: ReturnType<typeof vi.spyOn>;
let leadId: number;
let templateId: number;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-selftest-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ef".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  clock = Date.UTC(2026, 10, 10, 10, 0, 0);
  oauth = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  gmail = await startFakeGmail();
  deps = oauth.deps(() => clock);
  globalFetch = vi.spyOn(globalThis, "fetch");
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const campaign = await createCampaign(db, { status: "paused" });
  ({ leadId } = await addSequence(db, campaign, { email: "kisi@alici-ornek.com" }));
  const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
  templateId = tpl!.id;
});
afterEach(async () => {
  expect(
    globalFetch.mock.calls.filter((c: unknown[]) => !String(c[0]).startsWith("http://127.0.0.1:"))
      .length,
  ).toBe(0);
  globalFetch.mockRestore();
  resetOAuthMemoryForTests();
  await oauth.close();
  await gmail.close();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Kutuyu doğrudan "bağlı" yapar (OAuth akışı ayrı sınanır). */
async function connected(grants: { send: boolean; read: boolean } = { send: true, read: false }) {
  const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
  const refresh = "1//self-test-refresh-token-zzzz";
  await setSecret(mailboxRefreshTokenName(id), refresh);
  oauth.validRefresh.add(refresh);
  await db
    .update(mailboxes)
    .set({ status: "connected", credentialsRef: mailboxRefreshTokenName(id), connectedAt: clock })
    .where(eq(mailboxes.id, id));
  await db.insert(settings).values({
    key: "mail.gmailGrants",
    value: { [String(id)]: { ...grants, at: clock } },
    updatedAt: clock,
  });
  return id;
}

/** Gerçek bağdaştırıcı; yalnızca taban adresi ve OAuth bağımlılıkları yerel sahte sunuculara yönlenir. */
const selfProvider = (id: number) =>
  new GmailProvider({
    db,
    mailbox: { id, address: ADDRESS },
    oauth: deps,
    apiBase: gmail.base,
    selfTest: true,
  });

const selfTest = (id: number) =>
  sendTestEmail(
    db,
    { mailboxId: id, templateId, leadId },
    { now: () => clock, provider: selfProvider(id) },
  );

const unfold = (raw: string) => raw.replace(/\r\n[ \t]/g, "");
const subjectOf = (raw: string) => decodeEncodedWords(/^Subject: (.*)$/m.exec(raw)?.[1] ?? "");

async function verifiedEndpoint() {
  const spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => clock });
  const relay = createRelayHandler({
    keys: () => loadPublicKeys(db),
    sink: spool,
    now: () => clock,
  });
  const pull = createSpoolPullHandler({
    spool,
    keys: () => exportChannelPublicKeys(db),
    now: () => clock,
  });
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url as string, init);
    return new URL(req.url).pathname.startsWith("/u/") ? relay(req) : pull(req);
  }) as typeof fetch;
  await ensureSigningKey(db, clock);
  await ensureChannelKey(db, clock);
  await setUnsubscribeBaseUrl(db, BASE, clock);
  const signer = (await getChannelSigner(db))!;
  const source = new HttpEventSource({
    baseUrl: BASE,
    kid: signer.kid,
    privateKey: signer.privateKey,
    now: () => clock,
    fetch: net,
  });
  const r = await verifyOneClickEndpoint(db, {
    source,
    fetch: net,
    now: () => clock,
    sleep: async () => undefined,
    attempts: 2,
  });
  expect(r.ok).toBe(true);
}

describe("kendime test gönder: gerçek Gmail kutusu (kapılardan bağımsız; kapı açma sürümü)", () => {
  it("bu sürümde kapılar açık (bu dosyada hiçbir şey mock'lanmaz); kendine test yine yalnızca kendi adrese gider", () => {
    expect(LIVE_SENDING_ENABLED).toBe(true);
    expect(isLiveSendingPermitted()).toBe(true);
    expect(Object.values(LEGAL_APPROVALS).every((v) => v)).toBe(true);
  });

  it("uç nokta yokken: gerçek ileti YALNIZCA kutunun kendi adresine; [TEST] önekli; List-Unsubscribe YOK", async () => {
    const id = await connected();
    const r = await selfTest(id);
    expect(r).toMatchObject({ outcome: "sent", scope: "live", listUnsubscribe: false });
    expect(gmail.requests).toHaveLength(1);
    const raw = unfold(gmail.requests[0]!.rawDecoded!);
    expect(raw).toMatch(/^To: <?satis@firma-ornek\.com>?$/m);
    expect(raw).toMatch(/^From: .*<satis@firma-ornek\.com>$/m);
    expect(subjectOf(raw)).toMatch(/^\[TEST\] /);
    expect(raw).not.toMatch(/^List-Unsubscribe/im);
    expect(raw).not.toContain("kisi@alici-ornek.com"); // işletme yalnızca değişkenler için
    expect(raw).toContain("unsubscribe.invalid"); // alt bilgi: örnek bağlantı, açıkça test

    const [row] = await db.select().from(messages).where(eq(messages.purpose, "test"));
    expect(row).toMatchObject({
      status: "sent",
      toAddress: ADDRESS,
      fromAddress: ADDRESS,
      campaignId: null,
      campaignLeadId: null,
      sendDay: null,
      providerMessageId: expect.any(String),
    });
    expect(row!.subjectLogged).toMatch(/^\[TEST\] /);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "mail.test_sent"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({
      status: "sent",
      scope: "live",
      to: "s***@firma-ornek.com",
      listUnsubscribe: false,
    });
    expect(JSON.stringify(audits)).not.toContain(ADDRESS);
  });

  it("uç nokta doğrulanmışsa gerçek HTTPS tek tıklamalı başlıklar eklenir; belirteç alıcıya bağlı olmayan SINAMA belirtecidir", async () => {
    await verifiedEndpoint();
    const id = await connected();
    const r = await selfTest(id);
    expect(r).toMatchObject({ outcome: "sent", listUnsubscribe: true });
    const raw = unfold(gmail.requests[0]!.rawDecoded!);
    const m = /^List-Unsubscribe: <(https:\/\/cikis\.firma-ornek\.com\/u\/([^>]+))>/m.exec(raw);
    expect(m, raw.slice(0, 800)).not.toBeNull();
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    expect(raw).not.toContain("unsubscribe.invalid");
    const v = verifyToken(m![2]!, await loadPublicKeys(db), clock + 1000);
    expect(v.ok && v.claims).toMatchObject({ s: "p" });
    expect(subjectOf(raw)).toMatch(/^\[TEST\] /);
  });

  it("gönderim izni yoksa, kutu bağlı değilse, profil eksikse veya Gmail değilse: istek atılmaz", async () => {
    const id = await connected({ send: false, read: true });
    await expect(selfTest(id)).rejects.toMatchObject({ kind: "send_scope_missing" });
    await setSetting(db, "mail.gmailGrants", {
      [String(id)]: { send: true, read: false, at: clock },
    });
    await db.delete(settings).where(eq(settings.key, "company.profile"));
    await expect(selfTest(id)).rejects.toMatchObject({ kind: "profile_incomplete" });
    await db.update(mailboxes).set({ status: "error" }).where(eq(mailboxes.id, id));
    await expect(selfTest(id)).rejects.toMatchObject({ kind: "mailbox_not_ready" });
    const [smtp] = await db
      .insert(mailboxes)
      .values({
        provider: "smtp",
        label: "SMTP",
        address: "smtp@firma-ornek.com",
        credentialsRef: "x",
        status: "connected",
        createdAt: clock,
        updatedAt: clock,
      })
      .returning({ id: mailboxes.id });
    await expect(
      sendTestEmail(db, { mailboxId: smtp!.id, templateId, leadId }, { now: () => clock }),
    ).rejects.toMatchObject({ kind: "live_scope" });
    expect(gmail.requests).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.purpose, "test"))).toHaveLength(0);
  });

  it(`günlük sınır: son 24 saatte ${TEST_SEND_DAILY_LIMIT} test; sonra rate_limited (istek yok)`, async () => {
    const id = await connected();
    for (let i = 0; i < TEST_SEND_DAILY_LIMIT; i++) {
      expect((await selfTest(id)).outcome).toBe("sent");
      clock += 2 * 3_600_000 - 1; // saatlik sınıra takılmadan, 24 saat içinde
      resetOAuthMemoryForTests();
    }
    clock -= 2 * 3_600_000 - 1;
    clock += 3_600_000 + 1;
    await expect(selfTest(id)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(gmail.requests).toHaveLength(TEST_SEND_DAILY_LIMIT);
  });

  it("aynı kutuda süren (sending) test varken yenisi başlatılmaz", async () => {
    const id = await connected();
    await db.insert(messages).values({
      direction: "out",
      purpose: "test",
      mailboxId: id,
      fromAddress: ADDRESS,
      toAddress: ADDRESS,
      peerHash: "x",
      peerDomain: "firma-ornek.com",
      status: "sending",
      createdAt: clock - 1000,
    });
    await expect(selfTest(id)).rejects.toBeInstanceOf(TestSendError);
    await expect(selfTest(id)).rejects.toMatchObject({ kind: "in_progress" });
    expect(gmail.requests).toHaveLength(0);
  });

  it("belirsiz sonuç (5xx): unknown kaydedilir, YENİDEN GÖNDERİLMEZ ve inceleme kuyruğunda görünür", async () => {
    const id = await connected();
    gmail.script.push({ status: 503, body: { error: { code: 503 } } });
    const r = await selfTest(id);
    expect(r).toMatchObject({ outcome: "unknown", scope: "live" });
    expect(gmail.requests).toHaveLength(1);
    const review = await listSendsNeedingReview(db, { now: clock });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ status: "unknown", recipientMasked: "s***@firma-ornek.com" });
  });
});

describe("kendine test: sonuç kaydı veritabanı meşgulken", () => {
  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  /** Gerçek bağdaştırıcıyla gönderir; gönderim bittikten sonra ilk `fails` kayıt işlemini meşgul hatasıyla düşürür. */
  const busyAfterSend = (id: number, fails: number) => {
    const real = selfProvider(id);
    return {
      id: real.id,
      send: async (input: Parameters<typeof real.send>[0]) => {
        const res = await real.send(input);
        const orig = db.transaction.bind(db);
        let left = fails;
        vi.spyOn(db, "transaction").mockImplementation(((fn: never) => {
          if (left-- > 0) return Promise.reject(busy());
          return orig(fn);
        }) as typeof db.transaction);
        return res;
      },
    };
  };
  afterEach(() => vi.restoreAllMocks());

  it("geçici meşguliyet: kayıt yeniden denenir; durum ve denetim kaydı birlikte yazılır", async () => {
    const id = await connected();
    const r = await sendTestEmail(
      db,
      { mailboxId: id, templateId, leadId },
      { now: () => clock, provider: busyAfterSend(id, 2) },
    );
    expect(r).toMatchObject({ outcome: "sent" });
    expect(r).not.toHaveProperty("recordError");
    const [row] = await db.select().from(messages).where(eq(messages.purpose, "test"));
    expect(row!.status).toBe("sent");
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "mail.test_sent")),
    ).toHaveLength(1);
  });

  it("kalıcı meşguliyet: hata FIRLATILMAZ; sağlayıcı sonucu (sent) recordError ile döner, ikinci istek atılmaz", async () => {
    const id = await connected();
    const r = await sendTestEmail(
      db,
      { mailboxId: id, templateId, leadId },
      { now: () => clock, provider: busyAfterSend(id, 1000) },
    );
    vi.restoreAllMocks();
    expect(r).toMatchObject({ outcome: "sent", recordError: true });
    expect(gmail.requests).toHaveLength(1);
    const [row] = await db.select().from(messages).where(eq(messages.purpose, "test"));
    expect(row!.status).toBe("sending"); // uzlaştırma `unknown` yapar; yeniden gönderim yok
  });
});

describe("kendine test: başka alıcı MÜMKÜN DEĞİL (savunma katmanları)", () => {
  it("bağdaştırıcı: kendi adresi dışındaki alıcı ağ isteği olmadan reddedilir (canlı kilit açık olsa bile)", async () => {
    const id = await connected();
    const p = new GmailProvider({
      db,
      mailbox: { id, address: ADDRESS },
      oauth: deps,
      apiBase: gmail.base,
      liveEnabled: () => true,
      selfTest: true,
    });
    const raw = [
      `From: <${ADDRESS}>`,
      "To: <kisi@alici-ornek.com>",
      "Subject: x",
      "Message-ID: <a.b@firma-ornek.com>",
      "",
      "x",
    ].join("\r\n");
    const r = await p.send({
      raw,
      from: ADDRESS,
      to: "kisi@alici-ornek.com",
      messageId: "<a.b@firma-ornek.com>",
      signal: AbortSignal.timeout(5000),
    });
    expect(r).toMatchObject({ status: "rejected", code: "self_test_recipient", permanent: true });
    expect(gmail.requests).toHaveLength(0);
  });

  it("fabrika yalnızca Gmail kutusu için kurar; kendine-test bağdaştırıcısı kendi adresi dışında hiçbir şey göndermez", async () => {
    expect(() =>
      getSelfTestProvider(db, { id: 1, provider: "demo", address: "a@b.example" }),
    ).toThrow(ProviderUnavailableError);
    const id = await connected();
    const p = getSelfTestProvider(db, { id, provider: "gmail", address: ADDRESS });
    expect(p).toBeInstanceOf(GmailProvider);
    const r = await p.send({
      raw: "x",
      from: ADDRESS,
      to: "baska@alici-ornek.com",
      messageId: "<a.b@firma-ornek.com>",
      signal: AbortSignal.timeout(5000),
    });
    expect(r).toMatchObject({ status: "rejected", code: "self_test_recipient" });
  });

  it("ileti oluşturucu: kendine testte alıcı kutunun adresiyle birebir aynı olmalı", () => {
    const base = {
      composed: {
        sendable: true,
        errors: [],
        subject: "[TEST] x",
        html: "<p>x</p>",
        text: "x",
        language: "en",
      },
      mailbox: { provider: "gmail", address: ADDRESS, status: "connected" },
      profile: { contactName: "Ayşe", legalName: "Örnek A.Ş." },
      mode: "live" as const,
      now: clock,
      selfTest: true,
    };
    expect(() => buildEmailMessage({ ...base, recipient: "kisi@alici-ornek.com" })).toThrow(
      MessageBuildError,
    );
    const ok = buildEmailMessage({ ...base, recipient: ADDRESS });
    expect(ok.to).toBe(ADDRESS);
    expect(ok.raw).not.toMatch(/^List-Unsubscribe/im);
    // Kendine test bayrağı olmadan (kampanya yolu) kapı açıkken de alt bilgiyle aynı çıkış bağlantısı zorunludur.
    expect(() => buildEmailMessage({ ...base, selfTest: false, recipient: ADDRESS })).toThrow(
      expect.objectContaining({ kind: "unsubscribe_mismatch" }),
    );
  });
});
