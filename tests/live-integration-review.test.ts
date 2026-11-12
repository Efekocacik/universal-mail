import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as settingsRoute from "@/app/api/settings/route";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import {
  GMAIL_HEADER_TRUST_VERIFIED,
  LIVE_INBOX_READING_ENABLED,
  LIVE_SENDING_ENABLED,
} from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { auditLog, mailboxes, settings } from "@/lib/db/schema";
import { checkDomainAuth } from "@/lib/mail/dns-check";
import { recordDnsReport } from "@/lib/mail/dns-store";
import { GmailInboxReader } from "@/lib/mail/gmail/inbox";
import { GmailProvider } from "@/lib/mail/gmail/provider";
import { resetOAuthMemoryForTests } from "@/lib/mail/gmail/oauth";
import { syncInbox, type InboxReader } from "@/lib/mail/inbound/sync";
import {
  INBOX_SYNC_FRESH_MS,
  evaluateInboxSync,
  recordInboxSync,
} from "@/lib/mail/inbound/sync-status";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { getSetting, setSetting } from "@/lib/settings";
import { NonRetryableJobError } from "@/lib/jobs/registry";
import {
  HttpEventSource,
  createSpoolPullHandler,
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
} from "@/lib/unsubscribe/channel";
import { createUnsubscribeDrainHandler, startUnsubscribeDrain } from "@/lib/unsubscribe/drain-job";
import {
  checkDeliveryHealth,
  setUnsubscribeBaseUrl,
  verifyOneClickEndpoint,
} from "@/lib/unsubscribe/endpoint";
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

/**
 * Canlı entegrasyon incelemesi (Aşama 15.7; kapı açma sürümünde güncellendi): (a) hazırlık ekranı gerçek ortam
 * kanıtı olmadan başarılı görünmez, (b) kod kapıları açıkken de varsayılan ayarlarla (bağlantı belirteci, DNS, uç nokta,
 * ülke kilidi yok) HİÇBİR gerçek gönderim/okuma isteği oluşmaz, (c) iç durum anahtarları API'den yazılamaz.
 * Ağ yok: genel fetch casusla izlenir; "ağ" süreç içidir.
 */

const BASE = "https://cikis.firma-ornek.com";
const ADDRESS = "satis@firma-ornek.com";
const DOMAIN = "firma-ornek.com";
const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
const NOW = T0 + 3_600_000;

let client: Client;
let db: Db;
let dir: string;
let globalFetch: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-review-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  resetOAuthMemoryForTests();
  globalFetch = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled(); // gerçek ağ isteği YOK
  globalFetch.mockRestore();
  delete (globalThis as Record<string, unknown>)[HANDLE];
  resetOAuthMemoryForTests();
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const by = async (now = NOW) =>
  Object.fromEntries((await getLiveReadiness(db, { now })).items.map((i) => [i.key, i.status]));

/** Yazılımın yerel olarak kanıtlayabildiği EN İYİ durum: onay, profil, bağlı gerçek kutu, DNS, uç nokta, kuyruk, okuma. */
async function bestCaseSoftwareState() {
  const gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
  await setSetting(db, "mail.gmailGrants", { [String(gid)]: { send: true, read: true, at: NOW } });
  // DNS: sahte çözümleyici ile gerçek denetim mantığı; ağ yok
  const resolver = {
    resolveTxt: async (name: string) => {
      const map: Record<string, string> = {
        [DOMAIN]: "v=spf1 include:_spf.google.com -all",
        [`_dmarc.${DOMAIN}`]: "v=DMARC1; p=reject",
        [`google._domainkey.${DOMAIN}`]:
          "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC",
      };
      if (!(name in map)) throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      return [[map[name]!]];
    },
  };
  await recordDnsReport(
    db,
    { id: gid, address: ADDRESS },
    await checkDomainAuth(DOMAIN, { selector: "google", resolver }),
    NOW,
  );
  // uç nokta + kuyruk: tam uçtan uca doğrulama (süreç içi ağ)
  await ensureSigningKey(db, NOW);
  await ensureChannelKey(db, NOW);
  await setUnsubscribeBaseUrl(db, BASE, NOW);
  const spool = new FileSpool({ dir: path.join(dir, "spool"), now: () => NOW });
  const relay = createRelayHandler({ keys: () => loadPublicKeys(db), sink: spool, now: () => NOW });
  const pull = createSpoolPullHandler({
    spool,
    keys: () => exportChannelPublicKeys(db),
    now: () => NOW,
  });
  const net = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url as string, init);
    return new URL(req.url).pathname.startsWith("/u/") ? relay(req) : pull(req);
  }) as typeof fetch;
  const signer = (await getChannelSigner(db))!;
  const source = new HttpEventSource({
    baseUrl: BASE,
    kid: signer.kid,
    privateKey: signer.privateKey,
    now: () => NOW,
    fetch: net,
  });
  expect(
    (
      await verifyOneClickEndpoint(db, {
        source,
        fetch: net,
        now: () => NOW,
        sleep: async () => undefined,
        attempts: 2,
      })
    ).ok,
  ).toBe(true);
  await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
  await checkDeliveryHealth(db, source, NOW);
  await recordInboxSync(db, gid, { ok: true, code: "ok" }, NOW);
  return gid;
}

describe("hazırlık: gerçek ortam kanıtı olmadan başarılı görünmez", () => {
  it("yazılımın kanıtlayabildiği EN İYİ durumda bile allOk=false; başlık güveni, ülke kilidi ve pilot kalır", async () => {
    await bestCaseSoftwareState();
    const r = await getLiveReadiness(db, { now: NOW + 1000 });
    const s = Object.fromEntries(r.items.map((i) => [i.key, i.status]));
    // yerel olarak kanıtlanabilenler gerçekten 'tamam' olur (testin anlamlı olduğunu gösterir)
    expect(s).toMatchObject({
      consent: "ok",
      company_profile: "ok",
      real_mailbox: "ok",
      inbox_access: "ok",
      dns_auth: "ok",
      event_delivery: "ok",
      inbox_sync: "ok",
    });
    // Kod kapıları ve sahip kararları bu sürümde açık; uç nokta kanıtı + sürüm kapısı birlikte 'tamam'.
    expect(s).toMatchObject({
      live_flag: "ok",
      live_inbox_flag: "ok",
      https_unsubscribe: "ok",
      legal_lia: "ok",
      legal_uyum: "ok",
      legal_live_countries: "ok",
      legal_erasure_records: "ok",
      legal_suppression_hash: "ok",
      legal_tr_identifiers: "ok",
    });
    // ... ama gerçek hesapla doğrulanacak başlık güveni, sahibin açacağı ülke kilidi ve pilot HÂLÂ eksik
    expect(s).toMatchObject({
      inbox_header_trust: "blocked",
      live_country_policies: "blocked",
      pilot: "unknown",
    });
    expect(r.allOk).toBe(false);
    expect(r.liveSendingEnabled).toBe(true);
  });

  it("dört gerçek-ortam kanıtından her biri eksildiğinde ilgili madde 'tamam' olmaktan çıkar", async () => {
    const gid = await bestCaseSoftwareState();
    expect((await by(NOW + 1000)).dns_auth).toBe("ok");
    await setSetting(db, "mail.dnsReports", {});
    expect((await by(NOW + 1000)).dns_auth).toBe("unknown");

    expect((await by(NOW + 1000)).event_delivery).toBe("ok");
    // Çekme işi kapatılırsa sağlıklı kayıt olsa bile teslimat engel olur (canlı kampanya da ertelenir).
    await setSetting(db, "mail.unsubscribeDrain", { enabled: false });
    expect((await by(NOW + 1000)).event_delivery).toBe("blocked");
    await setSetting(db, "mail.unsubscribeDrain", { enabled: true });
    await setSetting(db, "mail.unsubscribeEndpoint", {
      ...(await getSetting(db, "mail.unsubscribeEndpoint")),
      delivery: null,
    });
    expect((await by(NOW + 1000)).event_delivery).toBe("unknown");

    expect((await by(NOW + 1000)).inbox_sync).toBe("ok");
    await setSetting(db, "mail.inboxSync", {});
    expect((await by(NOW + 1000)).inbox_sync).toBe("unknown");
    await recordInboxSync(db, gid, { ok: false, code: "network" }, NOW);
    expect((await by(NOW + 1000)).inbox_sync).toBe("blocked");

    await setSetting(db, "mail.gmailGrants", {
      [String(gid)]: { send: true, read: false, at: NOW },
    });
    expect((await by(NOW + 1000)).inbox_access).toBe("blocked");
  });

  it("uç nokta kanıtı silinirse veya adres değişirse https_unsubscribe 'tamam' olamaz (sürüm kapısı açıkken de)", async () => {
    await bestCaseSoftwareState();
    expect((await by(NOW + 1000)).https_unsubscribe).toBe("ok");
    await setUnsubscribeBaseUrl(db, "https://baska.firma-ornek.com", NOW);
    expect((await by(NOW + 1000)).https_unsubscribe).toBe("blocked");
  });

  it("kapılar kodda sabit (kapı açma sürümü): gönderim/okuma açık, yedi onay true, başlık güveni kapalı", () => {
    expect(LIVE_SENDING_ENABLED).toBe(true);
    expect(LIVE_INBOX_READING_ENABLED).toBe(true);
    expect(GMAIL_HEADER_TRUST_VERIFIED).toBe(false);
    for (const [k, v] of Object.entries(LEGAL_APPROVALS)) expect(v, k).toBe(true);
    expect(isLiveSendingPermitted()).toBe(true);
  });

  it("iç durum ve kanıt anahtarları ayarlar API'siyle YAZILAMAZ (katı şema)", async () => {
    const before = JSON.stringify(await db.select().from(settings));
    const keys = [
      "mail.unsubscribeEndpoint",
      "mail.unsubscribeKeys",
      "mail.unsubscribeChannel",
      "mail.dnsReports",
      "mail.inboxSync",
      "mail.gmailGrants",
      "mail.mailboxHalts",
    ];
    for (const k of keys) {
      const res = await settingsRoute.PUT(
        new Request(`${ORIGIN}/api/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
          body: JSON.stringify({ [k]: {} }),
        }),
        undefined,
      );
      expect(res.status, k).toBe(400);
    }
    expect(JSON.stringify(await db.select().from(settings))).toBe(before);
  });
});

describe("kapılar açıkken de varsayılan ayarlarla HİÇBİR gerçek gönderim veya okuma isteği oluşmaz", () => {
  it("Gmail sağlayıcısı, gelen kutusu okuyucusu, eşitleme, kampanya gönderimi ve çekme işi bağlantı belirteci/hazırlık olmadan hiçbir istek atmaz", async () => {
    const gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
    await setSetting(db, "mail.gmailGrants", {
      [String(gid)]: { send: true, read: true, at: NOW },
    });

    // 1. gönderim sağlayıcısı: kapı açık, ama kutunun yenileme belirteci yok → ağa çıkmadan reddedilir
    const provider = new GmailProvider({ db, mailbox: { id: gid, address: ADDRESS } });
    const raw = `From: ${ADDRESS}\r\nTo: info@alici-ornek.com\r\nMessage-ID: <a@firma-ornek.com>\r\n\r\nx`;
    expect(
      await provider.send({
        raw,
        from: ADDRESS,
        to: "info@alici-ornek.com",
        messageId: "<a@firma-ornek.com>",
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: "rejected", code: "reauthorization_required" });

    // Belirteç sorunu kutuyu "yeniden yetkilendirme gerekli" durumuna alır: sonraki turlar (gönderim ve okuma) kutuyu
    // kullanmaz.
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, gid));
    expect(mb).toMatchObject({ status: "error", lastError: "reauthorization_required" });

    // 2. gelen kutusu okuyucusu: okuma kilidi açık, ama kutu bağlı değil → ağa çıkmadan hata
    await expect(new GmailInboxReader({ db }).fetch(gid, null, 10)).rejects.toMatchObject({
      code: "not_connected",
    });
    // Kutu yeniden bağlanana kadar eşitleme okuyucuyu hiç çağırmaz.
    let fetchCalled = false;
    const reader: InboxReader = {
      id: "gmail",
      fetch: async () => {
        fetchCalled = true;
        return { items: [], nextCursor: null };
      },
    };
    expect(await syncInbox(db, reader, gid, { now: () => NOW })).toMatchObject({
      fetched: 0,
      error: null,
    });
    expect(fetchCalled).toBe(false);
    // Yeniden bağlanmış (bağlı) kutuda tur okuma kilidi açık olduğundan okuyucuyu çağırır (süreç içi; ağ yok).
    await db.update(mailboxes).set({ status: "connected" }).where(eq(mailboxes.id, gid));
    await syncInbox(db, reader, gid, { now: () => NOW });
    expect(fetchCalled).toBe(true);

    // 3. kampanya gönderim yolu (canlı kutu): canlı ülke kilitli → uygun değil, sağlayıcı çağrılmaz
    const camp = await createCampaign(db, { status: "running", mailboxId: gid });
    const seq = await addSequence(db, camp, { nextSendAt: null, email: "info@alici-ornek.com" });
    let providerCalls = 0;
    const out = await sendCampaignStep(
      db,
      { campaignLeadId: seq.cl, stepIndex: 0 },
      {
        now: () => T0,
        provider: {
          id: "gmail",
          send: async () => (providerCalls++, { status: "rejected", code: "x", permanent: true }),
        },
      },
    );
    expect(["ineligible", "not_sendable"]).toContain(out.outcome);
    expect(providerCalls).toBe(0);

    // 4. çıkış olayı çekme işi
    await expect(
      createUnsubscribeDrainHandler({ enabled: false })({
        job: { id: 1 } as never,
        payload: {},
        db,
        shouldStop: () => false,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    const jobsBefore = JSON.stringify(await db.select().from(settings));
    expect(await startUnsubscribeDrain(db, { env: {} })).toEqual({ enabled: false });
    expect(JSON.stringify(await db.select().from(settings))).toBe(jobsBefore);
  });

  it("hazırlık değerlendirmesi ve DNS/uç nokta kayıtları ağ isteği YAPMAZ (yalnızca kullanıcı eylemi)", async () => {
    await bestCaseSoftwareState();
    const before = (await db.select().from(auditLog)).length;
    await getLiveReadiness(db, { now: NOW });
    expect((await db.select().from(auditLog)).length).toBe(before);
  });
});

describe("gelen kutusu okuma kanıtı (inbox_sync)", () => {
  async function connectedBox() {
    const gid = await addMailbox(db, { provider: "gmail", address: ADDRESS });
    return gid;
  }
  const stub = (impl: InboxReader["fetch"]): InboxReader => ({ id: "gmail", fetch: impl });

  it("açık okuma kilidiyle (yalnızca test) başarılı tur kanıt yazar; hata kanıtı 'engel' yapar; kilit kapalıyken hiçbir kanıt oluşmaz", async () => {
    const gid = await connectedBox();
    const ok = stub(async () => ({ items: [], nextCursor: "c1" }));
    await syncInbox(db, ok, gid, { now: () => NOW, liveInboxEnabled: () => true });
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toMatchObject({
      ok: true,
      code: "ok",
      at: NOW,
    });
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW + 1000)).toBe("ok");

    const fail = stub(async () => {
      throw Object.assign(new Error("x"), { code: "network" });
    });
    await syncInbox(db, fail, gid, { now: () => NOW + 2000, liveInboxEnabled: () => true });
    expect((await getSetting(db, "mail.inboxSync"))[String(gid)]).toMatchObject({
      ok: false,
      code: "network",
    });
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW + 3000)).toBe("blocked");
  });

  it("bayat kanıt 'doğrulanmadı'; kutu listesi boşsa 'doğrulanmadı'; gelecekteki kayıt geçersiz", async () => {
    const gid = await connectedBox();
    await recordInboxSync(db, gid, { ok: true, code: "ok" }, NOW);
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW + INBOX_SYNC_FRESH_MS - 1000)).toBe("ok");
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW + INBOX_SYNC_FRESH_MS + 1000)).toBe(
      "unknown",
    );
    expect(await evaluateInboxSync(db, [], NOW)).toBe("unknown");
    expect(await evaluateInboxSync(db, [{ id: gid }], NOW - 3600_000)).toBe("unknown");
  });

  it("demo kutusunun eşitlemesi gerçek okuma kanıtı YAZMAZ", async () => {
    const [demo] = await db.select().from(mailboxes).where(eq(mailboxes.provider, "demo"));
    const reader: InboxReader = {
      id: "demo",
      fetch: async () => ({ items: [], nextCursor: null }),
    };
    await syncInbox(db, reader, demo!.id, { now: () => NOW });
    expect(await getSetting(db, "mail.inboxSync")).toEqual({});
  });
});
