import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { GmailProvider, getLiveProvider, parseRetryAfter } from "@/lib/mail/gmail/provider";
import { getOAuthStatus, resetOAuthMemoryForTests, type OAuthDeps } from "@/lib/mail/gmail/oauth";
import {
  getProvider,
  ProviderUnavailableError,
  type MailProvider,
  type ProviderSendInput,
} from "@/lib/mail/provider/provider";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { setSecret, mailboxRefreshTokenName, secretExists } from "@/lib/secrets/store";
import { LIVE_SENDING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes, messages, settings } from "@/lib/db/schema";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { startFakeGmail, type FakeGmail } from "./helpers/fake-gmail-server";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth-server";

/**
 * Gmail gönderim bağdaştırıcısı (Aşama 15.4). Yalnızca yerel SAHTE Gmail ve OAuth sunucuları; gerçek Google'a istek
 * yok (fetch sarmalayıcısı 127.0.0.1 dışını reddeder, genel fetch casusla izlenir). Canlı gönderim kapalı kalır.
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const TO = "kisi@alici-ornek.com";
const MID = "<abc.def123@firma-ornek.com>";

let client: Client;
let db: Db;
let dir: string;
let oauth: FakeOAuth;
let gmail: FakeGmail;
let deps: OAuthDeps;
let clock: number;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-gprov-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  clock = Date.UTC(2026, 10, 10, 10, 0, 0);
  oauth = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  gmail = await startFakeGmail();
  deps = oauth.deps(() => clock);
  globalFetch = vi.spyOn(globalThis, "fetch");
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
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

/** Kutuyu doğrudan "bağlı" yapar (OAuth akışı 15.3'te sınandı). */
async function connected(grants: { send: boolean; read: boolean } = { send: true, read: false }) {
  const { id } = await createGmailMailbox(db, { label: "Satış", address: ADDRESS });
  const refresh = "1//direct-refresh-token-zzzzzzzz";
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

const provider = (
  id: number,
  extra: Partial<ConstructorParameters<typeof GmailProvider>[0]> = {},
) =>
  new GmailProvider({
    db,
    mailbox: { id, address: ADDRESS },
    oauth: deps,
    apiBase: gmail.base,
    liveEnabled: () => true,
    ...extra,
  });

const RAW = [
  "From: Satis <satis@firma-ornek.com>",
  `To: ${TO}`,
  "Subject: Merhaba",
  `Message-ID: ${MID}`,
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Merhaba, kisa bir tanitim.",
  "",
].join("\r\n");

const input = (
  over: Partial<ProviderSendInput> = {},
  signal = new AbortController().signal,
): ProviderSendInput => ({
  raw: RAW,
  from: ADDRESS,
  to: TO,
  messageId: MID,
  signal,
  ...over,
});
const refreshCalls = () =>
  oauth.requests.filter((r) => r.path === "/token" && r.params.grant_type === "refresh_token")
    .length;

describe("kapılar: ağ isteğinden ÖNCE", () => {
  it("canlı gönderim kapısı kapalıyken (testte kapatılır) hiçbir istek atılmaz: ne Gmail'e ne OAuth'a", async () => {
    const id = await connected();
    const p = provider(id, { liveEnabled: () => false });
    expect(await p.send(input())).toEqual({
      status: "rejected",
      code: "live_sending_disabled",
      permanent: true,
    });
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("kapı açma sürümü: GERÇEK kapı açık (geçersiz kılma yok); gönderim izni yoksa yine ağa çıkılmaz", async () => {
    expect(LIVE_SENDING_ENABLED).toBe(true);
    const noSend = await connected({ send: false, read: true });
    // `liveEnabled` verilmez: üretimdeki birleşik kapı kullanılır. Yalnızca sahte sunucu adresi verilir.
    const p = new GmailProvider({
      db,
      mailbox: { id: noSend, address: ADDRESS },
      oauth: deps,
      apiBase: gmail.base,
    });
    expect(await p.send(input())).toEqual({
      status: "rejected",
      code: "scope_missing",
      permanent: true,
    });
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("fabrika: kapı açıkken yalnızca Gmail kutusu için bağdaştırıcı kurulur (ağ yok); getProvider gerçek sağlayıcıda hata verir", async () => {
    const id = await connected();
    const mb = { id, provider: "gmail", address: ADDRESS };
    expect(getLiveProvider(db, mb).id).toBe("gmail");
    expect(() => getLiveProvider(db, { ...mb, provider: "demo" })).toThrow(
      ProviderUnavailableError,
    );
    expect(() => getLiveProvider(db, { ...mb, provider: "smtp" })).toThrow(
      ProviderUnavailableError,
    );
    expect(() => getProvider({ provider: "gmail" })).toThrow(ProviderUnavailableError);
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("test geçersiz kılmaları üretimde kabul edilmez (apiBase, liveEnabled)", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(
        () =>
          new GmailProvider({ db, mailbox: { id: 1, address: ADDRESS }, liveEnabled: () => true }),
      ).toThrow(/yalnızca testte/);
      expect(
        () =>
          new GmailProvider({
            db,
            mailbox: { id: 1, address: ADDRESS },
            apiBase: "http://127.0.0.1:1",
          }),
      ).toThrow(/yalnızca testte/);
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it("gmail.send izni zorunlu: izin yoksa veya kutu bağlı değilse istek atılmaz (okuma izni yerine geçmez)", async () => {
    const noSend = await connected({ send: false, read: true });
    expect(await provider(noSend).send(input())).toEqual({
      status: "rejected",
      code: "scope_missing",
      permanent: true,
    });
    const { id } = await createGmailMailbox(db, { label: "Boş", address: "bos@firma-ornek.com" });
    expect(
      await provider(id, { mailbox: { id, address: "bos@firma-ornek.com" } }).send(
        input({ from: "bos@firma-ornek.com" }),
      ),
    ).toMatchObject({ status: "rejected", code: "not_connected" });
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("girdi doğrulaması (ağ yok): başka gönderen, çoklu/yanlış alıcı, Bcc/Cc, ASCII dışı, büyük, Message-ID uyuşmazlığı", async () => {
    const id = await connected();
    const p = provider(id);
    const bad: [string, Partial<ProviderSendInput>][] = [
      ["sender_mismatch", { from: "baska@firma-ornek.com" }],
      ["invalid_recipient", { to: "adres degil" }],
      ["invalid_message", { raw: RAW.replace(`To: ${TO}`, `To: ${TO}, ikinci@alici-ornek.com`) }],
      [
        "invalid_message",
        { raw: RAW.replace(`To: ${TO}`, `To: ${TO}\r\nBcc: gizli@alici-ornek.com`) },
      ],
      [
        "invalid_message",
        { raw: RAW.replace(`To: ${TO}`, `To: ${TO}\r\nCc: kopya@alici-ornek.com`) },
      ],
      ["invalid_message", { raw: RAW.replace("Merhaba,", "Merhaba, şğü") }],
      [
        "invalid_message",
        { raw: RAW.replace(`Message-ID: ${MID}`, "Message-ID: <baska.id@firma-ornek.com>") },
      ],
      ["invalid_message", { raw: "x".repeat(1_000_001) }],
      ["invalid_message", { raw: "" }],
      ["invalid_message", { raw: RAW.replace("\r\n\r\n", "\r\n") }],
    ];
    for (const [code, over] of bad) {
      expect(await p.send(input(over)), JSON.stringify(over).slice(0, 60)).toEqual({
        status: "rejected",
        code,
        permanent: true,
      });
    }
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("önceden iptal edilmiş sinyal: istek atılmaz", async () => {
    const id = await connected();
    const ac = new AbortController();
    ac.abort();
    expect(await provider(id).send(input({}, ac.signal))).toMatchObject({
      status: "rejected",
      code: "aborted_before_send",
      permanent: false,
    });
    expect(gmail.requests).toHaveLength(0);
  });
});

describe("başarı: mesaj ve konuşma kimlikleri", () => {
  it("doğru uç, kimlik doğrulama ve gövde; id ve threadId kaydedilecek şekilde döner", async () => {
    const id = await connected();
    const r = await provider(id).send(input());
    expect(r).toEqual({
      status: "accepted",
      providerMessageId: "msg1abc",
      threadId: "thr1abc",
      acceptedAt: clock,
    });
    expect(gmail.requests).toHaveLength(1);
    const q = gmail.requests[0]!;
    expect(q.method).toBe("POST");
    expect(q.path).toBe("/gmail/v1/users/me/messages/send");
    expect(q.authorization).toMatch(/^Bearer ya29\.fake-access-1-/);
    expect(q.contentType).toBe("application/json");
    expect(Object.keys(q.json!)).toEqual(["raw"]); // yalnızca ham ileti; fazladan alan yok
    expect(q.rawDecoded).toBe(RAW); // aynen, değiştirilmeden
  });

  it("geçersiz biçimli id/threadId veya eksik alan: 'gönderilmiş olabilir' → BELİRSİZ (kabul edilmiş sayılmaz)", async () => {
    const id = await connected();
    const p = provider(id);
    for (const body of [
      {},
      { id: "x" },
      { id: "../../etc", threadId: "t1" },
      { id: "a".repeat(200), threadId: "t" },
      "{bozuk",
      null,
    ]) {
      gmail.script.push({ status: 200, body });
      expect(await p.send(input()), JSON.stringify(body)).toEqual({
        status: "unknown",
        code: "bad_success_body",
      });
    }
  });

  it("send-service sonucu kaydeder: providerMessageId ve threadId messages tablosuna yazılır", async () => {
    const camp = await createCampaign(db, { status: "running" });
    const s = await addSequence(db, camp, { nextSendAt: null });
    const fakeProvider: MailProvider = {
      id: "gmail",
      send: async () => ({
        status: "accepted",
        providerMessageId: "msgREC1",
        threadId: "thrREC1",
        acceptedAt: T0,
      }),
    };
    const out = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0, provider: fakeProvider },
    );
    expect(out.outcome).toBe("sent");
    const [m] = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
    expect(m).toMatchObject({ status: "sent", providerMessageId: "msgREC1", threadId: "thrREC1" });
  });
});

/** Google hata zarfı üretir (code, isteğe bağlı status ve reason). */
const E = (code: number, status?: string, reason?: string) => ({
  error: {
    code,
    message: "m",
    ...(reason ? { errors: [{ message: "m", domain: "global", reason }] } : {}),
    ...(status ? { status } : {}),
  },
});

describe("sonuç sınıflandırması: kesin ret / belirsiz", () => {
  const cases: [
    string,
    number,
    unknown,
    Record<string, string>,
    { status: string; code: string; permanent?: boolean },
  ][] = [
    [
      "400 doğrulanmış (INVALID_ARGUMENT)",
      400,
      E(400, "INVALID_ARGUMENT"),
      {},
      { status: "rejected", code: "invalid_request", permanent: true },
    ],
    [
      "400 doğrulanmış (yalnızca reason)",
      400,
      { error: { code: 400, errors: [{ reason: "invalid" }] } },
      {},
      { status: "rejected", code: "invalid_request", permanent: true },
    ],
    [
      "404 doğrulanmış",
      404,
      E(404, "NOT_FOUND"),
      {},
      { status: "rejected", code: "not_found", permanent: true },
    ],
    [
      "413 doğrulanmış",
      413,
      E(413, "INVALID_ARGUMENT"),
      {},
      { status: "rejected", code: "message_too_large", permanent: true },
    ],
    [
      "403 izin yok (reason)",
      403,
      E(403, "PERMISSION_DENIED", "insufficientPermissions"),
      {},
      { status: "rejected", code: "forbidden", permanent: true },
    ],
    [
      "403 PERMISSION_DENIED",
      403,
      E(403, "PERMISSION_DENIED"),
      {},
      { status: "rejected", code: "forbidden", permanent: true },
    ],
    [
      "403 kota (kullanıcı)",
      403,
      E(403, undefined, "userRateLimitExceeded"),
      {},
      { status: "rejected", code: "rate_limited", permanent: false },
    ],
    [
      "403 RESOURCE_EXHAUSTED",
      403,
      E(403, "RESOURCE_EXHAUSTED"),
      {},
      { status: "rejected", code: "rate_limited", permanent: false },
    ],
    [
      "403 günlük kota",
      403,
      E(403, undefined, "dailyLimitExceeded"),
      {},
      { status: "rejected", code: "rate_limited_daily", permanent: false },
    ],
    ["429", 429, {}, {}, { status: "rejected", code: "rate_limited", permanent: false }],
    ["500", 500, {}, {}, { status: "unknown", code: "http_5xx" }],
    ["502", 502, "<html>", {}, { status: "unknown", code: "http_5xx" }],
    ["503", 503, { error: { status: "UNAVAILABLE" } }, {}, { status: "unknown", code: "http_5xx" }],
    ["408", 408, {}, {}, { status: "unknown", code: "http_other" }],
    ["409", 409, {}, {}, { status: "unknown", code: "http_other" }],
    [
      "302",
      302,
      {},
      { Location: "http://127.0.0.1:1/x" },
      { status: "unknown", code: "network_or_timeout" },
    ],
  ];
  it.each(cases)("%s", async (_n, status, body, headers, expected) => {
    const id = await connected();
    gmail.script.push({ status, body, headers });
    expect(await provider(id).send(input())).toMatchObject(expected);
    expect(gmail.requests).toHaveLength(1); // belirsiz veya ret: asla ikinci istek yok
  });

  const bad: [string, unknown][] = [
    ["boş gövde", undefined],
    ["HTML (ara sunucu)", "<html>x</html>"],
    ["bozuk JSON", "{bozuk"],
    ["JSON dizisi", []],
    ["error yok", {}],
    ["error dizge", { error: "INVALID_ARGUMENT" }],
    ["code yok", { error: { status: "INVALID_ARGUMENT" } }],
    ["code dize", { error: { code: "400", status: "INVALID_ARGUMENT" } }],
    ["code uyuşmuyor", { error: { code: 500, status: "INVALID_ARGUMENT" } }],
    ["status tür dışı", { error: { code: 400, status: 400 } }],
    ["status beklenmedik", { error: { code: 400, status: "UNAVAILABLE" } }],
    ["status ve reason yok", { error: { code: 400 } }],
    ["reason boş", { error: { code: 400, errors: [{ reason: "" }] } }],
    ["errors dizi değil", { error: { code: 400, errors: "x" } }],
  ];
  const bodyFor = (code: number, b: unknown) =>
    b && typeof b === "object" && !Array.isArray(b) && "error" in (b as object)
      ? JSON.parse(
          JSON.stringify(b)
            .replace(/"code":400/, `"code":${code}`)
            .replace(/"code":500/, `"code":${code === 500 ? 501 : 500}`),
        )
      : b;
  const unverifiedCases = [400, 403, 404, 413].flatMap((st) =>
    bad.map((c) => [st, c[0], bodyFor(st, c[1])] as const),
  );
  it.each(unverifiedCases)(
    "%i doğrulanamayan hata zarfı (%s): kesin ret DEĞİL → BELİRSİZ, tek istek, yenileme yok",
    async (st, _n, body) => {
      const id = await connected();
      gmail.script.push({ status: st, body });
      expect(await provider(id).send(input())).toEqual({
        status: "unknown",
        code: `error_unverified_${st}`,
      });
      expect(gmail.requests).toHaveLength(1);
      expect(oauth.requests.filter((r) => r.path === "/token")).toHaveLength(1);
    },
  );

  it("ek durum kodları (402, 405, 410, 422...) doğrulanmış zarfla bile kesin ret sayılmaz", async () => {
    const id = await connected();
    for (const st of [402, 405, 410, 422, 451]) {
      gmail.script.push({ status: st, body: E(st, "INVALID_ARGUMENT") });
      expect((await provider(id).send(input())).status).toBe("unknown");
    }
    expect(gmail.requests).toHaveLength(5);
  });

  it("belirsiz sonuç sonrası aynı ileti otomatik tekrar GÖNDERİLMEZ (400/403/404/413 bozuk yanıt, send-service)", async () => {
    const [demoMb] = await db.select().from(mailboxes).where(eq(mailboxes.id, 1));
    const gid = await connected();
    for (const [k, st] of [400, 403, 404, 413].entries()) {
      const base = T0 + k * 7 * 86_400_000; // her tür ayrı gün: kutu aralık/kota kapıları karışmaz
      const camp = await createCampaign(db, { status: "running" });
      const s = await addSequence(db, camp, { nextSendAt: null });
      const real = provider(gid, { mailbox: { id: gid, address: demoMb!.address } });
      const before = gmail.requests.length;
      gmail.script.push({ status: st, body: "<html>proxy</html>" });
      const first = await sendCampaignStep(
        db,
        { campaignLeadId: s.cl, stepIndex: 0 },
        { now: () => base, provider: real },
      );
      const again = await sendCampaignStep(
        db,
        { campaignLeadId: s.cl, stepIndex: 0 },
        { now: () => base + 60_000, provider: real },
      );
      const later = await sendCampaignStep(
        db,
        { campaignLeadId: s.cl, stepIndex: 0 },
        { now: () => base + 28 * 86_400_000, provider: real },
      );
      expect([first.outcome, again.outcome, later.outcome], String(st)).toEqual([
        "unknown",
        "ineligible",
        "ineligible",
      ]);
      expect(gmail.requests.length - before, String(st)).toBe(1);
      const rows = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
      expect(rows.filter((m) => m.status === "sent")).toHaveLength(0);
    }
  });

  it("belirsiz sonuçlar (5xx, bağlantı kopması, zaman aşımı/iptal) ASLA otomatik yeniden gönderilmez", async () => {
    const id = await connected();
    const p = provider(id);
    gmail.script.push({ status: 500 });
    expect((await p.send(input())).status).toBe("unknown");
    gmail.script.push({ status: 200, drop: true });
    expect(await p.send(input())).toEqual({ status: "unknown", code: "network_or_timeout" });
    const ac = new AbortController();
    gmail.script.push({ status: 200, delayMs: 2000 });
    const pending = p.send(input({}, ac.signal));
    setTimeout(() => ac.abort(), 150);
    expect(await pending).toEqual({ status: "unknown", code: "network_or_timeout" });
    expect(gmail.requests).toHaveLength(3); // her gönderim tam BİR istek
  });

  it("bağlantı KURULAMAZSA (ECONNREFUSED) istek gitmemiştir: kesin ret network_unreachable (belirsiz değil)", async () => {
    const id = await connected();
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const p = provider(id, { apiBase: `http://127.0.0.1:${port}` });
    expect(await p.send(input())).toEqual({
      status: "rejected",
      code: "network_unreachable",
      permanent: false,
    });
  });

  it("sonuç kodları belirteç, adres veya sunucu gövdesi içermez", async () => {
    const id = await connected();
    gmail.script.push({
      status: 403,
      body: {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "SECRET-SERVER-DETAIL kisi@alici-ornek.com",
          errors: [{ reason: "forbidden" }],
        },
      },
    });
    const r = await provider(id).send(input());
    const text = JSON.stringify(r);
    for (const leak of ["SECRET-SERVER-DETAIL", "alici-ornek", "ya29", "Bearer", CLIENT_SECRET])
      expect(text).not.toContain(leak);
  });
});

const AUTH401 = { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } };

describe("401: kontrollü belirteç yenileme (yalnızca DOĞRULANMIŞ ret sonrası)", () => {
  it("Google'ın tanınan kimlik doğrulama hatası → belirteç BİR kez yenilenir → istek BİR kez tekrarlanır → kabul", async () => {
    const id = await connected();
    gmail.script.push({ status: 401, body: AUTH401 });
    const r = await provider(id).send(input());
    expect(r).toMatchObject({ status: "accepted" });
    expect(gmail.requests).toHaveLength(2);
    expect(refreshCalls()).toBe(2); // ilk alma + zorla yenileme
    expect(gmail.requests[0]!.authorization).not.toBe(gmail.requests[1]!.authorization);
    expect(gmail.requests[1]!.rawDecoded).toBe(RAW);
  });

  it("ikinci (doğrulanmış) 401 de gelirse döngü yok: kesin ret, toplam iki istek", async () => {
    const id = await connected();
    gmail.script.push({ status: 401, body: AUTH401 }, { status: 401, body: AUTH401 });
    expect(await provider(id).send(input())).toEqual({
      status: "rejected",
      code: "unauthorized",
      permanent: false,
    });
    expect(gmail.requests).toHaveLength(2);
    expect(refreshCalls()).toBe(2);
  });

  const unverified: [string, unknown, Record<string, string>][] = [
    ["boş gövde", undefined, {}],
    ["HTML (ara sunucu)", "<html>401</html>", {}],
    ["bozuk JSON", "{bozuk", {}],
    ["durum yok", { error: { code: 401 } }, {}],
    ["yanlış durum", { error: { code: 401, status: "PERMISSION_DENIED" } }, {}],
    ["yanlış kod", { error: { code: 403, status: "UNAUTHENTICATED" } }, {}],
    ["error dizge", { error: "UNAUTHENTICATED" }, {}],
    ["kök düzeyinde", { code: 401, status: "UNAUTHENTICATED" }, {}],
    ["yalnızca WWW-Authenticate", {}, { "WWW-Authenticate": 'Bearer error="invalid_token"' }],
  ];
  it.each(unverified)(
    "doğrulanamayan 401 (%s): İKİNCİ gönderim YOK, yenileme YOK, sonuç BELİRSİZ",
    async (_n, body, headers) => {
      const id = await connected();
      gmail.script.push({ status: 401, body, headers });
      expect(await provider(id).send(input())).toEqual({
        status: "unknown",
        code: "unauthorized_unverified",
      });
      expect(gmail.requests).toHaveLength(1);
      expect(refreshCalls()).toBe(1); // yalnızca ilk belirteç alma; zorla yenileme yok
      expect(oauth.requests.filter((r) => r.path === "/token")).toHaveLength(1);
    },
  );

  it("yenilemeden sonraki tekrar isteği doğrulanamayan 401 verirse: belirsiz, üçüncü istek yok", async () => {
    const id = await connected();
    gmail.script.push({ status: 401, body: AUTH401 }, { status: 401, body: "<html>" });
    expect(await provider(id).send(input())).toEqual({
      status: "unknown",
      code: "unauthorized_unverified",
    });
    expect(gmail.requests).toHaveLength(2);
  });

  it("yenilemeden sonraki tekrar isteği 5xx/kopma verirse: belirsiz, üçüncü istek yok", async () => {
    const id = await connected();
    gmail.script.push({ status: 401, body: AUTH401 }, { status: 502 });
    expect((await provider(id).send(input())).status).toBe("unknown");
    gmail.script.push({ status: 401, body: AUTH401 }, { status: 200, drop: true });
    expect((await provider(id).send(input())).status).toBe("unknown");
    expect(gmail.requests).toHaveLength(4); // her gönderim en çok iki istek
  });

  it("send-service düzeyi: belirsiz 401 sonrası aynı adım tekrar çağrılsa da ikinci gönderim yapılmaz", async () => {
    const camp = await createCampaign(db, { status: "running" });
    const s = await addSequence(db, camp, { nextSendAt: null });
    const id = await connected();
    const [demoMb] = await db.select().from(mailboxes).where(eq(mailboxes.id, 1));
    const real = provider(id, { mailbox: { id, address: demoMb!.address } });
    gmail.script.push({ status: 401, body: "<html>" });
    const first = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0, provider: real },
    );
    const again = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0 + 1000, provider: real },
    );
    expect(gmail.requests).toHaveLength(1); // ilk çağrı tek istek; ikinci çağrı hiç istek atmaz
    expect([first.outcome, again.outcome]).toEqual(["unknown", "ineligible"]);
    const rows = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
    expect(rows.filter((m) => m.status === "sent")).toHaveLength(0);
  });

  it("yenileme invalid_grant verirse (belirleyici): kutu 'error', 'reauthorization_required', ikinci gönderim isteği yok", async () => {
    const id = await connected();
    const p = provider(id);
    // 1) Başarılı gönderim: erişim belirteci önbelleğe alınır.
    expect((await p.send(input())).status).toBe("accepted");
    expect(gmail.requests).toHaveLength(1);
    // 2) Yetki iptal edilir; Gmail eski belirteci doğrulanmış 401 ile reddeder.
    oauth.validRefresh.clear();
    gmail.script.push({ status: 401, body: AUTH401 });
    const r = await p.send(input());
    // Yenileme invalid_grant verir → gönderim ikinci kez DENENMEZ.
    expect(r).toEqual({ status: "rejected", code: "reauthorization_required", permanent: true });
    expect(gmail.requests).toHaveLength(2); // 1 başarılı + 1 reddedilen; tekrar yok
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]).toMatchObject({
      status: "error",
    });
    expect(await secretExists(mailboxRefreshTokenName(id))).toBe(false);
    expect(await getOAuthStatus(db, id)).toMatchObject({
      connected: false,
      reauthorizationRequired: true,
    });
    // 3) Sonraki gönderim ağ isteği atmadan reddedilir.
    expect(await p.send(input())).toMatchObject({ status: "rejected", permanent: true });
    expect(gmail.requests).toHaveLength(2);
  });

  it("belirteç ucu geçici hata verirse (503): istek atılmaz, geçici ret; kutu durumu korunur", async () => {
    const id = await connected();
    oauth.forceToken = { status: 503 };
    expect(await provider(id).send(input())).toEqual({
      status: "rejected",
      code: "auth_unavailable",
      permanent: false,
    });
    expect(gmail.requests).toHaveLength(0);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, id)))[0]!.status).toBe(
      "connected",
    );
  });
});

describe("429 / kota: Retry-After", () => {
  it("saniye ve HTTP tarihi biçimleri okunur; 1 sn–24 saate sıkıştırılır; geçersiz değer yok sayılır", async () => {
    const id = await connected();
    const p = provider(id);
    const run = async (headers: Record<string, string>, status = 429) => {
      gmail.script.push({
        status,
        headers,
        body: status === 403 ? E(403, "PERMISSION_DENIED") : undefined,
      });
      return (await p.send(input())) as { retryAfterMs?: number };
    };
    expect((await run({ "Retry-After": "120" })).retryAfterMs).toBe(120_000);
    expect((await run({ "Retry-After": "0" })).retryAfterMs).toBe(1_000);
    expect((await run({ "Retry-After": "999999999" })).retryAfterMs).toBe(24 * 3_600_000);
    expect(
      (await run({ "Retry-After": new Date(clock + 90_000).toUTCString() })).retryAfterMs,
    ).toBe(90_000);
    expect(
      (await run({ "Retry-After": new Date(clock - 90_000).toUTCString() })).retryAfterMs,
    ).toBe(1_000);
    expect((await run({ "Retry-After": "tomorrow" })).retryAfterMs).toBeUndefined();
    expect((await run({})).retryAfterMs).toBeUndefined();
    expect((await run({ "Retry-After": "30" }, 403)) as unknown).toMatchObject({
      code: "forbidden",
    }); // izin hatasında bekleme yok
    expect(parseRetryAfter("5", 0)).toBe(5000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it("429 yeniden denenebilir ret'tir (permanent=false) ve tek istekte biter", async () => {
    const id = await connected();
    gmail.script.push({ status: 429, headers: { "Retry-After": "60" } });
    expect(await provider(id).send(input())).toEqual({
      status: "rejected",
      code: "rate_limited",
      permanent: false,
      retryAfterMs: 60_000,
    });
    expect(gmail.requests).toHaveLength(1);
  });
});

describe("güvenlik: sızıntı ve yan etkiler", () => {
  it("belirteçler ve ham ileti hiçbir tabloya/denetim kaydına yazılmaz; bağdaştırıcı gönderim için kayıt açmaz", async () => {
    const id = await connected();
    await provider(id).send(input());
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    let dump = "";
    for (const t of tables.rows)
      dump += JSON.stringify((await client.execute(`SELECT * FROM "${String(t.name)}"`)).rows);
    for (const secret of [
      "ya29.fake-access",
      "direct-refresh-token",
      CLIENT_SECRET,
      "Merhaba, kisa bir tanitim",
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("kisi@alici-ornek.com");
    expect(await db.select().from(messages)).toHaveLength(0); // kayıt send-service'in işidir
  });

  it("canlı kapı kapalı ve ayrıca: Gmail kutusu kampanya gönderim yoluna HÂLÂ girmez (demo-only kapı)", async () => {
    const id = await connected();
    const camp = await createCampaign(db, { status: "running" });
    await db
      .update((await import("@/lib/db/schema")).campaigns)
      .set({ mailboxId: id })
      .where(eq((await import("@/lib/db/schema")).campaigns.id, camp));
    const s = await addSequence(db, camp, { nextSendAt: null });
    const out = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { now: () => T0 },
    );
    expect(out.outcome === "not_sendable" || out.outcome === "ineligible").toBe(true);
    expect(gmail.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });
});
