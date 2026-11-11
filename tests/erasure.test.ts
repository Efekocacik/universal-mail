import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as erasureRoute from "@/app/api/compliance/erasure/route";
import * as previewRoute from "@/app/api/compliance/erasure/preview/route";
import * as readinessRoute from "@/app/api/compliance/live-readiness/route";
import { listAudit } from "@/lib/audit-list";
import {
  completePendingErasures,
  ErasureError,
  executeErasure,
  listErasureHistory,
  listPendingErasures,
  previewErasure,
  type ErasureInput,
} from "@/lib/compliance/erasure";
import { getLiveReadiness } from "@/lib/compliance/live-readiness";
import { LEGAL_APPROVALS } from "@/lib/compliance/legal-status";
import { listSuppressions } from "@/lib/compliance/suppression-list";
import { checkSuppression, hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { exportLeadsCsv } from "@/lib/export/csv";
import {
  campaignLeads,
  leadEmails,
  leads,
  messages,
  places,
  settings,
  suppressions,
} from "@/lib/db/schema";
import { computeMailboxStats } from "@/lib/mail/mailbox-health";
import { exportMailLogCsv, listMailLog } from "@/lib/mail/mail-log";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { addMailbox, NOW, seedSent } from "./helpers/inbound-fixture";

/**
 * Silme talebi (Aşama 14): güvenle silinenler, hukuki değerlendirme bekleyenler, kişisel bilgi sızıntısı, yer tutucu
 * güvenliği, idempotens ve geri alınamaz işlem korumaları. Bellek içi veritabanı; gerçek `.data` açılmaz.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;
let campaignId: number;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

const REQUESTED = NOW - 3_600_000;
const input = (email: string, extra: Partial<ErasureInput> = {}): ErasureInput => ({
  email,
  requestedAt: REQUESTED,
  justification: "Alıcı yazılı olarak silme talep etti.",
  confirm: true,
  ...extra,
});
const run = (
  email: string,
  extra: Partial<ErasureInput> = {},
  opts: Parameters<typeof executeErasure>[2] = {},
) => executeErasure(db, input(email, extra), { now: NOW, ...opts });

/** Bütün tabloların ham dökümü (sızıntı taraması için). */
async function dumpAll(): Promise<string> {
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const out: string[] = [];
  for (const r of tables.rows) {
    const name = String(r.name);
    const rows = await client.execute(`SELECT * FROM "${name}"`);
    out.push(JSON.stringify({ [name]: rows.rows.map((row) => Object.values(row)) }));
  }
  return out.join("\n");
}

/** Lead CSV dışa aktarması `places` ve ayrı önbellek tablosuna (`place_cache`) bağlanır; bellek içi eşdeğerini kurar. */
async function attachPlace(leadId: number): Promise<void> {
  await client.execute(
    "CREATE TABLE IF NOT EXISTS place_cache (place_id TEXT PRIMARY KEY, name TEXT, formatted_address TEXT, primary_type TEXT, types TEXT, business_status TEXT, opening_date TEXT, website TEXT, phone TEXT, intl_phone TEXT, user_rating_count INTEGER, fetched_at INTEGER, enriched_at INTEGER)",
  );
  const placeId = `place-${leadId}`;
  await db.insert(places).values({
    placeId,
    source: "demo",
    coordsFetchedAt: NOW,
    firstSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.update(leads).set({ placeId }).where(eq(leads.id, leadId));
}

async function target() {
  const s = await seedSent(db, campaignId);
  await seedSent(db, campaignId, { clId: s.cl, leadId: s.leadId, email: s.email, step: 1 });
  return s;
}

describe("önizleme", () => {
  it("yalnızca sayılar döner; adres yankılanmaz; hiçbir şey değişmez", async () => {
    const s = await target();
    const before = await dumpAll();
    const p = await previewErasure(db, s.email);
    expect(p.safe).toMatchObject({ leadEmails: 1, sequences: 1, messages: 2, leads: 1 });
    expect(p.pending).toEqual({ sequences: 0, messages: 0 });
    expect(JSON.stringify(p)).not.toContain(s.email);
    expect(await dumpAll()).toBe(before);
  });
  it("geçersiz adres reddedilir", async () => {
    await expect(previewErasure(db, "adres değil")).rejects.toMatchObject({
      kind: "invalid_email",
    });
  });
});

describe("güvenle silinenler (demo kayıtları)", () => {
  it("adres hiçbir tabloda kalmaz; kişinin kayıtları aynı rastgele yer tutucuyu alır; başkası etkilenmez", async () => {
    const s = await target();
    const other = await seedSent(db, campaignId);
    const r = await run(s.email);
    expect(r.cleared).toMatchObject({ leadEmails: 1, sequences: 1, messages: 2 });
    expect(r.pending).toEqual({ sequences: 0, messages: 0 });
    // Sahip kararıyla (11 Kasım 2026) özet saklamanın dayanağı kayıtlı: "bekliyor" değil.
    expect(r.suppressionRetentionPendingLegal).toBe(false);

    const dump = await dumpAll();
    expect(dump).not.toContain(s.email);
    expect(dump).not.toContain(s.email.split("@")[0]!.toUpperCase());
    expect(dump).toContain(other.email); // başka alıcı dokunulmadı

    const msgs = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
    const hashes = new Set(msgs.map((m) => m.peerHash));
    expect(hashes.size).toBe(1);
    const ph = [...hashes][0]!;
    expect(ph).toMatch(/^[0-9a-f]{64}$/);
    expect(ph).not.toBe(hashEmail(s.email));
    expect(ph).not.toBe(hashEmail(other.email));
    for (const m of msgs)
      expect(m).toMatchObject({
        toAddress: null,
        fromAddress: null,
        subjectLogged: null,
        errorMessage: null,
        redactedAt: NOW,
      });

    const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    expect(cl).toMatchObject({
      recipientEmail: null,
      recipientHash: ph,
      redactedAt: NOW,
      status: "cancelled",
    });
    const [oc] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, other.cl));
    expect(oc!.recipientEmail).toBe(other.email);
    const [lead] = await db.select().from(leads).where(eq(leads.id, s.leadId));
    expect(lead!.status).toBe("do_not_contact");
    expect(await db.select().from(leadEmails).where(eq(leadEmails.email, s.email))).toHaveLength(0);
  });

  it("yer tutucu başka alıcıyla eşleşmez; iki talep farklı yer tutucu üretir; alıcı sayımı tutarlı kalır", async () => {
    const a = await target();
    const b = await target();
    const before = await computeMailboxStats(db, DEMO_MAILBOX, NOW);
    await run(a.email);
    await run(b.email);
    const phA = (await db.select().from(messages).where(eq(messages.campaignLeadId, a.cl)))[0]!
      .peerHash;
    const phB = (await db.select().from(messages).where(eq(messages.campaignLeadId, b.cl)))[0]!
      .peerHash;
    expect(phA).not.toBe(phB);
    expect(await computeMailboxStats(db, DEMO_MAILBOX, NOW)).toEqual(before); // 2 alıcı, her biri 2 ileti → yine 2
    expect(before.recipients).toBe(2);
  });

  it("engel kaydı kalır ve kişiye yeniden iletişimi engeller; maskeli adres tutulmaz", async () => {
    const s = await target();
    await run(s.email);
    const chk = await checkSuppression(db, s.email);
    expect(chk.suppressed).toBe(true);
    const [sup] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.emailHash, hashEmail(s.email)));
    expect(sup).toMatchObject({ reason: "erasure", emailMasked: null, note: null });
  });

  it("notlar: varsayılan olarak korunur ve adres geçiyorsa bildirilir; 'temizle' tüm notları siler", async () => {
    const s = await target();
    await db
      .update(leads)
      .set({ notes: `Yetkili ${s.email.toUpperCase()} ile görüşüldü` })
      .where(eq(leads.id, s.leadId));
    const kept = await run(s.email);
    expect(kept.notesCleared).toBe(0);
    expect(kept.cleared.notesMentions).toBe(1);
    expect((await db.select().from(leads).where(eq(leads.id, s.leadId)))[0]!.notes).toContain(
      "görüşüldü",
    );

    const s2 = await target();
    await db
      .update(leads)
      .set({ notes: `başka not ${s2.email}` })
      .where(eq(leads.id, s2.leadId));
    const cleared = await run(s2.email, { clearNotes: true });
    expect(cleared.notesCleared).toBe(1);
    expect((await db.select().from(leads).where(eq(leads.id, s2.leadId)))[0]!.notes).toBeNull();
  });

  it("idempotent: ikinci çalıştırma veri bulmaz, engel 'existing' kalır", async () => {
    const s = await target();
    await run(s.email);
    const again = await run(s.email);
    expect(again.cleared).toMatchObject({ leadEmails: 0, sequences: 0, messages: 0 });
    expect(again.suppression).toBe("existing");
    expect(
      await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.emailHash, hashEmail(s.email))),
    ).toHaveLength(1);
  });
});

describe("sızıntı: API, arayüz verisi ve dışa aktarma", () => {
  it("silme sonrası lead CSV, günlük, işlem kaydı ve engel listesi adres içermez", async () => {
    const s = await target();
    await db
      .update(leads)
      .set({ notes: `görüşme ${s.email}`, tags: ["a"] })
      .where(eq(leads.id, s.leadId));
    await attachPlace(s.leadId);
    // Kontrol: silmeden ÖNCE dışa aktarma gerçekten adresi içerir (test boş geçmesin).
    let pre = "";
    for await (const c of exportLeadsCsv(db, {}, { includeGoogleFields: false })) pre += c;
    expect(pre).toContain(s.email);
    await run(s.email, { clearNotes: true });

    let csv = "";
    for await (const c of exportLeadsCsv(db, {}, { includeGoogleFields: false })) csv += c;
    expect(csv).not.toContain(s.email);
    expect(csv).not.toContain(hashEmail(s.email));

    let log = "";
    for await (const c of exportMailLogCsv(db, {})) log += c;
    expect(log).not.toContain(s.email);
    expect(log).not.toMatch(/\*\*\*@/); // silinmiş satırlarda maskeli adres bile yok
    const list = JSON.stringify(await listMailLog(db, {}));
    expect(list).not.toContain(s.email);

    const audit = JSON.stringify((await listAudit(db, {}, { limit: 200 })).items);
    expect(audit).not.toContain(s.email);
    expect(audit).not.toContain(hashEmail(s.email));
    expect(audit).toContain("erasure.executed");

    const sup = JSON.stringify(await listSuppressions(db, { state: "active" }));
    expect(sup).not.toContain(s.email);
    expect(sup).not.toContain(hashEmail(s.email));

    const hist = JSON.stringify(await listErasureHistory(db));
    expect(hist).not.toContain(s.email);
  });

  it("silme işleminin kendi denetim kaydı adres, özet veya yer tutucu içermez", async () => {
    const s = await target();
    await run(s.email);
    const raw = JSON.stringify(await client.execute("SELECT * FROM audit_log").then((r) => r.rows));
    expect(raw).not.toContain(s.email);
    expect(raw).not.toContain(hashEmail(s.email));
    const ph = (await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl)))[0]!
      .peerHash;
    expect(raw).not.toContain(ph);
  });
});

describe("hukuki değerlendirme bekleyenler (gerçek posta kutusundan iletilmiş kayıtlar)", () => {
  // Bu sürümde `erasureOfTransmissionRecords` sahip kararıyla `true`'dur. Onaysız bir sürümün davranışı (kayıtlar
  // korunur, "bekliyor") parametreyle (`transmissionRecordsApproved: false`) simüle edilerek korunur.
  const UNAPPROVED = { transmissionRecordsApproved: false } as const;
  async function liveCase() {
    const live = await addMailbox(db, { provider: "gmail", address: "canli@firma.example" });
    const s = await seedSent(db, campaignId, { mailboxId: live });
    return { s, live };
  }

  it("onay yokken (simüle) DOKUNULMAZ ve 'bekliyor' olarak bildirilir; güvenle yapılabilenler yine yapılır", async () => {
    const { s } = await liveCase();
    const p = await previewErasure(db, s.email, UNAPPROVED);
    expect(p.transmissionRecordsApproved).toBe(false);
    expect(p.pending).toEqual({ sequences: 1, messages: 1 });
    expect(p.safe.messages).toBe(0);

    const r = await run(s.email, {}, UNAPPROVED);
    expect(r.pending).toEqual({ sequences: 1, messages: 1 });
    expect(r.cleared).toMatchObject({ leadEmails: 1, messages: 0, sequences: 0 });
    const [m] = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
    expect(m).toMatchObject({ toAddress: s.email, peerHash: hashEmail(s.email), redactedAt: null });
    const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    expect(cl).toMatchObject({ recipientEmail: s.email, redactedAt: null, status: "cancelled" }); // iletişim durdu
    expect(await db.select().from(leadEmails).where(eq(leadEmails.email, s.email))).toHaveLength(0);
    expect((await checkSuppression(db, s.email)).suppressed).toBe(true);
    expect(await listPendingErasures(db, UNAPPROVED)).toMatchObject({
      messages: 1,
      sequences: 1,
      transmissionRecordsApproved: false,
    });
    const hist = await listErasureHistory(db);
    expect(hist[0]).toMatchObject({ pending: 2 });
  });

  it("kullanıcının beyanı onay yerine geçmez: girdide böyle bir alan yoktur ve bekleyen tamamlanamaz", async () => {
    const { s } = await liveCase();
    await run(s.email, {}, UNAPPROVED);
    await expect(completePendingErasures(db, { now: NOW, ...UNAPPROVED })).rejects.toMatchObject({
      kind: "not_approved",
    });
    const res = await erasureRoute.POST(
      new Request(`${ORIGIN}/api/compliance/erasure`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          ...input(s.email),
          noRetentionObligation: true,
          legalApproved: true,
        }),
      }),
      undefined,
    );
    expect(res.status).toBe(400); // katı şema: bilinmeyen alan reddedilir
    expect((await listPendingErasures(db, UNAPPROVED)).messages).toBe(1);
  });

  it("onaysız sürümde biriken bekleyenler onaylı sürümde kişi bazında tamamlanır", async () => {
    const { s } = await liveCase();
    await run(s.email, {}, UNAPPROVED);
    const done = await completePendingErasures(db, {
      now: NOW + 1,
      transmissionRecordsApproved: true,
    });
    expect(done).toEqual({ messages: 1, sequences: 1 });
    expect(await listPendingErasures(db, { transmissionRecordsApproved: true })).toMatchObject({
      messages: 0,
      sequences: 0,
    });
    const dump = await dumpAll();
    expect(dump).not.toContain(s.email);
    const [m] = await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl));
    expect(m!.peerHash).not.toBe(hashEmail(s.email));
  });

  it("onay varsa ilk çalıştırmada her şey güvenle yapılır", async () => {
    const { s } = await liveCase();
    const r = await run(s.email, {}, { transmissionRecordsApproved: true });
    expect(r.pending).toEqual({ sequences: 0, messages: 0 });
    expect(r.cleared).toMatchObject({ messages: 1, sequences: 1 });
    expect(await dumpAll()).not.toContain(s.email);
  });

  it("bu sürümde onay sabitleri sahip kararıyla açıktır: varsayılan çalıştırma kayıtları ilk seferde temizler", async () => {
    expect(Object.values(LEGAL_APPROVALS).every((v) => v === true)).toBe(true);
    const { s } = await liveCase();
    expect((await previewErasure(db, s.email)).transmissionRecordsApproved).toBe(true);
    const r = await run(s.email);
    expect(r.pending).toEqual({ sequences: 0, messages: 0 });
    expect(r.cleared).toMatchObject({ messages: 1, sequences: 1 });
    expect(await dumpAll()).not.toContain(s.email);
    expect(await listPendingErasures(db)).toMatchObject({ messages: 0, sequences: 0 });
    expect(await completePendingErasures(db, { now: NOW + 1 })).toEqual({
      messages: 0,
      sequences: 0,
    });
  });
});

describe("geri alınamaz işlem korumaları", () => {
  it("onay, gerekçe, talep tarihi ve adres doğrulanır; gönderim sürüyorsa reddedilir", async () => {
    const s = await target();
    const bad = async (extra: Partial<ErasureInput>) =>
      ((await run(s.email, extra).catch((e: unknown) => e)) as ErasureError).kind;
    expect(await bad({ confirm: false })).toBe("unconfirmed");
    expect(await bad({ justification: "kısa" })).toBe("invalid_input");
    expect(await bad({ requestedAt: NOW + 1000 })).toBe("invalid_input");
    expect(await bad({ requestedAt: 1.5 })).toBe("invalid_input");
    expect(await bad({ email: "yok" })).toBe("invalid_email");
    await db.update(campaignLeads).set({ status: "in_flight" }).where(eq(campaignLeads.id, s.cl));
    expect(await bad({})).toBe("in_flight");
    // Reddedilen işlemler hiçbir şey değiştirmemiş olmalı.
    expect(await dumpAll()).toContain(s.email);
    expect(
      await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.emailHash, hashEmail(s.email))),
    ).toHaveLength(0);
  });

  it("72 saati aşan talep işaretlenir", async () => {
    const s = await target();
    const r = await run(s.email, { requestedAt: NOW - 73 * 3_600_000 });
    expect(r.overdue).toBe(true);
    expect((await listErasureHistory(db))[0]).toMatchObject({ overdue: true });
    const s2 = await target();
    expect((await run(s2.email, { requestedAt: NOW - 71 * 3_600_000 })).overdue).toBe(false);
  });
});

describe("API uçları", () => {
  const post = (
    url: string,
    route: { POST: (r: Request, c: unknown) => Promise<Response> },
    body: unknown,
  ) =>
    route.POST(
      new Request(`${ORIGIN}${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }),
      undefined,
    );

  it("önizleme adresi yankılamaz; silme onay ister; kullanım onayı yoksa reddedilir", async () => {
    const s = await target();
    const pr = await post("/api/compliance/erasure/preview", previewRoute, { email: s.email });
    const text = await pr.text();
    expect(pr.status).toBe(200);
    expect(text).not.toContain(s.email);
    expect(
      (await post("/api/compliance/erasure", erasureRoute, { ...input(s.email), confirm: false }))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/compliance/erasure/preview", previewRoute, { email: s.email, extra: 1 }))
        .status,
    ).toBe(400);

    await db.delete(settings).where(eq(settings.key, "consent"));
    expect(
      (await post("/api/compliance/erasure", erasureRoute, input(s.email))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await dumpAll()).toContain(s.email);
  });

  it("başarılı silme yanıtı adres içermez ve bekleyenleri bildirir", async () => {
    const s = await target();
    const res = await post("/api/compliance/erasure", erasureRoute, input(s.email));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(s.email);
    expect(JSON.parse(text)).toMatchObject({
      pending: { sequences: 0, messages: 0 },
      suppressionRetentionPendingLegal: false,
    });
    const g = await erasureRoute.GET(new Request(`${ORIGIN}/api/compliance/erasure`), undefined);
    const gt = await g.text();
    expect(gt).not.toContain(s.email);
    expect(JSON.parse(gt).history).toHaveLength(1);
  });
});

describe("canlı gönderime hazırlık (salt okunur)", () => {
  it("varsayılan durumda kod kapıları ve sahip kararları 'tamam'; çalışma anı maddeleri engel veya 'bilinmiyor'", async () => {
    const r = await getLiveReadiness(db);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i.status]));
    expect(r.allOk).toBe(false);
    expect(r.liveSendingEnabled).toBe(true);
    expect(by).toMatchObject({
      live_flag: "ok",
      consent: "ok",
      company_profile: "ok",
      real_mailbox: "blocked",
      dns_auth: "unknown",
      https_unsubscribe: "blocked",
      live_country_policies: "blocked",
      legal_lia: "ok",
      legal_uyum: "ok",
      legal_live_countries: "ok",
      legal_erasure_records: "ok",
      legal_suppression_hash: "ok",
      pilot: "unknown",
    });
  });

  it("gerçek posta kutusu bağlansa ve onay silinse bile gerçek duruma bakar; hepsi tamam olmaz", async () => {
    await addMailbox(db, { provider: "gmail", address: "canli@firma.example" });
    await db.delete(settings).where(eq(settings.key, "consent"));
    const r = await getLiveReadiness(db);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i.status]));
    expect(by.real_mailbox).toBe("ok");
    expect(by.consent).toBe("blocked");
    expect(r.allOk).toBe(false);
  });

  it("API salt okunurdur (yalnızca GET)", async () => {
    expect((readinessRoute as Record<string, unknown>).POST).toBeUndefined();
    expect((readinessRoute as Record<string, unknown>).PATCH).toBeUndefined();
    const res = await readinessRoute.GET(
      new Request(`${ORIGIN}/api/compliance/live-readiness`),
      undefined,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).allOk).toBe(false);
  });
});
