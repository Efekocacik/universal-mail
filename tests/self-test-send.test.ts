import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import { trackTransactions, type Db } from "@/lib/db/client";
import { auditLog, mailboxes, messages, settings, templates } from "@/lib/db/schema";
import { GmailProvider, getSelfTestProvider } from "@/lib/mail/gmail/provider";
import { resetOAuthMemoryForTests, type OAuthDeps } from "@/lib/mail/gmail/oauth";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { buildEmailMessage, MessageBuildError } from "@/lib/mail/mime/message-builder";
import { ProviderUnavailableError } from "@/lib/mail/provider/provider";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import {
  prepareTestSendConfirm,
  sendTestEmail,
  TEST_SEND_DAILY_LIMIT,
  TestSendError,
} from "@/lib/mail/test-send";
import { CONFIRM_TTL_MS } from "@/lib/mail/test-send-confirm";
import { mailboxRefreshTokenName, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
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

/** Gerçek kutuda sunucudan onay belirteci alır (hazırlık); HİÇBİR ileti gitmez. */
const confirmFor = async (id: number, tId = templateId, lId = leadId) => {
  const c = await prepareTestSendConfirm(
    db,
    { mailboxId: id, templateId: tId, leadId: lId },
    { now: () => clock },
  );
  if (!c.required) throw new Error("gerçek kutu için onay belirteci beklenirdi");
  return c.confirmToken;
};

/** Onay akışının tamamı: önce sunucu belirteci, sonra belirteçle gönderim (kullanıcı onayı simüle edilir). */
const selfTest = async (id: number) =>
  sendTestEmail(
    db,
    { mailboxId: id, templateId, leadId, confirmToken: await confirmFor(id) },
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
      { mailboxId: id, templateId, leadId, confirmToken: await confirmFor(id) },
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
      { mailboxId: id, templateId, leadId, confirmToken: await confirmFor(id) },
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

describe("kendime test: sunucu tarafı onay belirteci (tek kullanımlık, kısa ömürlü, bağlı)", () => {
  /** Belirteçle (veya belirteçsiz) doğrudan gönderim; kullanıcı arayüzünü atlayan bir istemciyi temsil eder. */
  const direct = (
    id: number,
    token: string | undefined,
    over: { templateId?: number; leadId?: number } = {},
  ) =>
    sendTestEmail(
      db,
      {
        mailboxId: id,
        templateId: over.templateId ?? templateId,
        leadId: over.leadId ?? leadId,
        ...(token !== undefined ? { confirmToken: token } : {}),
      },
      { now: () => clock, provider: selfProvider(id) },
    );
  const noTraffic = () => {
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  };
  const testRows = () => db.select().from(messages).where(eq(messages.purpose, "test"));
  const confirmAudit = async (action: string) =>
    (await db.select().from(auditLog)).filter((r) => r.action === action);

  /** İkinci (farklı adresli) bağlı Gmail kutusu: başka kutuya ait belirteç denemesi için. */
  async function connectedAs(address: string) {
    const { id } = await createGmailMailbox(db, { label: "Diğer", address });
    const refresh = "1//self-test-other-refresh-zzzz";
    await setSecret(mailboxRefreshTokenName(id), refresh);
    oauth.validRefresh.add(refresh);
    await db
      .update(mailboxes)
      .set({ status: "connected", credentialsRef: mailboxRefreshTokenName(id), connectedAt: clock })
      .where(eq(mailboxes.id, id));
    const grants = await getSetting(db, "mail.gmailGrants");
    await setSetting(db, "mail.gmailGrants", {
      ...grants,
      [String(id)]: { send: true, read: false, at: clock },
    });
    return id;
  }

  it("onay hazırlığı (challenge) hiçbir ileti göndermez ve hiçbir kayıt yazmaz; alıcı kutunun kendi adresi; süre 120 sn", async () => {
    const id = await connected();
    const c = await prepareTestSendConfirm(
      db,
      { mailboxId: id, templateId, leadId },
      { now: () => clock },
    );
    expect(c).toMatchObject({
      required: true,
      scope: "live",
      recipient: ADDRESS,
      expiresAt: clock + CONFIRM_TTL_MS,
    });
    expect(CONFIRM_TTL_MS).toBe(120_000);
    noTraffic();
    expect(await testRows()).toHaveLength(0);
    expect(
      (await db.select().from(auditLog)).filter((r) => r.action.startsWith("mail.test_")),
    ).toHaveLength(0);
    expect(await getSetting(db, "mail.testSendConfirms")).toEqual({}); // hazırlık nonce tüketmez
  });

  it("belirteç yoksa veya boşsa: gerçek ileti OLUŞMAZ, sağlayıcıya ve OAuth'a hiç gidilmez", async () => {
    const id = await connected();
    await expect(direct(id, undefined)).rejects.toMatchObject({ kind: "confirm_required" });
    await expect(direct(id, "")).rejects.toMatchObject({ kind: "confirm_required" });
    noTraffic();
    expect(await testRows()).toHaveLength(0);
    expect(await confirmAudit("mail.test_confirmed")).toHaveLength(0);
    expect(await confirmAudit("mail.test_sent")).toHaveLength(0);
  });

  it("bozulmuş, uydurma veya eksik belirteç reddedilir (istek atılmaz)", async () => {
    const id = await connected();
    const good = await confirmFor(id);
    const [payload, mac] = good.split(".") as [string, string];
    const flip = (v: string) => v.slice(0, -2) + (v.slice(-2) === "AA" ? "BB" : "AA");
    const bad = [
      flip(good), // mac'in son karakterleri
      `${flip(payload)}.${mac}`, // yük değişti, imza eski
      `${mac}.${payload}`, // parçalar yer değiştirdi
      payload, // imza yok
      `${good}.x`, // fazladan parça
      "a.b",
      "x".repeat(40),
      "😀".repeat(30),
    ];
    for (const t of bad) {
      await expect(direct(id, t), t.slice(0, 12)).rejects.toMatchObject({
        kind: "confirm_invalid",
      });
    }
    noTraffic();
    expect(await testRows()).toHaveLength(0);
  });

  it("belirteç başka şablona, başka işletmeye, başka kutuya veya değişmiş adrese ait olamaz", async () => {
    const id = await connected();
    const other = await connectedAs("baska@firma-ornek.com");
    const tpls = await db.select().from(templates);
    const otherTemplate = tpls.find((x) => x.id !== templateId)!.id;

    await expect(direct(id, await confirmFor(id, otherTemplate))).rejects.toMatchObject({
      kind: "confirm_invalid",
    });
    await expect(direct(id, await confirmFor(id, templateId, leadId + 1))).rejects.toMatchObject({
      kind: "confirm_invalid",
    });
    // A kutusu için alınan belirteç B kutusunda geçmez (ve tersi).
    await expect(direct(other, await confirmFor(id))).rejects.toMatchObject({
      kind: "confirm_invalid",
    });
    // Kutunun adresi değişirse eski belirteç geçmez.
    const t = await confirmFor(id);
    await db.update(mailboxes).set({ address: "yeni@firma-ornek.com" }).where(eq(mailboxes.id, id));
    await expect(direct(id, t)).rejects.toMatchObject({ kind: "confirm_invalid" });
    noTraffic();
    expect(await testRows()).toHaveLength(0);
  });

  it("süresi dolmuş belirteç reddedilir; son geçerli anda (süre sonu) kabul edilir", async () => {
    const id = await connected();
    const t1 = await confirmFor(id);
    clock += CONFIRM_TTL_MS + 1;
    await expect(direct(id, t1)).rejects.toMatchObject({ kind: "confirm_expired" });
    noTraffic();
    expect(await testRows()).toHaveLength(0);

    const t2 = await confirmFor(id); // saat ilerledi: yeni belirteç
    clock += CONFIRM_TTL_MS; // tam süre sonu: hâlâ geçerli
    resetOAuthMemoryForTests();
    expect((await direct(id, t2)).outcome).toBe("sent");
  });

  it("TEK KULLANIMLIK: aynı belirteçle ikinci gönderim reddedilir (tekrar oynatma)", async () => {
    const id = await connected();
    const t = await confirmFor(id);
    expect((await direct(id, t)).outcome).toBe("sent");
    expect(gmail.requests).toHaveLength(1);
    await expect(direct(id, t)).rejects.toMatchObject({ kind: "confirm_invalid" });
    expect(gmail.requests).toHaveLength(1); // ikinci ileti YOK
    expect(await testRows()).toHaveLength(1);
  });

  it("EŞZAMANLI iki (ve çok sayıda) istek aynı belirteçle: yalnızca BİR ileti gider", async () => {
    // Üretimde `openDatabase` işlem kapısını uygular (eşzamanlı işlemler sırasını bekler); bellek içi test bağlantısında
    // aynı kapı açıkça uygulanır, böylece gerçek davranış sınanır.
    trackTransactions(client);
    const id = await connected();
    const t = await confirmFor(id);
    const results = await Promise.allSettled([direct(id, t), direct(id, t)]);
    const sent = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(sent).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ kind: "confirm_invalid" });
    expect(gmail.requests).toHaveLength(1);
    expect(await testRows()).toHaveLength(1);

    // Beş eşzamanlı istek, yeni belirteç: yine tek ileti (ikinci test iletisi kutunun kendi sınırı içinde).
    clock += 1000;
    resetOAuthMemoryForTests();
    const t2 = await confirmFor(id);
    const many = await Promise.allSettled([1, 2, 3, 4, 5].map(() => direct(id, t2)));
    expect(many.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(gmail.requests).toHaveLength(2);
    expect(await testRows()).toHaveLength(2);
  });

  it("kayıt işlemi hata verirse belirteç YANMAZ (ileti yoksa belirteç tüketilmez); sonra aynı belirteç çalışır", async () => {
    const id = await connected();
    const t = await confirmFor(id);
    const [busy] = await db
      .insert(messages)
      .values({
        direction: "out",
        purpose: "test",
        mailboxId: id,
        fromAddress: ADDRESS,
        toAddress: ADDRESS,
        peerHash: "x",
        peerDomain: "firma-ornek.com",
        status: "sending",
        createdAt: clock - 1000,
      })
      .returning({ id: messages.id });
    await expect(direct(id, t)).rejects.toMatchObject({ kind: "in_progress" });
    noTraffic();
    expect(await getSetting(db, "mail.testSendConfirms")).toEqual({}); // geri alındı
    expect(await confirmAudit("mail.test_confirmed")).toHaveLength(0);

    await db.delete(messages).where(eq(messages.id, busy!.id));
    expect((await direct(id, t)).outcome).toBe("sent"); // aynı belirteç hâlâ geçerli
    expect(gmail.requests).toHaveLength(1);
  });

  it("onay denetim kaydına yazılır: belirteç ve tam adres YOK, yalnızca maskeli adres ve nonce öneki", async () => {
    const id = await connected();
    const t = await confirmFor(id);
    await direct(id, t);
    const confirmed = await confirmAudit("mail.test_confirmed");
    expect(confirmed).toHaveLength(1);
    const detail = JSON.stringify(confirmed[0]!.detail);
    expect(detail).toContain("s***@firma-ornek.com");
    expect(detail).not.toContain(ADDRESS);
    expect(detail).not.toContain(t);
    expect(detail).toMatch(/"nonce":"[0-9a-f]{8}"/);
    expect(await confirmAudit("mail.test_sent")).toHaveLength(1);

    // Hiçbir yerde (ayarlar, denetim) belirteç saklanmaz; yalnızca tüketilmiş nonce ve süre sonu.
    const dump = JSON.stringify([
      await db.select().from(settings),
      await db.select().from(auditLog),
    ]);
    expect(dump).not.toContain(t);
    const used = await getSetting(db, "mail.testSendConfirms");
    expect(Object.keys(used)).toHaveLength(1);
    expect(Object.values(used)[0]).toBe(clock + CONFIRM_TTL_MS);
  });

  it("süresi dolmuş nonce kayıtları budanır (sınırsız büyüme yok)", async () => {
    const id = await connected();
    await setSetting(db, "mail.testSendConfirms", {
      ["a".repeat(32)]: clock - 3 * CONFIRM_TTL_MS, // eski: budanır
      ["b".repeat(32)]: clock + CONFIRM_TTL_MS, // geçerli: kalır
    });
    await direct(id, await confirmFor(id));
    const used = await getSetting(db, "mail.testSendConfirms");
    expect(Object.keys(used)).not.toContain("a".repeat(32));
    expect(Object.keys(used)).toContain("b".repeat(32));
    expect(Object.keys(used)).toHaveLength(2);
  });

  it("onay hazırlığı da sınırları denetler: günlük/saatlik sınır dolmuşsa belirteç VERİLMEZ", async () => {
    const id = await connected();
    for (let i = 0; i < 10; i++) {
      await db.insert(messages).values({
        direction: "out",
        purpose: "test",
        mailboxId: id,
        fromAddress: ADDRESS,
        toAddress: ADDRESS,
        peerHash: "x",
        peerDomain: "firma-ornek.com",
        status: "sent",
        createdAt: clock - 60_000,
      });
    }
    await expect(
      prepareTestSendConfirm(db, { mailboxId: id, templateId, leadId }, { now: () => clock }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("mevcut alıcı kısıtlaması KORUNUR: geçerli belirteçle bile alıcı yalnızca kutunun kendi adresidir", async () => {
    const id = await connected();
    await direct(id, await confirmFor(id));
    const raw = unfold(gmail.requests[0]!.rawDecoded!);
    expect(raw).toMatch(/^To: <?satis@firma-ornek\.com>?$/m);
    expect(raw).not.toContain("kisi@alici-ornek.com");
    // Sağlayıcı katmanı belirteçten bağımsız olarak başka alıcıyı reddeder.
    const r = await selfProvider(id).send({
      raw: "From: x\r\n\r\nx",
      from: ADDRESS,
      to: "kisi@alici-ornek.com",
      messageId: "<x@firma-ornek.com>",
      signal: AbortSignal.timeout(5000),
    });
    expect(r).toMatchObject({ status: "rejected", code: "self_test_recipient" });
  });
});

describe("kendime test + test alıcı sınırı birlikte (entegrasyon)", () => {
  const RESTRICT = "mail.recipientRestriction";
  const campaignProvider = (id: number) =>
    new GmailProvider({
      db,
      mailbox: { id, address: ADDRESS },
      oauth: deps,
      apiBase: gmail.base,
      liveEnabled: () => true,
    });
  const input = (to: string) => ({
    raw: [
      `From: Satis <${ADDRESS}>`,
      `To: ${to}`,
      "Subject: x",
      "Message-ID: <x@firma-ornek.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "x",
      "",
    ].join("\r\n"),
    from: ADDRESS,
    to,
    messageId: "<x@firma-ornek.com>",
    signal: AbortSignal.timeout(5000),
  });
  const lock = (addresses: string[]) =>
    db
      .insert(settings)
      .values({
        key: RESTRICT,
        value: { enabled: true, addresses, updatedAt: clock },
        updatedAt: clock,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { enabled: true, addresses, updatedAt: clock }, updatedAt: clock },
      });

  it("sınır AÇIKKEN kendime test yine yalnızca kutunun kendi adresine gider (sınırdan muaf), kampanya yolu ise başka hiçbir adrese gidemez", async () => {
    const id = await connected();
    await lock(["izinli@izinli-test.example"]); // kutunun kendi adresi listede DEĞİL
    // 1) Kendime test: onay belirteciyle gönderilir, alıcı yalnızca kutunun kendi adresi.
    await sendTestEmail(
      db,
      { mailboxId: id, templateId, leadId, confirmToken: await confirmFor(id) },
      { now: () => clock, provider: selfProvider(id) },
    );
    expect(gmail.requests).toHaveLength(1);
    expect(unfold(gmail.requests[0]!.rawDecoded!)).toMatch(/^To: <?satis@firma-ornek.com>?$/m);
    // 2) Kampanya yolu (aynı kutu): listede olmayan alıcıya, hatta kutunun kendi adresine bile ağ isteği YOK.
    const before = gmail.requests.length;
    for (const to of ["kisi@alici-ornek.com", ADDRESS]) {
      expect(await campaignProvider(id).send(input(to))).toEqual({
        status: "rejected",
        code: "recipient_not_allowed",
        permanent: false,
      });
    }
    expect(gmail.requests).toHaveLength(before);
    // 3) Yalnızca listedeki adres kampanya yolundan gider.
    expect((await campaignProvider(id).send(input("izinli@izinli-test.example"))).status).toBe(
      "accepted",
    );
    expect(gmail.requests).toHaveLength(before + 1);
  });

  it("sınır AÇIKKEN kendime test başka bir alıcıya gönderemez; sınır kendime test belirtecini/kurallarını gevşetmez", async () => {
    const id = await connected();
    await lock([ADDRESS, "kisi@alici-ornek.com"]);
    const r = await selfProvider(id).send(input("kisi@alici-ornek.com"));
    expect(r).toMatchObject({ status: "rejected", code: "self_test_recipient" });
    expect(gmail.requests).toHaveLength(0);
    // Belirteçsiz gönderim sınır açıkken de reddedilir.
    await expect(
      sendTestEmail(
        db,
        { mailboxId: id, templateId, leadId },
        { now: () => clock, provider: selfProvider(id) },
      ),
    ).rejects.toBeInstanceOf(TestSendError);
    expect(gmail.requests).toHaveLength(0);
  });
});
