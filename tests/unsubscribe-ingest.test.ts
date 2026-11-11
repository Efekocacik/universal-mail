import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmail, liftProtectedSuppression, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, settings, suppressions } from "@/lib/db/schema";
import { secretExists, unsubscribeKeySecretName } from "@/lib/secrets/store";
import {
  MintError,
  buildUnsubscribeUrl,
  ensureSigningKey,
  exportRelayKeySet,
  loadPublicKeys,
  mintUnsubscribeToken,
  recipientTag,
  revokeSigningKey,
  rotateSigningKey,
} from "@/lib/unsubscribe/keys";
import {
  MAX_EVENT_AGE_MS,
  drainUnsubscribeEvents,
  ingestUnsubscribeEvent,
  type UnsubscribeEventSource,
} from "@/lib/unsubscribe/ingest";
import { MemoryEventQueue, createRelayHandler } from "@/lib/unsubscribe/relay";
import { MAX_TTL_MS, verifyToken } from "@/lib/unsubscribe/token";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW, seedSent, type Sent } from "./helpers/inbound-fixture";

/**
 * İmza anahtarları, belirteç üretimi ve olay işleme (Aşama 15.6). Bellek içi veritabanı ve geçici veri dizini; gerçek
 * ağ, HTTPS veya e-posta gönderimi YOK. Mevcut suppression ve denetim sistemleriyle entegrasyon sınanır.
 */

const RCPT = "kisi@alici-ornek.com";
const RCPT2 = "diger@diger-alan.com";
const BASE = "https://cikis.example.test";

let client: Client;
let db: Db;
let dir: string;
let campaign: number;
let a: Sent;
let b: Sent;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-unsub-"));
  process.env.UM_DATA_DIR = dir;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaign = await createCampaign(db, { status: "running" });
  a = await seedSent(db, campaign, { email: RCPT });
  b = await seedSent(db, campaign, { email: RCPT2 });
});
afterEach(() => {
  client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const mint = (
  s: Sent = a,
  over: { messageId?: number | null; now?: number; ttlMs?: number } = {},
) =>
  mintUnsubscribeToken(db, {
    campaignLeadId: s.cl,
    messageId: over.messageId === undefined ? s.outboundId : over.messageId,
    now: over.now ?? NOW,
    ...(over.ttlMs ? { ttlMs: over.ttlMs } : {}),
  });
const evt = (token: string, receivedAt = NOW + 1000) => ({
  v: 1,
  token,
  receivedAt,
  via: "one_click",
});
const ingest = (e: unknown, now = NOW + 2000) => ingestUnsubscribeEvent(db, e, { now });
const suppressed = () => db.select().from(suppressions);
const clStatus = async (s: Sent) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl)))[0]!.status;
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const inbound = () => db.select().from(messages).where(eq(messages.direction, "in"));
async function snapshot() {
  return JSON.stringify({
    s: await suppressed(),
    m: await inbound(),
    a: (await db.select().from(auditLog)).length,
    c: (await db.select().from(campaignLeads)).map((r) => [r.id, r.status]),
  });
}

describe("anahtar yönetimi", () => {
  it("anahtar üretilir (idempotent); özel anahtar yalnızca gizli depoda; ayarlarda ve dışa aktarımda yok", async () => {
    const k1 = await ensureSigningKey(db, NOW);
    const k2 = await ensureSigningKey(db, NOW + 5);
    expect(k2.kid).toBe(k1.kid);
    expect(await secretExists(unsubscribeKeySecretName(k1.kid))).toBe(true);
    const exported = await exportRelayKeySet(db);
    expect(exported).toEqual({
      v: 1,
      keys: [{ kid: k1.kid, x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }],
    });
    expect(Object.keys(exported.keys[0]!).sort()).toEqual(["kid", "x"]); // 'd' (özel) yok
    const dump = JSON.stringify((await db.select().from(settings)).concat([]));
    const secretsFile = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(secretsFile).not.toContain('"d"'); // şifreli; düz metin özel anahtar yok
    expect(dump).not.toMatch(/"d":/);
    expect(await audits("unsubscribe.key_created")).toHaveLength(1);
  });

  it("etkin anahtar yokken belirteç ÜRETİLMEZ (anahtar üretimi bilinçli bir adımdır)", async () => {
    await expect(mint()).rejects.toMatchObject({ code: "no_key" });
    expect(await loadPublicKeys(db)).toEqual([]);
  });

  it("döndürme: eski belirteç hâlâ doğrulanır, yeni belirteç yeni anahtarla; iptalde eski belirteç ölür", async () => {
    const k1 = await ensureSigningKey(db, NOW);
    const old = await mint();
    const k2 = await rotateSigningKey(db, NOW + 10);
    expect(k2.previous).toBe(k1.kid);
    const fresh = await mint(b);
    const keys = await loadPublicKeys(db);
    expect(keys.map((k) => k.kid).sort()).toEqual([k1.kid, k2.kid].sort());
    expect(verifyToken(old.token, keys, NOW + 1000).ok).toBe(true);
    const claims = verifyToken(fresh.token, keys, NOW + 1000);
    expect(claims.ok && claims.claims.k).toBe(k2.kid);
    // iptal: eski anahtarın belirteçleri artık kabul edilmez, özel anahtar silinir
    expect(await revokeSigningKey(db, k1.kid, NOW + 20)).toBe(true);
    expect(await secretExists(unsubscribeKeySecretName(k1.kid))).toBe(false);
    expect(await revokeSigningKey(db, k1.kid, NOW + 21)).toBe(false);
    const r = await ingest(evt(old.token));
    expect(r).toEqual({ outcome: "rejected", reason: "unknown_key" });
    expect(await suppressed()).toHaveLength(0);
    // etkin anahtar iptal edilirse yeni belirteç üretilemez
    await revokeSigningKey(db, k2.kid, NOW + 30);
    await expect(mint()).rejects.toMatchObject({ code: "no_key" });
    expect(await audits("unsubscribe.key_revoked")).toHaveLength(2);
  });

  it("alıcı etiketi gizli anahtarlıdır: adres özetinden farklı, kararlı, ana anahtar değişince değişir", async () => {
    const h = hashEmail(RCPT);
    const t1 = recipientTag(h);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(t1).not.toBe(h.slice(0, 22));
    expect(recipientTag(h)).toBe(t1);
    expect(recipientTag(hashEmail(RCPT2))).not.toBe(t1);
    process.env.UM_MASTER_KEY = "cd".repeat(32);
    expect(recipientTag(h)).not.toBe(t1);
  });

  it("üretim: süre varsayılan 180 gün, üst sınır 400 gün; alıcı yok/silinmiş/bilinmeyen kayıt reddedilir", async () => {
    await ensureSigningKey(db, NOW);
    const m = await mint();
    expect(m.expiresAt - NOW).toBeGreaterThanOrEqual(180 * 86_400_000 - 1000);
    expect(m.expiresAt - NOW).toBeLessThanOrEqual(180 * 86_400_000 + 1000);
    const capped = await mint(a, { ttlMs: 5 * MAX_TTL_MS });
    expect(capped.expiresAt - NOW).toBeLessThanOrEqual(MAX_TTL_MS + 1000);
    await expect(mintUnsubscribeToken(db, { campaignLeadId: 99999 })).rejects.toMatchObject({
      code: "lead_not_found",
    });
    await db
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: null, redactedAt: NOW })
      .where(eq(campaignLeads.id, b.cl));
    await expect(mint(b)).rejects.toBeInstanceOf(MintError);
    await expect(mint(b)).rejects.toMatchObject({ code: "no_recipient" });
  });

  it("bağlantı yalnızca güvenli HTTPS tabanıyla kurulur", async () => {
    expect(buildUnsubscribeUrl(BASE, "u2.x.y")).toBe(`${BASE}/u/u2.x.y`);
    for (const bad of [
      "http://cikis.example.test",
      "https://u:p@cikis.example.test",
      "https://cikis.example.test/yol",
      "https://cikis.example.test/?q=1",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(() => buildUnsubscribeUrl(bad, "t"), bad).toThrow();
    }
  });
});

describe("olay işleme: mevcut suppression ve denetim sistemiyle entegrasyon", () => {
  beforeEach(async () => {
    await ensureSigningKey(db, NOW);
  });

  it("uçtan uca: aktarıcı POST → kuyruk → işleme: suppression, dizi durur, denetim kaydı, gelen kayıt", async () => {
    const queue = new MemoryEventQueue();
    const relay = createRelayHandler({
      keys: () => loadPublicKeys(db),
      sink: queue,
      now: () => NOW + 1000,
    });
    const { token } = await mint();
    const res = await relay(
      new Request(buildUnsubscribeUrl(BASE, token), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(res.status).toBe(200);
    expect(queue.events).toHaveLength(1);
    const r = await ingest(queue.events[0]);
    expect(r).toEqual({ outcome: "unsubscribed", stopped: 1, suppression: "added" });

    const sup = await suppressed();
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      reason: "unsubscribe",
      source: "link",
      emailHash: hashEmail(RCPT),
    });
    expect(await clStatus(a)).toBe("unsubscribed");
    expect(await clStatus(b)).toBe("waiting_next"); // başka alıcı etkilenmez
    const [row] = await inbound();
    expect(row).toMatchObject({
      status: "matched",
      classification: "unsubscribe",
      campaignLeadId: a.cl,
      peerHash: hashEmail(RCPT),
    });
    const [au] = await audits("unsubscribe.one_click");
    expect(au!.detail).toMatchObject({ suppression: "added", stopped: 1, via: "one_click" });
    // denetim ve gelen kayıtta adres, belirteç yok
    const dump = JSON.stringify([
      await db.select().from(auditLog),
      await inbound(),
      await suppressed(),
    ]);
    expect(dump).not.toContain(RCPT);
    expect(dump).not.toContain(token);
  });

  it("tekrar oynatma: aynı olay ikinci kez 'duplicate'; ikinci suppression, denetim veya durdurma YOK", async () => {
    const { token } = await mint();
    expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
    const snap = await snapshot();
    expect(await ingest(evt(token))).toEqual({ outcome: "duplicate" });
    expect(await ingest(evt(token, NOW + 500), NOW + 6000)).toEqual({ outcome: "duplicate" }); // daha eski zaman
    expect(await snapshot()).toBe(snap);
    expect(await audits("unsubscribe.one_click")).toHaveLength(1);
  });

  it("aynı belirtecin daha SONRAKİ teslimatı (aktarıcı yeniden başladı) alıcı hâlâ engelliyse etkisizdir: 'already', çift suppression YOK", async () => {
    const { token } = await mint();
    expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
    expect(await ingest(evt(token, NOW + 5000), NOW + 6000)).toEqual({ outcome: "already" });
    expect(await ingest(evt(token, NOW + 5000), NOW + 7000)).toEqual({ outcome: "duplicate" }); // artık aynı zaman
    expect(await suppressed()).toHaveLength(1);
    expect(await audits("unsubscribe.one_click")).toHaveLength(1);
  });

  it("engel belgelenmiş talepte KALDIRILDIKTAN sonra: eski teslimatın tekrarı yeniden engel koymaz; alıcının YENİ tıklaması koyar", async () => {
    const { token } = await mint();
    expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
    const [sup] = await suppressed();
    await liftProtectedSuppression(
      db,
      {
        id: sup!.id,
        confirm: "ALICI_TALEBI_DOGRULANDI",
        basis: "recipient_request",
        evidenceRef: "talep-1",
        justification: "Alıcı yeniden almak istedi",
      },
      NOW + 10_000,
    );
    // aktarıcı/kuyruk aynı olayı yeniden teslim eder (aynı zaman damgası): ETKİ YOK
    expect(await ingest(evt(token), NOW + 20_000)).toEqual({ outcome: "duplicate" });
    expect((await suppressed()).filter((r) => r.liftedAt === null)).toHaveLength(0);
    // alıcı sonradan eski iletideki bağlantıya YENİDEN basar (daha geç tıklama): çıkış iradesi yok sayılmaz
    const again = await ingest(evt(token, NOW + 30_000), NOW + 31_000);
    expect(again.outcome).toBe("unsubscribed");
    expect((await suppressed()).filter((r) => r.liftedAt === null)).toHaveLength(1);
    const detail = (await audits("unsubscribe.one_click")).at(-1)!.detail as Record<
      string,
      unknown
    >;
    expect(detail.reclick).toBe(true);
    // o yeni tıklamanın da tekrarı etkisizdir
    expect(await ingest(evt(token, NOW + 30_000), NOW + 32_000)).toEqual({ outcome: "duplicate" });
    expect((await suppressed()).filter((r) => r.liftedAt === null)).toHaveLength(1);
  });

  it("yarış: aynı olayı başka bir işlem önce kaydettiyse (benzersiz dizin) 'duplicate'; etki YOK", async () => {
    const { token, jti } = await mint();
    // kazanan işlemin bıraktığı tekilleştirme kaydı
    await db.insert(messages).values({
      direction: "in",
      purpose: "inbound",
      mailboxId: 1,
      rfcMessageId: `<unsub-${jti}@unsubscribe.invalid>`,
      peerHash: hashEmail(RCPT),
      peerDomain: "alici-ornek.com",
      bodySha256: "x".repeat(64),
      status: "matched",
      classification: "unsubscribe",
      createdAt: NOW,
    });
    const snap = await snapshot();
    expect(await ingest(evt(token))).toEqual({ outcome: "duplicate" });
    expect(await snapshot()).toBe(snap); // işlem geri alındı: ne engel, ne denetim, ne durdurma
    expect(await clStatus(a)).toBe("waiting_next");
  });

  it("aynı alıcı için ikinci (farklı) belirteç: 'already', engel kopyalanmaz", async () => {
    const t1 = await mint();
    const t2 = await mint();
    expect((await ingest(evt(t1.token))).outcome).toBe("unsubscribed");
    expect(await ingest(evt(t2.token))).toEqual({ outcome: "already" });
    expect(await suppressed()).toHaveLength(1);
  });

  it("mevcut daha güçlü engel (şikâyet) zayıflatılmaz", async () => {
    await suppressEmail(db, { email: RCPT, reason: "complaint", source: "manual" }, NOW);
    const { token } = await mint();
    const r = await ingest(evt(token));
    expect(r.outcome).toBe("unsubscribed"); // dizi durdu
    const sup = await suppressed();
    expect(sup).toHaveLength(1);
    expect(sup[0]!.reason).toBe("complaint");
  });

  it("süre: tıklama anında geçerliyse işleme anında süresi dolmuş olsa da kabul; tıklama sonrası dolduysa ret", async () => {
    const short = await mint(a, { ttlMs: 10 * 60_000 });
    const clickOk = NOW + 5 * 60_000;
    const late = NOW + 3 * 86_400_000;
    expect((await ingest(evt(short.token, clickOk), late)).outcome).toBe("unsubscribed");
    const other = await mint(b, { ttlMs: 10 * 60_000 });
    const clickLate = NOW + 20 * 60_000;
    expect(await ingest(evt(other.token, clickLate), clickLate + 1000)).toEqual({
      outcome: "rejected",
      reason: "expired",
    });
    expect(await clStatus(b)).toBe("waiting_next");
  });

  it("olay zamanı yalnızca bilgilendiricidir: aktarıcı saati ilerideyse işleme anına kırpılır (geçerli çıkış isteği KAYBOLMAZ)", async () => {
    const { token } = await mint();
    // aktarıcı saati 3 saat ileri; olay reddedilip silinmemeli
    const r = await ingest(evt(token, NOW + 3 * 3600_000), NOW + 1000);
    expect(r.outcome).toBe("unsubscribed");
    expect(await suppressed()).toHaveLength(1);
    expect((await inbound())[0]!.receivedAt).toBe(NOW + 1000); // gelecek zaman işleme anına kırpıldı
  });

  it("aşırı eski olay: belirtecin süresi zaten dolmuştur → expired (kalıcı ret); süre dolmamışsa kabul", async () => {
    const { token } = await mint();
    const longAfter = NOW + MAX_EVENT_AGE_MS + 10 * 86_400_000;
    expect(await ingest(evt(token, NOW + 1000), longAfter)).toEqual({
      outcome: "unsubscribed",
      stopped: 1,
      suppression: "added",
    });
    const t2 = await mint(b);
    // tıklama anı 401 günden eski değil ama olay işleme çok geç: tıklama anına göre geçerli → kabul (çıkış kaybolmaz)
    expect((await ingest(evt(t2.token, NOW + 2000), longAfter)).outcome).toBe("unsubscribed");
  });

  it("kalıcı ret sessiz kayıp DEĞİLDİR: drain, ret nedenini (kişisel veri olmadan) denetime yazar", async () => {
    const src = {
      acked: [] as string[],
      pull: async () =>
        src.acked.length > 0
          ? []
          : [{ id: "1700000000000-aaaaaaaaaaaaaaaa", event: evt("garbage") }],
      ack: async (ids: string[]) => void src.acked.push(...ids),
    };
    const s = await drainUnsubscribeEvents(
      db,
      { pull: src.pull, ack: src.ack },
      { now: () => NOW + 2000 },
    );
    expect(s).toMatchObject({ rejected: 1, error: null });
    const [row] = await audits("unsubscribe.event_rejected");
    expect(row!.detail).toEqual({ reason: "invalid_token" });
    expect(row!.entityId).toBe("1700000000000-aaaaaaaaaaaaaaaa");
    expect(JSON.stringify(row)).not.toContain("garbage");
  });

  it("yanlış ileti: ileti başka alıcıya ait / yok → ret, HİÇBİR engel veya durdurma yok", async () => {
    // ileti başka alıcının iletisi
    const wrongMsg = await mint(a, { messageId: b.outboundId });
    expect(await ingest(evt(wrongMsg.token))).toEqual({
      outcome: "rejected",
      reason: "message_mismatch",
    });
    // var olmayan ileti
    const noMsg = await mint(a, { messageId: 999_999 });
    expect(await ingest(evt(noMsg.token))).toEqual({
      outcome: "rejected",
      reason: "message_mismatch",
    });
    expect(await suppressed()).toHaveLength(0);
    expect(await clStatus(a)).toBe("waiting_next");
    expect(await clStatus(b)).toBe("waiting_next");
    expect((await audits("unsubscribe.rejected")).length).toBe(2);
    expect(await inbound()).toHaveLength(0); // ret, tekrar oynatma kaydı da bırakmaz
  });

  describe("alıcı etiketi uyuşmazlığı (C5: ana anahtar değişti): çıkış KAYBOLMAZ", () => {
    const changeMasterKey = () => {
      process.env.UM_MASTER_KEY = "cd".repeat(32);
    };

    it("imza geçerli, etiket eski ana anahtarla: çıkış güncel alıcıya uygulanır, uyuşmazlık denetime yazılır", async () => {
      const { token } = await mint();
      changeMasterKey();
      expect(await ingest(evt(token))).toEqual({
        outcome: "unsubscribed",
        stopped: 1,
        suppression: "added",
      });
      const sup = await suppressed();
      expect(sup).toHaveLength(1);
      expect(sup[0]).toMatchObject({
        reason: "unsubscribe",
        source: "link",
        emailHash: hashEmail(RCPT),
      });
      expect(await clStatus(a)).toBe("unsubscribed");
      expect(await clStatus(b)).toBe("waiting_next"); // başka alıcı etkilenmez
      expect(await audits("unsubscribe.rejected")).toHaveLength(0);
      const mm = await audits("unsubscribe.recipient_tag_mismatch");
      expect(mm).toHaveLength(1);
      expect(mm[0]).toMatchObject({ entity: "campaign_lead", entityId: String(a.cl) });
      expect(mm[0]!.detail).toEqual({
        kid: expect.any(String),
        applied: true,
        messagePeerMatch: true,
      });
      const [oc] = await audits("unsubscribe.one_click");
      expect(oc!.detail).toMatchObject({ suppression: "added", recipientTagMismatch: true });
      // denetimde adres veya belirteç yok
      const dump = JSON.stringify(await db.select().from(auditLog));
      expect(dump).not.toContain(RCPT);
      expect(dump).not.toContain(token);
    });

    it("etiket uyuşuyorsa uyuşmazlık kaydı yazılmaz ve tek-tık denetiminde işaret yoktur", async () => {
      const { token } = await mint();
      expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
      expect(await audits("unsubscribe.recipient_tag_mismatch")).toHaveLength(0);
      const [oc] = await audits("unsubscribe.one_click");
      expect(oc!.detail).not.toHaveProperty("recipientTagMismatch");
    });

    it("tekrar oynatma: ikinci teslimat 'duplicate'; ikinci engel veya uyuşmazlık kaydı YOK", async () => {
      const { token } = await mint();
      changeMasterKey();
      expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
      const snap = await snapshot();
      expect(await ingest(evt(token))).toEqual({ outcome: "duplicate" });
      expect(await snapshot()).toBe(snap);
      expect(await audits("unsubscribe.recipient_tag_mismatch")).toHaveLength(1);
    });

    it("ileti bağı olmayan belirteç: yine uygulanır; ek kanıt yok (messagePeerMatch null)", async () => {
      const { token } = await mint(a, { messageId: null });
      changeMasterKey();
      expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
      const [mm] = await audits("unsubscribe.recipient_tag_mismatch");
      expect(mm!.detail).toMatchObject({ applied: true, messagePeerMatch: null });
    });

    it("kayıttaki alıcı özeti değişmişse çıkış imzalı belirtecin gösterdiği kaydın GÜNCEL alıcısına uygulanır (kısıtlayıcı yön)", async () => {
      const t = await mint();
      const other = "baska@baska-alan.com";
      await db
        .update(campaignLeads)
        .set({ recipientHash: hashEmail(other), recipientEmail: other })
        .where(eq(campaignLeads.id, a.cl));
      expect((await ingest(evt(t.token))).outcome).toBe("unsubscribed");
      const sup = await suppressed();
      expect(sup).toHaveLength(1);
      expect(sup[0]!.emailHash).toBe(hashEmail(other));
      const [mm] = await audits("unsubscribe.recipient_tag_mismatch");
      // giden iletinin alıcı özeti artık kayıttakiyle aynı değil: denetimde görünür
      expect(mm!.detail).toMatchObject({ applied: true, messagePeerMatch: false });
    });

    it("diğer ret yolları değişmez: ana anahtar değişse de yanlış ileti reddedilir", async () => {
      const wrongMsg = await mint(a, { messageId: b.outboundId });
      changeMasterKey();
      expect(await ingest(evt(wrongMsg.token))).toEqual({
        outcome: "rejected",
        reason: "message_mismatch",
      });
      expect(await suppressed()).toHaveLength(0);
      expect(await audits("unsubscribe.recipient_tag_mismatch")).toHaveLength(0);
    });

    it("silinmiş alıcı: etiket uyuşmasa da 'already'; engel veya uyuşmazlık kaydı YOK", async () => {
      const t = await mint(b);
      changeMasterKey();
      await db
        .update(campaignLeads)
        .set({ recipientEmail: null, recipientHash: null, redactedAt: NOW })
        .where(eq(campaignLeads.id, b.cl));
      expect(await ingest(evt(t.token))).toEqual({ outcome: "already" });
      expect(await suppressed()).toHaveLength(0);
      expect(await audits("unsubscribe.recipient_tag_mismatch")).toHaveLength(0);
    });
  });

  it("bilinmeyen kampanya alıcısı ve silinmiş alıcı", async () => {
    // imzalı ama kayıt yok: önce belirteci üretip kaydı sonra sil
    const t = await mint(b);
    await db
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: null, redactedAt: NOW })
      .where(eq(campaignLeads.id, b.cl));
    expect(await ingest(evt(t.token))).toEqual({ outcome: "already" });
    expect(await suppressed()).toHaveLength(0);
    // kayıt hiç yok
    const t2 = await mint(a);
    await db.delete(messages).where(eq(messages.campaignLeadId, a.cl));
    await db.delete(campaignLeads).where(eq(campaignLeads.id, a.cl));
    expect(await ingest(evt(t2.token))).toEqual({ outcome: "rejected", reason: "lead_not_found" });
  });

  it("sahte ve bozuk olaylar: hiçbir veritabanı değişikliği yapılmaz", async () => {
    const { token } = await mint();
    const snap = await snapshot();
    const [p, pl, sg] = token.split(".") as [string, string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(pl, "base64url").toString()), c: b.cl }),
    ).toString("base64url");
    const bad: [unknown, string][] = [
      [null, "invalid_event"],
      ["x", "invalid_event"],
      [{}, "invalid_event"],
      [{ ...evt(token), extra: 1 }, "invalid_event"],
      [{ ...evt(token), via: "form" }, "invalid_event"],
      [{ ...evt(token), v: 2 }, "invalid_event"],
      [{ ...evt(token), receivedAt: "1" }, "invalid_event"],
      [{ ...evt(token), token: 5 }, "invalid_event"],
      [{ ...evt(token), token: "x".repeat(800) }, "invalid_event"],
      [evt("garbage"), "invalid_token"],
      [evt(`${p}.${tampered}.${sg}`), "invalid_token"],
      [
        evt(`${p}.${pl}.${sg.slice(0, 10)}${sg[10] === "A" ? "B" : "A"}${sg.slice(11)}`),
        "invalid_token",
      ], // 11. karakter kesin farklı: rastgele eşleşme yok
    ];
    for (const [e, reason] of bad) {
      expect(await ingest(e), JSON.stringify(e).slice(0, 60)).toEqual({
        outcome: "rejected",
        reason,
      });
    }
    expect(await snapshot()).toBe(snap);
  });

  it("farklı posta kutusunda/başka kampanyada aynı alıcı: dizisi de durur (yalnızca o alıcı)", async () => {
    const c2 = await createCampaign(db, { status: "running" });
    // aynı alıcının ikinci kampanyadaki dizisi (aynı özet)
    const dup = await seedSent(db, c2, {
      email: RCPT,
      sentAt: a.outboundId ? NOW - 2 * 86_400_000 : NOW,
    });
    const { token } = await mint();
    const r = await ingest(evt(token));
    expect(r.outcome).toBe("unsubscribed");
    expect(await clStatus(a)).toBe("unsubscribed");
    expect(await clStatus(dup)).toBe("unsubscribed");
    expect(await clStatus(b)).toBe("waiting_next");
  });

  it("canlı olmayan/demo ayrımı yok: çıkış her kapsamda geçerlidir (kısıtlayıcı yön); canlı gönderim bayrağına bağlı değil", async () => {
    const { token } = await mint();
    expect((await ingest(evt(token))).outcome).toBe("unsubscribed");
  });
});

describe("olay kuyruğunu boşaltma (drain)", () => {
  class MemSource implements UnsubscribeEventSource {
    acked: string[] = [];
    constructor(public items: { id: string; event: unknown }[]) {}
    async pull(limit: number) {
      return this.items.filter((i) => !this.acked.includes(i.id)).slice(0, limit);
    }
    async ack(ids: string[]) {
      this.acked.push(...ids);
    }
  }
  beforeEach(async () => {
    await ensureSigningKey(db, NOW);
  });

  it("geçerli, tekrar ve bozuk olaylar işlenir ve onaylanır (bozuk olay kuyruğu tıkamaz)", async () => {
    const t1 = await mint(a);
    const t2 = await mint(b);
    const src = new MemSource([
      { id: "1", event: evt(t1.token) },
      { id: "2", event: evt(t1.token) }, // tekrar
      { id: "3", event: { zehir: true } }, // bozuk
      { id: "4", event: evt(t2.token) },
    ]);
    const s = await drainUnsubscribeEvents(db, src, { now: () => NOW + 2000 });
    expect(s).toMatchObject({
      pulled: 4,
      unsubscribed: 2,
      duplicates: 1,
      rejected: 1,
      error: null,
    });
    expect(src.acked.sort()).toEqual(["1", "2", "3", "4"]);
    expect(await suppressed()).toHaveLength(2);
  });

  it("ana anahtar değişmiş olsa da çıkış olayı uygulanır ve ancak SONRA onaylanır (ret/kayıp yok)", async () => {
    const t1 = await mint(a);
    process.env.UM_MASTER_KEY = "cd".repeat(32);
    const src = new MemSource([{ id: "1", event: evt(t1.token) }]);
    const s = await drainUnsubscribeEvents(db, src, { now: () => NOW + 2000 });
    expect(s).toMatchObject({ pulled: 1, unsubscribed: 1, rejected: 0, error: null });
    expect(src.acked).toEqual(["1"]);
    expect(await suppressed()).toHaveLength(1);
    expect(await clStatus(a)).toBe("unsubscribed");
    expect(await audits("unsubscribe.event_rejected")).toHaveLength(0);
  });

  it("altyapı hatasında olay onaylanmaz; sonraki turda yeniden çekilir ve çift etki oluşmaz", async () => {
    const t1 = await mint(a);
    const t2 = await mint(b);
    const src = new MemSource([
      { id: "1", event: evt(t1.token) },
      { id: "2", event: evt(t2.token) },
    ]);
    const original = db.transaction.bind(db);
    let calls = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(((fn: never, cfg: never) => {
      calls++;
      if (calls === 2) return Promise.reject(new Error("db down"));
      return original(fn, cfg);
    }) as never);
    const s1 = await drainUnsubscribeEvents(db, src, { now: () => NOW + 2000 });
    spy.mockRestore();
    expect(s1.error).toBe("ingest_failed");
    expect(src.acked).toEqual(["1"]); // ikincisi onaylanmadı
    expect(await suppressed()).toHaveLength(1);
    const s2 = await drainUnsubscribeEvents(db, src, { now: () => NOW + 3000 });
    expect(s2).toMatchObject({ error: null, unsubscribed: 1, pulled: 1 });
    expect(await suppressed()).toHaveLength(2);
  });

  it("onay başarısız olursa olay yeniden çekilir; tekilleştirme çift etkiyi önler", async () => {
    const t1 = await mint(a);
    const src = new MemSource([{ id: "1", event: evt(t1.token) }]);
    const realAck = src.ack.bind(src);
    src.ack = async () => {
      throw new Error("ack down");
    };
    await expect(drainUnsubscribeEvents(db, src, { now: () => NOW + 2000 })).rejects.toThrow(
      "ack down",
    );
    src.ack = realAck;
    const s = await drainUnsubscribeEvents(db, src, { now: () => NOW + 3000 });
    expect(s).toMatchObject({ duplicates: 1, unsubscribed: 0 });
    expect(await suppressed()).toHaveLength(1);
    expect(await audits("unsubscribe.one_click")).toHaveLength(1);
  });
});

describe("gizli bilgi sızıntısı yok", () => {
  it("özel anahtar, belirteç ve düz adres; ayarlar/denetim/gelen/engel tablolarında bulunmaz", async () => {
    const k = await ensureSigningKey(db, NOW);
    const { token } = await mint();
    await ingest(evt(token));
    const tables = ["settings", "audit_log", "suppressions"];
    let dump = "";
    for (const t of tables)
      dump += JSON.stringify((await client.execute(`SELECT * FROM "${t}"`)).rows);
    dump += JSON.stringify(
      (await client.execute("SELECT * FROM messages WHERE direction='in'")).rows,
    );
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(RCPT);
    expect(dump).not.toContain(RCPT2);
    const secretsFile = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(secretsFile).toContain(unsubscribeKeySecretName(k.kid));
    // gizli dosyada şifrelenmiş: PKCS8 başlığı (MC4CAQAw...) düz metin olarak yok
    expect(secretsFile).not.toContain("MC4CAQAw");
    void and;
  });
});
