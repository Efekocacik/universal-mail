import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_HEADER_TRUST_VERIFIED, LIVE_INBOX_READING_ENABLED } from "@/lib/compliance/policies";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  mailboxes,
  messages,
  settings,
  suppressions,
} from "@/lib/db/schema";
import { extractGmailAttestation } from "@/lib/mail/gmail/attestation";
import {
  decodeCursor,
  encodeCursor,
  GmailInboxError,
  GmailInboxReader,
} from "@/lib/mail/gmail/inbox";
import { resetOAuthMemoryForTests, type OAuthDeps } from "@/lib/mail/gmail/oauth";
import { FakeInbox } from "@/lib/mail/inbound/fake-inbox";
import { syncInbox } from "@/lib/mail/inbound/sync";
import { createGmailMailbox, setGmailClient } from "@/lib/mail/mailbox-service";
import { mailboxRefreshTokenName, setSecret } from "@/lib/secrets/store";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { gmailWrap, startFakeGmailInbox, type FakeGmailInbox } from "./helpers/fake-gmail-inbox";
import { NOW, rawArf, rawDsn, rawMessage, seedSent, type Sent } from "./helpers/inbound-fixture";
import { setTrustedReporters } from "@/lib/mail/inbound/arf";
import { startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth-server";

/**
 * Gmail gelen kutusu okuyucusu (Aşama 15.5). Yalnızca yerel SAHTE Gmail ve OAuth sunucuları; gerçek Google'a istek
 * yok (genel fetch casusla izlenir). Gerçek gönderim ve demo bayrakları kapalıdır.
 */

const CLIENT_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-fake-client-secret-1234567890";
const ADDRESS = "satis@firma-ornek.com";
const RCPT = "kisi@alici-ornek.com";
const RCPT_DOMAIN = "alici-ornek.com";

let client: Client;
let db: Db;
let dir: string;
let oauth: FakeOAuth;
let inbox: FakeGmailInbox;
let deps: OAuthDeps;
let reader: GmailInboxReader;
let gid: number;
let sent: Sent;
let campaign: number;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-ginbox-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  resetOAuthMemoryForTests();
  oauth = await startFakeOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  inbox = await startFakeGmailInbox(ADDRESS);
  deps = oauth.deps(() => NOW);
  globalFetch = vi.spyOn(globalThis, "fetch");
  await setGmailClient(db, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  gid = await connected();
  campaign = await createCampaign(db, { status: "running" });
  sent = await seedSent(db, campaign, { mailboxId: gid, email: RCPT });
  await db.update(messages).set({ threadId: "t-out1" }).where(eq(messages.id, sent.outboundId));
  reader = newReader();
});
afterEach(async () => {
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

const newReader = (extra: Partial<ConstructorParameters<typeof GmailInboxReader>[0]> = {}) =>
  new GmailInboxReader({
    db,
    oauth: deps,
    apiBase: inbox.base,
    liveInboxEnabled: () => true,
    headerTrustVerified: () => true,
    ...extra,
  });
const sync = (opts: { maxMessages?: number; maxEffects?: number; r?: GmailInboxReader } = {}) =>
  syncInbox(db, opts.r ?? reader, gid, {
    now: () => NOW,
    liveInboxEnabled: () => true,
    ...(opts.maxMessages ? { maxMessages: opts.maxMessages } : {}),
    ...(opts.maxEffects ? { maxEffects: opts.maxEffects } : {}),
  });
const cursorOf = async () =>
  (await db.select().from(mailboxes).where(eq(mailboxes.id, gid)))[0]!.syncCursor;
const inboundRows = () =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.direction, "in"), eq(messages.mailboxId, gid)));
const clStatus = async () =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, sent.cl)))[0]!.status;
const suppressedCount = async () => (await db.select().from(suppressions)).length;

/** Ayrıntı: tüm eşitleme turlarını boşalana kadar çalıştırır. */
async function drain(maxMessages?: number) {
  const tot = {
    fetched: 0,
    processed: 0,
    duplicates: 0,
    skipped: 0,
    calls: 0,
    errors: [] as string[],
  };
  for (let i = 0; i < 25; i++) {
    const r = await sync({ maxMessages });
    tot.calls++;
    tot.fetched += r.fetched;
    tot.processed += r.processed;
    tot.duplicates += r.duplicates;
    tot.skipped += r.skipped;
    if (r.error) {
      tot.errors.push(r.error);
      break;
    }
    if (i > 1 && r.fetched === 0) break;
  }
  return tot;
}

/** Güven kilidi AÇIK varsayımıyla çıkarım mantığını sınar (varsayılan üretim davranışı: her zaman null). */
const trusted = (raw: string, addr: string | null) =>
  extractGmailAttestation(raw, addr, { trustVerified: true });

const reply = (nonce: string, body = "Thanks, we would like to see your catalogue.", from = RCPT) =>
  gmailWrap(rawMessage({ from, to: ADDRESS, inReplyTo: sent.rfc, nonce, body }), {
    mailbox: ADDRESS,
    headerFrom: from.split("@")[1]!,
  });
const dsn = (nonce: string, o: { returnPath?: string } = {}) =>
  gmailWrap(
    rawDsn({
      outboundMessageId: sent.rfc,
      recipient: RCPT,
      nonce,
      from: "MAILER-DAEMON <mailer-daemon@googlemail.com>",
    }),
    { mailbox: ADDRESS, headerFrom: "googlemail.com", returnPath: o.returnPath ?? "<>" },
  );

/* ---------------------------------------------------------------------------------------------- */

describe("kapılar: ağ isteğinden ÖNCE", () => {
  it("gelen kutusu okuma kilidi kapalıyken (testte kapatılır) hiçbir istek atılmaz", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("a1") });
    const closed = new GmailInboxReader({
      db,
      oauth: deps,
      apiBase: inbox.base,
      liveInboxEnabled: () => false,
    });
    await expect(closed.fetch(gid, null, 10)).rejects.toMatchObject({
      code: "live_inbox_disabled",
    });
    // eşitleme turu da kilide bağlıdır: okuyucu açık olsa bile syncInbox kilidi kapalıysa çalışmaz
    const r = await syncInbox(db, reader, gid, { now: () => NOW, liveInboxEnabled: () => false });
    expect(r).toMatchObject({ fetched: 0, processed: 0, error: null });
    expect(inbox.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(0);
    expect(await cursorOf()).toBeNull();
  });

  it("kapı açma sürümü: GERÇEK okuma kilidi açık, başlık güveni KAPALI → okur ama yalnızca incelemeye kaydeder; etki yok", async () => {
    expect(LIVE_INBOX_READING_ENABLED).toBe(true);
    expect(GMAIL_HEADER_TRUST_VERIFIED).toBe(false);
    // Okuma kilidi ve güven kilidi için geçersiz kılma YOK; yalnızca sahte sunucunun adresi verilir.
    const real = new GmailInboxReader({ db, oauth: deps, apiBase: inbox.base });
    inbox.add({
      id: "rl-a",
      threadId: "t-out1",
      labels: ["INBOX"],
      raw: reply("rl1", "Please unsubscribe me."),
    });
    inbox.add({ id: "rl-b", threadId: "t-out1", labels: ["INBOX"], raw: dsn("rl2") });
    for (let i = 0; i < 4; i++)
      expect((await syncInbox(db, real, gid, { now: () => NOW })).error).toBeNull();
    expect(inbox.requests.length).toBeGreaterThan(0);
    const rows = await inboundRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe("received");
      expect(r.errorCode).toBe("no_attestation");
      expect(r.campaignLeadId).toBeNull();
    }
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
  });

  it("test geçersiz kılmaları üretimde kabul edilmez", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() => new GmailInboxReader({ db, liveInboxEnabled: () => true })).toThrow(
        /yalnızca testte/,
      );
      expect(() => new GmailInboxReader({ db, apiBase: "http://127.0.0.1:1" })).toThrow(
        /yalnızca testte/,
      );
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it("gmail.readonly zorunlu: yalnızca gönderim izni okuma yerine geçmez", async () => {
    await db.delete(settings).where(eq(settings.key, "mail.gmailGrants"));
    await db.insert(settings).values({
      key: "mail.gmailGrants",
      value: { [String(gid)]: { send: true, read: false, at: NOW } },
      updatedAt: NOW,
    });
    const r = await sync();
    expect(r).toMatchObject({ fetched: 0, error: "scope_missing" });
    expect(inbox.requests).toHaveLength(0);
    expect(oauth.requests).toHaveLength(0);
  });

  it("bağlı olmayan/pasif kutu ve tür uyuşmazlığı: istek yok", async () => {
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, gid));
    expect(await sync()).toMatchObject({ fetched: 0 });
    await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, gid));
    // demo okuyucu gmail kutusunu eşitleyemez
    expect(await sync({ r: new FakeInbox() as unknown as GmailInboxReader })).toMatchObject({
      fetched: 0,
    });
    expect(inbox.requests).toHaveLength(0);
  });

  it("profil adresi kutunun adresiyle uyuşmazsa: hata, imleç yok, ileti işlenmez", async () => {
    inbox.profileAddress = "baska@firma-ornek.com";
    inbox.add({ labels: ["INBOX"], raw: reply("a2") });
    expect(await sync()).toMatchObject({ error: "account_mismatch", fetched: 0 });
    expect(await cursorOf()).toBeNull();
    expect(await inboundRows()).toHaveLength(0);
    expect(inbox.requests.map((r) => r.path)).toEqual(["/gmail/v1/users/me/profile"]);
  });

  it("yalnızca okuma uçları çağrılır (GET); hiçbir değiştirme isteği yok", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("a3") });
    await drain();
    expect(new Set(inbox.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    for (const r of inbox.requests)
      expect(r.path).toMatch(/\/(profile|messages|messages\/[^/]+|history)$/);
    expect(inbox.requests.every((r) => r.authorization?.startsWith("Bearer ya29."))).toBe(true);
  });
});

describe("başarı: yanıt, bounce ve ayrılma — mevcut L1–L4 kuralları korunur", () => {
  it("doğrulanmış yanıt: eşleşir, dizi 'replied' olur, Gmail id ve threadId saklanır", async () => {
    inbox.add({ id: "mrep1", threadId: "t-out1", labels: ["INBOX"], raw: reply("r1") });
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(await clStatus()).toBe("replied");
    const [row] = await inboundRows();
    expect(row).toMatchObject({
      status: "matched",
      classification: "reply",
      providerMessageId: "mrep1",
      threadId: "t-out1",
      campaignLeadId: sent.cl,
    });
  });

  it("doğrulanmış kesin bounce (DSN, Return-Path <>, DMARC pass): suppression ve dizi 'bounced'", async () => {
    inbox.add({ labels: ["INBOX"], raw: dsn("d1") });
    await drain();
    expect(await clStatus()).toBe("bounced");
    expect(await suppressedCount()).toBe(1);
    const [row] = await inboundRows();
    expect(row).toMatchObject({ status: "matched", classification: "bounce" });
  });

  it("doğrulanmış ayrılma isteği: suppression ve dizi 'unsubscribed'", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("u1", "Please unsubscribe me from your list.") });
    await drain();
    expect(await clStatus()).toBe("unsubscribed");
    expect(await suppressedCount()).toBe(1);
  });

  it("saklanan satırda ileti gövdesi ve gönderen adresi YOK; denetim kaydında adres YOK", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("p1", "Gizli gövde metni catalogue") });
    await drain();
    let dump = "";
    for (const t of (
      await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
    ).rows) {
      const name = String(t.name);
      if (name === "messages") {
        dump += JSON.stringify(
          (await client.execute("SELECT * FROM messages WHERE direction='in'")).rows,
        );
      } else dump += JSON.stringify((await client.execute(`SELECT * FROM "${name}"`)).rows);
    }
    expect(dump).not.toContain("Gizli gövde");
    expect(dump).not.toContain("ya29.fake-access");
    expect(dump).not.toContain("direct-refresh-token");
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(RCPT);
    const [row] = await inboundRows();
    expect(row!.peerHash).toBe(hashEmail(RCPT));
  });
});

describe("doğrulanmamış içerik ASLA etki üretmez (suppression / durdurma)", () => {
  const cases: [string, () => string][] = [
    [
      "DMARC fail",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f1",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: RCPT_DOMAIN,
            dmarc: "fail",
          },
        ),
    ],
    [
      "Gmail tasdiki yok",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f2",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: RCPT_DOMAIN,
            dmarc: "missing",
          },
        ),
    ],
    [
      "header.from başka alan adı",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f3",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: "baska-alan.com",
          },
        ),
    ],
    [
      "authserv-id güvenilmez",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f4",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: RCPT_DOMAIN,
            authserv: "mx.saldirgan.example",
          },
        ),
    ],
    [
      "Delivered-To başka kutu",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f5",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: RCPT_DOMAIN,
            deliveredTo: "baska@firma-ornek.com",
          },
        ),
    ],
    [
      "gönderen alıcı değil (L2)",
      () =>
        gmailWrap(
          rawMessage({
            from: "baskasi@alici-ornek.com",
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f6",
            body: "Please unsubscribe me.",
          }),
          { mailbox: ADDRESS, headerFrom: RCPT_DOMAIN },
        ),
    ],
    [
      "Gmail DMARC fail + gönderenin sahte 'pass' başlığı (üstteki geçerli)",
      () =>
        gmailWrap(
          rawMessage({
            from: RCPT,
            to: ADDRESS,
            inReplyTo: sent.rfc,
            nonce: "f7",
            body: "Please unsubscribe me.",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: RCPT_DOMAIN,
            dmarc: "fail",
            forgedFirst: [
              `Authentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}`,
              "Return-Path: <>",
            ],
          },
        ),
    ],
    [
      "sahte bounce: Gmail Return-Path boş değil, gönderen sahte '<>' ekledi",
      () =>
        gmailWrap(
          rawDsn({
            outboundMessageId: sent.rfc,
            recipient: RCPT,
            nonce: "f8",
            from: "MAILER-DAEMON <mailer-daemon@googlemail.com>",
          }),
          {
            mailbox: ADDRESS,
            headerFrom: "googlemail.com",
            returnPath: "<saldirgan@example.invalid>",
            forgedFirst: ["Return-Path: <>"],
          },
        ),
    ],
  ];
  it.each(cases)("%s → kayıt var, etki YOK", async (_n, make) => {
    inbox.add({ labels: ["INBOX"], raw: make() });
    await drain();
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next"); // dizi durdurulmadı
    const rows = await inboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaignLeadId).toBeNull(); // doğrulanmamış satıra bağlantı yazılmaz
    expect(rows[0]!.status === "received" || rows[0]!.status === "unmatched").toBe(true);
  });

  it("olumsuz ifade doğrulanmış olsa bile otomatik suppression üretmez", async () => {
    inbox.add({ labels: ["INBOX"], raw: reply("n1", "Thank you, but we are not interested.") });
    await drain();
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
    expect((await inboundRows())[0]!.status).toBe("received");
  });

  it("yüksek hacim: etki sınırı aşılınca iletiler kayda alınır, etki üretilmez (sel koruması)", async () => {
    // 3 doğrulanmış ayrılma isteği (3 farklı alıcı) ama yalnızca 1 etki hakkı
    for (const n of [1, 2, 3]) {
      const s = await seedSent(db, campaign, { mailboxId: gid, email: `kisi${n}@ornek${n}.com` });
      await db
        .update(messages)
        .set({ threadId: `t-fl${n}` })
        .where(eq(messages.id, s.outboundId));
      inbox.add({
        labels: ["INBOX"],
        raw: gmailWrap(
          rawMessage({
            from: s.email,
            to: ADDRESS,
            inReplyTo: s.rfc,
            nonce: `fl${n}`,
            body: "Please unsubscribe me.",
          }),
          { mailbox: ADDRESS, headerFrom: `ornek${n}.com` },
        ),
      });
    }
    const r = await sync({ maxEffects: 1 });
    expect(r).toMatchObject({ processed: 3, effects: 1, floodGuard: true });
    expect(await suppressedCount()).toBe(1);
  });
});

describe("tasdik çıkarımı (extractGmailAttestation)", () => {
  const base = (o: Parameters<typeof gmailWrap>[1]) =>
    gmailWrap(rawMessage({ from: RCPT, to: ADDRESS, nonce: "x" }), o);
  const ok = { mailbox: ADDRESS, headerFrom: RCPT_DOMAIN };

  it("geçerli: source 'provider', pass; Return-Path <> yalnızca Gmail'in satırındaysa", () => {
    expect(trusted(base(ok), ADDRESS)).toEqual({
      source: "provider",
      senderAuth: "pass",
      nullReturnPath: false,
    });
    expect(trusted(base({ ...ok, returnPath: "<>" }), ADDRESS)).toMatchObject({
      nullReturnPath: true,
    });
  });
  it("Return-Path, Delivered-To'dan ÖNCE geliyorsa (Gmail düzeni değil) boş zarf gönderen sayılmaz", () => {
    const wrong = [
      "Return-Path: <>",
      `Delivered-To: ${ADDRESS}`,
      "Received: from m.example.invalid by mx.google.com with ESMTPS id q1;",
      `Authentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}`,
      `From: ${RCPT}`,
      "",
      "x",
    ].join("\r\n");
    expect(trusted(wrong, ADDRESS)).toMatchObject({
      senderAuth: "pass",
      nullReturnPath: false,
    });
  });
  it("sonuçlar: fail → fail; none/yok → none", () => {
    expect(trusted(base({ ...ok, dmarc: "fail" }), ADDRESS)?.senderAuth).toBe("fail");
    expect(trusted(base({ ...ok, dmarc: "none" }), ADDRESS)?.senderAuth).toBe("none");
  });
  it("şüphede null: başlık yok, kutu adresi yok, uyuşmayan Delivered-To, güvenilmez authserv-id", () => {
    expect(trusted(base({ ...ok, dmarc: "missing" }), ADDRESS)).toBeNull();
    expect(trusted(base(ok), null)).toBeNull();
    expect(trusted(base({ ...ok, deliveredTo: "x@y.example" }), ADDRESS)).toBeNull();
    expect(trusted(base({ ...ok, authserv: "evil.example" }), ADDRESS)).toBeNull();
    expect(trusted(rawMessage({ from: RCPT, nonce: "x" }), ADDRESS)).toBeNull(); // ham iletide Gmail başlığı yok
    expect(trusted("", ADDRESS)).toBeNull();
    expect(trusted("bozuk satır\r\n\r\nx", ADDRESS)).toBeNull();
  });
  it("yalnızca Authentication-Results özgün başlıklardan SONRA ise (gönderen eklemiş olabilir) yok sayılır", () => {
    const late = [
      `Delivered-To: ${ADDRESS}`,
      `From: ${RCPT}`,
      "Subject: x",
      `Authentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}`,
      "",
      "body",
    ].join("\r\n");
    expect(trusted(late, ADDRESS)).toBeNull();
  });
  it("mx.google.com iddiasında İKİNCİ başlık (sahte, alta eklenmiş) → belirsiz → null; sıra tek başına yetmez", () => {
    const forged = base({
      ...ok,
      dmarc: "fail",
      forgedFirst: [`Authentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}`],
    });
    expect(trusted(forged, ADDRESS)).toBeNull();
    for (const name of ["AUTHENTICATION-RESULTS", "authentication-results"]) {
      const f = base({
        ...ok,
        forgedFirst: [`${name}: MX.GOOGLE.COM; dmarc=pass header.from=${RCPT_DOMAIN}`],
      });
      expect(trusted(f, ADDRESS)).toBeNull();
    }
    // sahte başlık özgün başlıkların SONUNDA olsa da (From'dan sonra) iddia sayılır
    const late = base(ok).replace(
      "\r\n\r\n",
      `\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}\r\n\r\n`,
    );
    expect(trusted(late, ADDRESS)).toBeNull();
  });
  it("Gmail'in `Received` başlığı yoksa, sahte ise veya çift ise veya sırası bozuksa → null", () => {
    const lines = base(ok).split("\r\n");
    const recvAt = lines.findIndex((l) => l.startsWith("Received: from mail.example.invalid"));
    const noRecv = [...lines.slice(0, recvAt), ...lines.slice(recvAt + 2)].join("\r\n");
    expect(trusted(noRecv, ADDRESS)).toBeNull();
    expect(
      trusted(base(ok).replace("by mx.google.com", "by mx.baska.example"), ADDRESS),
    ).toBeNull();
    const dbl = base({
      ...ok,
      forgedFirst: ["Received: from evil.example by mx.google.com with ESMTP id z;"],
    });
    expect(trusted(dbl, ADDRESS)).toBeNull();
    // Received, Authentication-Results'tan SONRA ise (sıra bozuk)
    const arAt = lines.findIndex((l) => l.startsWith("Authentication-Results:"));
    const arBlock = lines.slice(arAt, arAt + 4);
    const swapped = [
      ...lines.slice(0, recvAt),
      ...arBlock,
      ...lines.slice(recvAt, recvAt + 2),
      ...lines.slice(arAt + 4),
    ];
    expect(trusted(swapped.join("\r\n"), ADDRESS)).toBeNull();
  });
  it("başlık sırası değiştirilirse (Delivered-To özgün başlıklardan sonra / AR en üstte) → null", () => {
    const lines = base(ok).split("\r\n");
    const di = lines.findIndex((l) => l.startsWith("Delivered-To:"));
    const moved = [...lines.slice(0, di), ...lines.slice(di + 1)];
    moved.splice(moved.findIndex((l) => l.startsWith("From:")) + 1, 0, lines[di]!);
    expect(trusted(moved.join("\r\n"), ADDRESS)).toBeNull();
    const arAt = lines.findIndex((l) => l.startsWith("Authentication-Results:"));
    const arBlock = lines.slice(arAt, arAt + 4);
    const rest = [...lines.slice(0, arAt), ...lines.slice(arAt + 4)];
    expect(trusted([...arBlock, ...rest].join("\r\n"), ADDRESS)).toBeNull();
  });
  it("birden çok Return-Path: boş zarf sayılmaz (hangisinin Gmail'in olduğu ayırt edilemez)", () => {
    const two = base({ ...ok, returnPath: "<>", forgedFirst: ["Return-Path: <>"] });
    expect(trusted(two, ADDRESS)).toMatchObject({ senderAuth: "pass", nullReturnPath: false });
    const other = base({ ...ok, returnPath: "<a@b.example>", forgedFirst: ["Return-Path: <>"] });
    expect(trusted(other, ADDRESS)).toMatchObject({ nullReturnPath: false });
  });
  it("yetkili kimliği taklitleri: mx.google.com.evil, sonda nokta, başka kimlik, yorumda gizlenmiş", () => {
    for (const authserv of [
      "mx.google.com.evil.example",
      "mx.google.com.",
      "evil.example; x=mx.google.com",
      "(mx.google.com)",
    ]) {
      expect(trusted(base({ ...ok, authserv }), ADDRESS)).toBeNull();
    }
  });
  it("Authentication-Results içindeki gönderen kontrollü metin sahte 'dmarc=pass' üretemez", () => {
    const inject = (ar: string) =>
      base(ok).replace(/Authentication-Results:[\s\S]*?header\.from=[^\r\n]*/, ar);
    const inComment = inject(
      `Authentication-Results: mx.google.com;\r\n spf=pass (google.com: domain of dmarc=pass@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=x@evil.example;\r\n dmarc=fail (p=NONE) header.from=${RCPT_DOMAIN}`,
    );
    expect(trusted(inComment, ADDRESS)?.senderAuth).toBe("fail");
    // yorum içinde ';' ile sahte segment: yorumlar atılmazsa 'pass' doğardı (gerçek dmarc sonucu yok/none)
    const semicolonComment = inject(
      `Authentication-Results: mx.google.com;\r\n spf=pass (google.com: domain of x@evil.example; dmarc=pass header.from=${RCPT_DOMAIN}) smtp.mailfrom=x@evil.example`,
    );
    expect(trusted(semicolonComment, ADDRESS)?.senderAuth).toBe("none");
    const semicolonOverFail = inject(
      `Authentication-Results: mx.google.com;\r\n spf=pass (note; dmarc=pass header.from=${RCPT_DOMAIN});\r\n dmarc=fail header.from=${RCPT_DOMAIN}`,
    );
    expect(trusted(semicolonOverFail, ADDRESS)?.senderAuth).toBe("fail");
    const two = inject(
      `Authentication-Results: mx.google.com;\r\n dmarc=fail header.from=${RCPT_DOMAIN};\r\n dmarc=pass header.from=${RCPT_DOMAIN}`,
    );
    expect(trusted(two, ADDRESS)).toBeNull();
    const wrongSeg = inject(
      `Authentication-Results: mx.google.com;\r\n dkim=pass header.from=${RCPT_DOMAIN};\r\n dmarc=pass header.from=evil.example`,
    );
    expect(trusted(wrongSeg, ADDRESS)?.senderAuth).toBe("none");
  });
  it("From alan adı ile header.from farklıysa pass verilmez", () => {
    expect(trusted(base({ ...ok, headerFrom: "baska.com" }), ADDRESS)?.senderAuth).toBe("none");
  });
});

describe("eşleştirme ve veri azaltma", () => {
  it("Message-ID yeniden yazılmış: aynı konuşmadaki TEK kampanya iletisiyle eşleşir (L2/L3 yine gerekir)", async () => {
    const raw = gmailWrap(
      rawMessage({
        from: RCPT,
        to: ADDRESS,
        inReplyTo: "<yeniden.yazilmis@mail.gmail.com>",
        nonce: "t1",
      }),
      { mailbox: ADDRESS, headerFrom: RCPT_DOMAIN },
    );
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw });
    await drain();
    expect(await clStatus()).toBe("replied");
    expect((await inboundRows())[0]).toMatchObject({ status: "matched", threadId: "t-out1" });
  });

  it("konuşmada birden çok kampanya iletisi varsa (belirsiz) konuşma eşleşmesi YOK → etki yok", async () => {
    const s2 = await seedSent(db, campaign, { mailboxId: gid, email: "diger@diger-alan.com" });
    await db.update(messages).set({ threadId: "t-out1" }).where(eq(messages.id, s2.outboundId));
    const raw = gmailWrap(
      rawMessage({
        from: RCPT,
        to: ADDRESS,
        inReplyTo: "<yeniden.yazilmis@mail.gmail.com>",
        nonce: "t2",
      }),
      { mailbox: ADDRESS, headerFrom: RCPT_DOMAIN },
    );
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw });
    await drain();
    expect(await clStatus()).toBe("waiting_next");
    const rows = await inboundRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.campaignLeadId).toBeNull();
  });

  it("ilgisiz gerçek posta (bizim iletilerimizle bağı yok) HİÇ saklanmaz", async () => {
    inbox.add({
      labels: ["INBOX"],
      raw: gmailWrap(
        rawMessage({
          from: "arkadas@baska.example",
          to: ADDRESS,
          nonce: "z1",
          body: "Özel yazışma",
        }),
        {
          mailbox: ADDRESS,
          headerFrom: "baska.example",
        },
      ),
    });
    const r = await drain();
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(await inboundRows()).toHaveLength(0);
  });

  it("etiket süzgeci: SENT/SPAM/DRAFT/TRASH veya INBOX olmayan iletiler işlenmez", async () => {
    for (const [i, labels] of [
      ["SENT"],
      ["INBOX", "SENT"],
      ["INBOX", "SPAM"],
      ["INBOX", "TRASH"],
      ["INBOX", "DRAFT"],
    ].entries()) {
      inbox.add({ id: `lab${i}`, threadId: "t-out1", labels, raw: reply(`lb${i}`) });
    }
    await drain();
    expect(await inboundRows()).toHaveLength(0);
    expect(await clStatus()).toBe("waiting_next");
  });

  it("çok büyük ileti atlanır (sayılır), diğerleri işlenir", async () => {
    inbox.add({
      id: "big1",
      threadId: "t-out1",
      labels: ["INBOX"],
      raw: reply("big", "x".repeat(300_000)),
    });
    inbox.add({ id: "ok1", threadId: "t-out1", labels: ["INBOX"], raw: reply("ok") });
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(await inboundRows()).toHaveLength(1);
  });
});

describe("eşitleme durumu: sayfalama, artımlı, yinelenenler", () => {
  it("sayfalama: sayfa sayfa okunur, hiçbir ileti atlanmaz ve tek turda limit aşılmaz", async () => {
    for (let i = 0; i < 7; i++)
      inbox.add({
        threadId: "t-out1",
        labels: ["INBOX"],
        raw: reply(`pg${i}`, `Merhaba ${i} catalogue`),
      });
    const batches: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await sync({ maxMessages: 2 });
      batches.push(r.fetched);
      expect(r.error).toBeNull();
    }
    expect(Math.max(...batches)).toBeLessThanOrEqual(2);
    expect(await inboundRows()).toHaveLength(7);
    const c = decodeCursor(await cursorOf());
    expect(c?.m).toBe("history");
  });

  it("artımlı: ilk tarama bittikten sonra yeni iletiler history ile okunur (liste yeniden taranmaz)", async () => {
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw: reply("i1") });
    await drain();
    expect(await inboundRows()).toHaveLength(1);
    inbox.requests.length = 0;
    inbox.add({
      threadId: "t-out1",
      labels: ["INBOX"],
      raw: reply("i2", "ikinci yanıt catalogue"),
    });
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(await inboundRows()).toHaveLength(2);
    const paths = inbox.requests.map((q) => q.path.replace("/gmail/v1/users/me", ""));
    expect(paths).toContain("/history");
    expect(paths).not.toContain("/messages"); // liste çağrısı yok
    // değişiklik yokken tekrar: yeni satır yok
    await drain();
    expect(await inboundRows()).toHaveLength(2);
  });

  it("aynı ileti birden çok kez (geçmişte çift kayıt, farklı id ile aynı ham ileti) tek satır üretir", async () => {
    const raw = reply("dup1");
    inbox.add({ id: "dupA", threadId: "t-out1", labels: ["INBOX"], raw });
    await drain();
    inbox.add({ id: "dupB", threadId: "t-out1", labels: ["INBOX"], raw }); // Gmail'de aynı içerik, farklı kimlik
    inbox.history.push({ id: inbox.historyId + 1, added: ["dupB", "dupB"] }); // geçmişte çift kayıt
    inbox.historyId += 1;
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(await inboundRows()).toHaveLength(1);
    expect(r.duplicates).toBeGreaterThanOrEqual(1);
  });

  it("historyId süresi dolarsa (404) imleç sıfırlanır, 30 gün yeniden taranır, çift işlenmez", async () => {
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw: reply("h1") });
    await drain();
    expect(await inboundRows()).toHaveLength(1);
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw: reply("h2", "yeni catalogue") });
    inbox.oldestHistory = inbox.historyId + 5; // her eski historyId geçersiz
    let resynced = false;
    for (let i = 0; i < 6; i++) {
      const r = await sync();
      resynced ||= r.resynced;
      if (resynced && r.fetched > 0) break;
      if (resynced) inbox.oldestHistory = 0; // sonraki tur yeniden başlar
    }
    expect(resynced).toBe(true);
    await drain();
    expect(await inboundRows()).toHaveLength(2); // h1 çift işlenmedi, h2 yakalandı
  });

  it("bozuk/yabancı imleç güvenle baştan eşitlemeye döner; veri kaybı ve çift kayıt yok", async () => {
    inbox.add({ threadId: "t-out1", labels: ["INBOX"], raw: reply("c1") });
    await db.update(mailboxes).set({ syncCursor: "{bozuk" }).where(eq(mailboxes.id, gid));
    await drain();
    expect(await inboundRows()).toHaveLength(1);
    for (const bad of [
      null,
      "",
      "{}",
      '{"v":2}',
      '{"v":1,"m":"x"}',
      encodeCursor({ m: "history", h: "abc", p: null, d: true, q: [], t: null }),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
    expect(
      decodeCursor(encodeCursor({ m: "history", h: "123", p: null, d: true, q: ["a1"], t: null })),
    ).not.toBeNull();
    expect(
      decodeCursor(
        JSON.stringify({ v: 1, m: "history", h: "1", p: null, d: true, q: ["../x"], t: null }),
      ),
    ).toBeNull();
  });

  it("tek ileti silinmiş (404): atlanır, diğerleri işlenir, imleç ilerler", async () => {
    inbox.add({ id: "gone1", threadId: "t-out1", labels: ["INBOX"], raw: reply("g1") });
    inbox.add({
      id: "live1",
      threadId: "t-out1",
      labels: ["INBOX"],
      raw: reply("g2", "canlı catalogue"),
    });
    inbox.faults.push({ match: "/messages/gone1", status: 404, body: { error: { code: 404 } } });
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(await inboundRows()).toHaveLength(1);
    expect(await cursorOf()).not.toBeNull();
  });
});

describe("hata ve belirsizlikte veri kaybı/yanlış işleme yok", () => {
  const faultCases: [
    string,
    string,
    Partial<{ status: number; body: unknown; headers: Record<string, string>; drop: boolean }>,
    string,
  ][] = [
    ["ileti 500", "/messages/m", { status: 500 }, "unavailable"],
    ["ileti bağlantı kopması", "/messages/m", { drop: true }, "network"],
    [
      "ileti 429 + Retry-After",
      "/messages/m",
      { status: 429, headers: { "Retry-After": "30" } },
      "rate_limited",
    ],
    [
      "ileti 403 izin",
      "/messages/m",
      { status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
      "forbidden",
    ],
    ["ileti bozuk JSON", "/messages/m", { status: 200, body: "{bozuk" }, "bad_response"],
    [
      "ileti kimlik uyuşmazlığı",
      "/messages/m",
      {
        status: 200,
        body: { id: "baska", threadId: "t", labelIds: ["INBOX"], internalDate: "1", raw: "eA" },
      },
      "bad_response",
    ],
    [
      "ileti raw yok",
      "/messages/m",
      {
        status: 200,
        body: { id: "m1a", threadId: "t-out1", labelIds: ["INBOX"], internalDate: "1" },
      },
      "bad_response",
    ],
    [
      "ileti raw base64 değil",
      "/messages/m",
      {
        status: 200,
        body: { id: "m1a", threadId: "t-out1", labelIds: ["INBOX"], internalDate: "1", raw: "***" },
      },
      "bad_response",
    ],
    ["liste 500", "/messages?", { status: 500 }, "unavailable"],
    ["profil bozuk", "/profile", { status: 200, body: { emailAddress: 5 } }, "bad_response"],
    ["profil 503", "/profile", { status: 503 }, "unavailable"],
  ];
  it.each(faultCases)(
    "%s: hata kodu, imleç ilerlemez, hiçbir ileti işlenmez",
    async (_n, match, fault, code) => {
      inbox.add({ id: "m1a", threadId: "t-out1", labels: ["INBOX"], raw: reply("e1") });
      // "/messages?" eşleşmesi: yalnızca liste ucu (yol eşleşmesi olduğundan "/messages" kullanılır)
      inbox.faults.push({
        match: match === "/messages?" ? "/gmail/v1/users/me/messages" : match,
        ...fault,
        times: 1,
      });
      // liste hatasında tekil ileti yolu da içerir; "times:1" yalnızca ilk isteği etkiler
      const r = await sync();
      expect(r.error).toBe(code);
      expect(r.processed).toBe(0);
      expect(await inboundRows()).toHaveLength(0);
      const cur = await cursorOf();
      expect(cur === null || decodeCursor(cur)?.q.length === 0).toBe(true);
      // hata geçince aynı iletiler tam BİR kez işlenir (kayıp yok, çift yok)
      const ok = await drain();
      expect(ok.errors).toEqual([]);
      expect(await inboundRows()).toHaveLength(1);
      expect(await clStatus()).toBe("replied");
    },
  );

  it("ortadaki ileti hata verirse önceki iletiler de işlenmez; imleç aynı kalır; sonra hepsi bir kez işlenir", async () => {
    for (let i = 1; i <= 3; i++)
      inbox.add({
        id: `b${i}`,
        threadId: "t-out1",
        labels: ["INBOX"],
        raw: reply(`mid${i}`, `ileti ${i} catalogue`),
      });
    inbox.faults.push({ match: "/messages/b2", status: 500, times: 1 });
    const before = await cursorOf();
    const r = await sync();
    expect(r.error).toBe("unavailable");
    expect(await inboundRows()).toHaveLength(0);
    expect(await cursorOf()).toBe(before);
    await drain();
    expect(await inboundRows()).toHaveLength(3);
  });

  it("401: belirteç BİR kez yenilenir ve istek tekrarlanır (okuma idempotent); ikinci 401 → hata, kayıt yok", async () => {
    inbox.add({ id: "m1a", threadId: "t-out1", labels: ["INBOX"], raw: reply("a401") });
    inbox.faults.push({ match: "/profile", status: 401, body: {}, times: 1 });
    const ok = await drain();
    expect(ok.errors).toEqual([]);
    expect(await inboundRows()).toHaveLength(1);

    // ikinci 401 de gelirse hata
    await db.update(mailboxes).set({ syncCursor: null }).where(eq(mailboxes.id, gid));
    inbox.faults.push({ match: "/profile", status: 401, body: {}, times: 2 });
    const r = await sync();
    expect(r.error).toBe("unauthorized");
  });

  it("yenileme invalid_grant verirse: kutu 'error', yeniden yetkilendirme istenir, ileti işlenmez", async () => {
    inbox.add({ id: "m1a", threadId: "t-out1", labels: ["INBOX"], raw: reply("rg") });
    oauth.validRefresh.clear();
    const r = await sync();
    expect(r.error).toBe("reauthorization_required");
    expect(await inboundRows()).toHaveLength(0);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, gid)))[0]!.status).toBe(
      "error",
    );
    expect(inbox.requests).toHaveLength(0);
  });

  it("okuyucu sözleşmesi: limitten fazla ileti dönerse imleç ilerletilmez ve hiçbir şey işlenmez", async () => {
    const liar = {
      id: "gmail" as const,
      async fetch() {
        const items = [1, 2, 3].map((n) => ({
          mailboxId: gid,
          raw: reply(`liar${n}`),
          receivedAt: NOW,
          attestation: null,
        }));
        return { items, nextCursor: "ILERI" };
      },
    };
    const r = await sync({ maxMessages: 2, r: liar as unknown as GmailInboxReader });
    expect(r.error).toBe("reader_contract_violation");
    expect(await inboundRows()).toHaveLength(0);
    expect(await cursorOf()).toBeNull();
  });

  it("işleme reddedilirse (kutu pasif olmuş) imleç ilerletilmez", async () => {
    const stub = {
      id: "gmail" as const,
      async fetch() {
        await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, gid));
        return {
          items: [{ mailboxId: gid, raw: reply("rj"), receivedAt: NOW, attestation: null }],
          nextCursor: "ILERI",
        };
      },
    };
    const r = await sync({ r: stub as unknown as GmailInboxReader });
    expect(r.error).toBe("rejected_mailbox_inactive");
    expect(await cursorOf()).toBeNull();
  });

  it("GmailInboxError güvenli kod taşır; ileti/adres/belirteç içermez", async () => {
    inbox.add({ id: "m1a", threadId: "t-out1", labels: ["INBOX"], raw: reply("lk") });
    inbox.faults.push({
      match: "/profile",
      status: 403,
      body: {
        error: { message: "SECRET-DETAIL kisi@alici-ornek.com", errors: [{ reason: "forbidden" }] },
      },
    });
    const err = await reader.fetch(gid, null, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailInboxError);
    const text = JSON.stringify({ m: (err as Error).message, c: (err as GmailInboxError).code });
    for (const leak of ["SECRET-DETAIL", "alici-ornek", "ya29", "Bearer", CLIENT_SECRET])
      expect(text).not.toContain(leak);
  });
});

describe("güven kilidi (GMAIL_HEADER_TRUST_VERIFIED, KAPALI; okuma kapısı açık sürümde de)", () => {
  /** Gerçek Gmail'inkiyle BİREBİR aynı görünen, mükemmel başlıklar: sıra/biçim kanıt değildir. */
  const perfectReply = () => reply("lk1", "Please unsubscribe me from your list.");

  it("sabit kapalı; kilit kapalıyken mükemmel görünen başlıklar bile tasdik üretmez", () => {
    expect(GMAIL_HEADER_TRUST_VERIFIED).toBe(false);
    expect(extractGmailAttestation(perfectReply(), ADDRESS)).toBeNull();
    expect(extractGmailAttestation(dsn("lk2"), ADDRESS)).toBeNull();
    expect(extractGmailAttestation(perfectReply(), ADDRESS, { trustVerified: false })).toBeNull();
  });

  it("kilit kapalı okuyucu (varsayılan): yanıt, ayrılma ve bounce İNCELEMEYE kaydedilir; etki YOK", async () => {
    const strict = newReader({ headerTrustVerified: undefined });
    inbox.add({ id: "lk-a", threadId: "t-out1", labels: ["INBOX"], raw: perfectReply() });
    inbox.add({ id: "lk-b", threadId: "t-out1", labels: ["INBOX"], raw: dsn("lk3") });
    inbox.add({ id: "lk-c", threadId: "t-out1", labels: ["INBOX"], raw: reply("lk4") });
    for (let i = 0; i < 4; i++) expect((await sync({ r: strict })).error).toBeNull();
    const rows = await inboundRows();
    expect(rows).toHaveLength(3);
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "inbound.bounce_hard")),
    ).toHaveLength(0);
    for (const r of rows) {
      expect(r.status).toBe("received");
      expect(r.errorCode).toBe("no_attestation");
      expect(r.campaignLeadId).toBeNull();
    }
  });

  it("gönderenin taklit ettiği Gmail başlıkları (ham ileti içinde) de etki üretmez", async () => {
    const strict = newReader({ headerTrustVerified: undefined });
    const forgedEverything = rawMessage({
      from: RCPT,
      to: ADDRESS,
      inReplyTo: sent.rfc,
      nonce: "fk1",
      body: "Please unsubscribe me.",
    }).replace(
      "From:",
      `Delivered-To: ${ADDRESS}\r\nReturn-Path: <>\r\nReceived: from x by mx.google.com with ESMTPS id q;\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=${RCPT_DOMAIN}\r\nFrom:`,
    );
    inbox.add({ id: "fk", threadId: "t-out1", labels: ["INBOX"], raw: forgedEverything });
    for (let i = 0; i < 3; i++) await sync({ r: strict });
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
    expect((await inboundRows())[0]!.errorCode).toBe("no_attestation");
  });

  it("güven kilidi geçersiz kılması üretimde kabul edilmez", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() => new GmailInboxReader({ db, headerTrustVerified: () => true })).toThrow(
        /yalnızca testte/,
      );
      expect(extractGmailAttestation(perfectReply(), ADDRESS, { trustVerified: true })).toBeNull();
    } finally {
      env.NODE_ENV = prev;
    }
  });
});

describe("ARF (RFC 5965) şikâyet raporları Gmail gelen kutusundan (Aşama 15.8)", () => {
  const REPORTER = "fbl.reporter-ornek.com";
  const arfRaw = () =>
    gmailWrap(
      rawArf({
        outboundMessageId: sent.rfc,
        rcptTo: RCPT,
        to: ADDRESS,
        nonce: "g1",
        from: `fbl@${REPORTER}`,
      }),
      { mailbox: ADDRESS, headerFrom: REPORTER },
    );

  it("bizim iletimizle ilişkili ARF ön elemeden geçer (saklanır); ilgisiz ARF saklanmaz", async () => {
    inbox.add({ id: "arf1", labels: ["INBOX"], raw: arfRaw() });
    inbox.add({
      id: "arf2",
      labels: ["INBOX"],
      raw: gmailWrap(
        rawArf({
          outboundMessageId: "<baskasinin.mesaji@baska.example>",
          rcptTo: RCPT,
          to: ADDRESS,
          nonce: "g2",
          from: `fbl@${REPORTER}`,
        }),
        { mailbox: ADDRESS, headerFrom: REPORTER },
      ),
    });
    const r = await drain();
    expect(r.errors).toEqual([]);
    expect(await inboundRows()).toHaveLength(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("başlık güven kilidi KAPALIYKEN (varsayılan) şikâyet yalnızca incelemeye kaydedilir: engel/durdurma YOK", async () => {
    await setTrustedReporters(db, [REPORTER], NOW);
    const strict = newReader({ headerTrustVerified: undefined });
    inbox.add({ id: "arf3", labels: ["INBOX"], raw: arfRaw() });
    for (let i = 0; i < 3; i++) expect((await sync({ r: strict })).error).toBeNull();
    const [row] = await inboundRows();
    expect(row).toMatchObject({
      status: "received",
      errorCode: "arf_complaint:no_attestation",
      classification: "other",
    });
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
  });

  it("kilit açık varsayımıyla (yalnızca test) + güvenilir rapor sağlayıcısı + tam kanıt: doğrulanmış şikâyet engel ve durdurma üretir", async () => {
    await setTrustedReporters(db, [REPORTER], NOW);
    inbox.add({ id: "arf4", labels: ["INBOX"], raw: arfRaw() });
    await drain();
    expect(await suppressedCount()).toBe(1);
    expect(await clStatus()).toBe("unsubscribed");
    expect((await inboundRows())[0]).toMatchObject({
      status: "matched",
      errorCode: "arf_complaint",
    });
  });

  it("ARF'nin konuşma kimliği bizim konuşmamızla aynı olsa bile konuşma yedeğiyle EŞLEŞTİRİLMEZ (yalnızca Message-ID)", async () => {
    await setTrustedReporters(db, [REPORTER], NOW);
    inbox.add({
      id: "arf6",
      threadId: "t-out1",
      labels: ["INBOX"],
      raw: gmailWrap(
        rawArf({
          outboundMessageId: "<yeniden.yazilmis@mail.gmail.com>",
          rcptTo: RCPT,
          to: ADDRESS,
          nonce: "g6",
          from: `fbl@${REPORTER}`,
        }),
        { mailbox: ADDRESS, headerFrom: REPORTER },
      ),
    });
    await drain();
    expect(await suppressedCount()).toBe(0);
    expect(await clStatus()).toBe("waiting_next");
    expect((await inboundRows())[0]).toMatchObject({ status: "unmatched" });
  });

  it("rapor sağlayıcısı güvenilir listede değilse kilit açık olsa bile doğrulanmaz", async () => {
    inbox.add({ id: "arf5", labels: ["INBOX"], raw: arfRaw() });
    await drain();
    expect(await suppressedCount()).toBe(0);
    expect((await inboundRows())[0]).toMatchObject({
      status: "received",
      errorCode: "arf_complaint:reporter_untrusted",
    });
  });
});
