import type { Client } from "@libsql/client";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  plainCounts,
  plainCountsNote,
  plainCountsText,
  queueFilterLabel,
  reasonChips,
  sequenceStatusLabel,
  statusStats,
  type BreakdownRow,
} from "@/features/campaigns/model";
import { listCampaignQueue } from "@/lib/campaigns/enrollment";
import { listLeadCampaigns } from "@/lib/campaigns/lead-campaigns";
import { getCampaign, listCampaigns } from "@/lib/campaigns/service";
import { checkSuppression, hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, suppressions } from "@/lib/db/schema";
import { setTrustedReporters } from "@/lib/mail/inbound/arf";
import {
  effectiveClassification,
  effectiveStopReason,
  isArfComplaintCode,
} from "@/lib/mail/inbound/complaint";
import { processInbound, resolveReview } from "@/lib/mail/inbound/process";
import { appendReasonsSql, stopBusinessSequences, stopSequences } from "@/lib/mail/inbound/stop";
import { listMailLog, mailLogCsvLine } from "@/lib/mail/mail-log";
import { getMailboxHealth } from "@/lib/mail/mailbox-health";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
} from "./helpers/campaign-fixture";
import {
  NOW,
  rawArf,
  rawMessage,
  seedSent,
  SIMULATED_PASS,
  type Sent,
} from "./helpers/inbound-fixture";

/**
 * Aşama 15.10-2 (TB-1, TB-2, TB-10, TB-11d) ve kampanya sayaçları ("hata a"). Bellek içi veritabanı; gerçek hesap yok.
 * Çift yazım (yeni sütun + eski işaret) ve eski satırların işaretle okunması burada; geri alma uyumu
 * tests/migration-0003.test.ts'tedir.
 */

const REPORTER = "fbl.reporter-ornek.com";
const RCPT = "info@alici-ornek.com";

let client: Client;
let db: Db;
let campaign: number;
let n = 0;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaign = await createCampaign(db, { status: "running" });
  await setTrustedReporters(db, [REPORTER], NOW);
  n = 0;
});
afterEach(() => client.close());

const nonce = () => `s${++n}`;
const feed = (raw: string, attestation: typeof SIMULATED_PASS | null = SIMULATED_PASS) =>
  processInbound(db, { mailboxId: DEMO_MAILBOX, raw, receivedAt: NOW, attestation }, { now: NOW });
const complain = (s: Sent) =>
  feed(rawArf({ outboundMessageId: s.rfc, rcptTo: s.email, nonce: nonce() }));
const unsubscribeMail = (s: Sent) =>
  feed(
    rawMessage({
      from: s.email,
      inReplyTo: s.rfc,
      nonce: nonce(),
      body: "Please unsubscribe me from your list.",
    }),
  );
const row = async (id: number) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, id)))[0]!;
const setStatus = (id: number, status: "completed" | "pending" | "scheduled") =>
  db.update(campaignLeads).set({ status }).where(eq(campaignLeads.id, id));

/* ---------------------------------------------------------------------------------------------- */

describe("TB-1: şikâyet kendi sınıfıyla yazılır, eski işaret korunur, eski satır işaretle okunur", () => {
  it("doğrulanmış ve doğrulanmamış rapor: classification='complaint' + error_code işareti", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await complain(a);
    await feed(rawArf({ outboundMessageId: a.rfc, rcptTo: a.email, nonce: nonce() }), null);
    const rows = await db
      .select({ c: messages.classification, e: messages.errorCode, s: messages.status })
      .from(messages)
      .where(eq(messages.direction, "in"));
    expect(rows).toEqual([
      { c: "complaint", e: "arf_complaint", s: "matched" },
      { c: "complaint", e: "arf_complaint:no_attestation", s: "received" },
    ]);
  });

  it("saf okuma: sütun önce, eski `other` + işaret yedeği; başka sınıflar değişmez", () => {
    expect(effectiveClassification("complaint", null)).toBe("complaint");
    expect(effectiveClassification("other", "arf_complaint")).toBe("complaint");
    expect(effectiveClassification("other", "arf_complaint:no_match")).toBe("complaint");
    expect(effectiveClassification("other", "arf_complainted")).toBe("other");
    expect(effectiveClassification("reply", "arf_complaint")).toBe("reply");
    expect(effectiveClassification(null, null)).toBeNull();
    expect(isArfComplaintCode("arf_complaint:x")).toBe(true);
    expect(isArfComplaintCode("arf_other_type")).toBe(false);
  });

  it("günlük, CSV ve kutu sağlığı eski (işaretli `other`) ve yeni satırı aynı sayar", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const b = await seedSent(db, campaign, { email: "sales@ikinci-ornek.com" });
    await complain(a); // yeni biçim
    // 15.10-2 öncesi sürümün yazdığı satır (sınıf `other` + işaret) — doğrulanmış ve incelemede
    await db.insert(messages).values([
      {
        direction: "in",
        purpose: "inbound",
        campaignId: campaign,
        campaignLeadId: b.cl,
        leadId: b.leadId,
        mailboxId: DEMO_MAILBOX,
        rfcMessageId: "<eski-arf@t>",
        peerHash: "x",
        peerDomain: REPORTER,
        status: "matched",
        classification: "other",
        errorCode: "arf_complaint",
        createdAt: NOW,
        receivedAt: NOW,
      },
      {
        direction: "in",
        purpose: "inbound",
        mailboxId: DEMO_MAILBOX,
        rfcMessageId: "<eski-arf-2@t>",
        peerHash: "y",
        peerDomain: REPORTER,
        status: "received",
        classification: "other",
        errorCode: "arf_complaint:reporter_untrusted",
        createdAt: NOW,
        receivedAt: NOW,
      },
    ]);
    const log = await listMailLog(db, { direction: "in" });
    expect(log.items.map((i) => i.classification)).toEqual(["complaint", "complaint", "complaint"]);
    expect(mailLogCsvLine(log.items[0]!)).toContain(",complaint,");
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(h.complaint.arf).toMatchObject({ verifiedRecipients: 2, pendingReview: 1 });
  });
});

describe("TB-2: her durdurma yolu stop_reason yazar; çıkış ve şikâyet ayrıdır", () => {
  it("gelen çıkış iletisi → stop_reason='unsubscribe', şikâyet işareti YOK", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const r = await unsubscribeMail(a);
    expect(r).toMatchObject({ outcome: "processed", effects: { sequenceStopped: true } });
    expect(await row(a.cl)).toMatchObject({
      status: "unsubscribed",
      stopReason: "unsubscribe",
      exclusionReasons: [],
      nextSendAt: null,
    });
  });

  it("inceleme kararıyla uygulanan çıkış / olumsuz yanıt → stop_reason='unsubscribe'", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const r = await feed(
      rawMessage({ from: a.email, inReplyTo: a.rfc, nonce: nonce(), body: "Not interested." }),
    );
    expect(r).toMatchObject({ status: "received" });
    if (r.outcome !== "processed") throw new Error("işlenmedi");
    await resolveReview(db, r.inboundId, "apply", NOW);
    expect(await row(a.cl)).toMatchObject({ status: "unsubscribed", stopReason: "unsubscribe" });
  });

  it("doğrulanmış şikâyet → stop_reason='complaint' + `arf_complaint` işareti; mevcut gerekçeler korunur", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const c2 = await createCampaign(db, { status: "running" });
    const other = await addSequence(db, c2, { email: RCPT });
    await db
      .update(campaignLeads)
      .set({ status: "pending", exclusionReasons: ["onceki_not"] })
      .where(eq(campaignLeads.id, other.cl));
    await complain(a);
    expect(await row(a.cl)).toMatchObject({
      status: "unsubscribed",
      stopReason: "complaint",
      exclusionReasons: ["arf_complaint"],
    });
    expect(await row(other.cl)).toMatchObject({
      status: "unsubscribed",
      stopReason: "complaint",
      exclusionReasons: ["onceki_not", "arf_complaint"],
    });
  });

  it("şikâyet çıkıştan ağırdır: önce çıkan alıcı sonra şikâyet ederse neden yükselir; tersi değiştirmez", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await unsubscribeMail(a);
    await complain(a);
    expect(await row(a.cl)).toMatchObject({
      status: "unsubscribed",
      stopReason: "complaint",
      exclusionReasons: ["arf_complaint"],
    });
    const res = await db.transaction((tx) =>
      stopSequences(tx, { campaignLeadId: a.cl }, "unsubscribe", NOW),
    );
    expect(res).toEqual({ stopped: [], annotated: [] });
    expect((await row(a.cl)).stopReason).toBe("complaint");
  });

  it("tekrar çalıştırma etkisizdir (idempotent): ikinci çağrı hiçbir satırı değiştirmez, işaret yinelenmez", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const target = { recipientHash: hashEmail(RCPT) };
    const first = await db.transaction((tx) => stopSequences(tx, target, "complaint", NOW));
    expect(first).toEqual({ stopped: [a.cl], annotated: [] });
    const before = await row(a.cl);
    const second = await db.transaction((tx) => stopSequences(tx, target, "complaint", NOW + 1));
    expect(second).toEqual({ stopped: [], annotated: [] });
    expect(await row(a.cl)).toEqual(before);
  });

  it("gerekçe ekleme: geçersiz JSON yeni diziyle değişir, var olan kod yinelenmez", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await client.execute({
      sql: "UPDATE campaign_leads SET exclusion_reasons = 'bozuk' WHERE id = ?",
      args: [a.cl],
    });
    await db
      .update(campaignLeads)
      .set({ exclusionReasons: appendReasonsSql(["arf_complaint", "business_complaint"]) })
      .where(eq(campaignLeads.id, a.cl));
    expect((await row(a.cl)).exclusionReasons).toEqual(["arf_complaint", "business_complaint"]);
    await db
      .update(campaignLeads)
      .set({ exclusionReasons: appendReasonsSql(["business_complaint", "x"]) })
      .where(eq(campaignLeads.id, a.cl));
    expect((await row(a.cl)).exclusionReasons).toEqual([
      "arf_complaint",
      "business_complaint",
      "x",
    ]);
  });

  it("eski satır (stop_reason boş): `unsubscribed` + işaret → şikâyet, işaretsiz → çıkış; başka durumda neden yok", () => {
    expect(effectiveStopReason("unsubscribed", null, ["arf_complaint"])).toBe("complaint");
    expect(effectiveStopReason("unsubscribed", null, [])).toBe("unsubscribe");
    expect(effectiveStopReason("unsubscribed", undefined, undefined)).toBe("unsubscribe");
    expect(effectiveStopReason("completed", null, ["arf_complaint"])).toBeNull();
    expect(effectiveStopReason("completed", "complaint", [])).toBe("complaint");
    expect(effectiveStopReason("removed", null, ["arf_complaint"])).toBeNull();
  });
});

describe("TB-10: bitmiş dizi çıkış/şikâyette durumunu korur, yalnızca neden kaydedilir", () => {
  it("gelen çıkış: `completed` kalır, stop_reason='unsubscribe'; engel yine yazılır", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await setStatus(a.cl, "completed");
    const r = await unsubscribeMail(a);
    expect(r).toMatchObject({ effects: { suppressed: true, sequenceStopped: false } });
    expect(await row(a.cl)).toMatchObject({ status: "completed", stopReason: "unsubscribe" });
    expect((await checkSuppression(db, RCPT)).suppressed).toBe(true);
    const [au] = await db.select().from(auditLog).where(eq(auditLog.action, "inbound.unsubscribe"));
    expect(au!.detail).toMatchObject({ annotated: 1 });
  });

  it("şikâyet: `completed` kalır, stop_reason='complaint' + işaret; sonra çıkış nedeni değiştirmez", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await setStatus(a.cl, "completed");
    await complain(a);
    expect(await row(a.cl)).toMatchObject({
      status: "completed",
      stopReason: "complaint",
      exclusionReasons: ["arf_complaint"],
    });
    const [au] = await db.select().from(auditLog).where(eq(auditLog.action, "inbound.complaint"));
    expect(au!.detail).toMatchObject({ stopped: 0, annotated: 1 });
  });

  it("önce çıkış (completed) sonra şikâyet: neden 'complaint'e yükselir, durum yine `completed`", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    await setStatus(a.cl, "completed");
    await unsubscribeMail(a);
    await complain(a);
    expect(await row(a.cl)).toMatchObject({ status: "completed", stopReason: "complaint" });
  });

  it("arayüz etiketi: bitmiş dizinin sonraki çıkışı/şikâyeti ayrı gösterilir", () => {
    expect(sequenceStatusLabel("completed", [], "unsubscribe")).toBe(
      "Tamamlandı, sonra listeden çıktı",
    );
    expect(sequenceStatusLabel("completed", [], "complaint")).toBe(
      "Tamamlandı, sonra şikâyet etti",
    );
    expect(sequenceStatusLabel("completed", [])).toBe("Tamamlandı");
    expect(sequenceStatusLabel("unsubscribed", [], "unsubscribe")).toBe("Listeden çıktı");
    expect(sequenceStatusLabel("unsubscribed", ["arf_complaint"])).toBe("Şikâyet nedeniyle durdu");
    expect(sequenceStatusLabel("removed", ["arf_complaint"])).toBe("Çıkarıldı");
  });
});

describe("şikâyet/çıkış kapsamı: durdurma alıcı genelinde, neden yazma yalnızca ilgili dizide", () => {
  it("B kampanyasına şikâyet: A'daki çıkışla durmuş ve C'deki bitmiş dizi değişmez; D'deki süren dizi durur", async () => {
    const cA = await createCampaign(db, { status: "running" });
    const cC = await createCampaign(db, { status: "running" });
    const cD = await createCampaign(db, { status: "running" });
    const inA = await seedSent(db, cA, { email: RCPT, sentAt: NOW - 9 * 86_400_000 });
    await unsubscribeMail(inA); // A: çıkışla durdu
    const inC = await seedSent(db, cC, { email: RCPT, sentAt: NOW - 7 * 86_400_000 });
    await setStatus(inC.cl, "completed"); // C: bitti, neden yok
    const inD = await addSequence(db, cD, { email: RCPT }); // D: süren
    const inB = await seedSent(db, campaign, { email: RCPT, sentAt: NOW - 2 * 86_400_000 }); // şikâyet edilen
    const before = { a: await row(inA.cl), c: await row(inC.cl) };

    await complain(inB);

    expect(await row(inB.cl)).toMatchObject({ status: "unsubscribed", stopReason: "complaint" });
    expect(await row(inD.cl)).toMatchObject({ status: "unsubscribed", stopReason: "complaint" });
    // A ve C kendi olaylarını gösterir: şikâyete yükseltilmez / "Tamamlandı, sonra şikâyet etti" olmaz
    expect(await row(inA.cl)).toEqual(before.a);
    expect(before.a).toMatchObject({ status: "unsubscribed", stopReason: "unsubscribe" });
    expect(await row(inC.cl)).toEqual(before.c);
    expect(before.c).toMatchObject({ status: "completed", stopReason: null });
    const [au] = await db.select().from(auditLog).where(eq(auditLog.action, "inbound.complaint"));
    expect(au!.detail).toMatchObject({ annotated: 0, annotatedIds: [] });
    expect([...(au!.detail as { stoppedIds: number[] }).stoppedIds].sort()).toEqual(
      [inB.cl, inD.cl].sort(),
    );
  });

  it("adres hedefli çağrı: `about` verilmezse durumu korunan hiçbir satıra neden yazılmaz; verilirse yalnızca ona", async () => {
    const done1 = await seedSent(db, campaign, { email: RCPT, sentAt: NOW - 9 * 86_400_000 });
    await setStatus(done1.cl, "completed");
    const c2 = await createCampaign(db, { status: "running" });
    const done2 = await seedSent(db, c2, { email: RCPT, sentAt: NOW - 7 * 86_400_000 });
    await setStatus(done2.cl, "completed");
    const target = { recipientHash: hashEmail(RCPT) };
    expect(await db.transaction((tx) => stopSequences(tx, target, "unsubscribe", NOW))).toEqual({
      stopped: [],
      annotated: [],
    });
    expect(
      await db.transaction((tx) => stopSequences(tx, target, "unsubscribe", NOW, done2.cl)),
    ).toEqual({ stopped: [], annotated: [done2.cl] });
    expect((await row(done1.cl)).stopReason).toBeNull();
  });
});

describe("TB-11(d): doğrulanmış şikâyet işletmenin diğer süren dizilerini durdurur (kalıcı engel YOK)", () => {
  it("aynı lead'in başka adresi ve aynı işletme alan adı (alt alan adı dahil) durur; başka işletme ve bitmiş dizi etkilenmez", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const c2 = await createCampaign(db, { status: "running" });
    // aynı işletme: alt alan adı
    const sub = await addSequence(db, c2, { email: "satis@shop.alici-ornek.com" });
    // aynı lead, tamamen farklı alan adı (lead'in ikinci adresi)
    const [sameLead] = await db
      .insert(campaignLeads)
      .values({
        campaignId: c2,
        leadId: a.leadId,
        recipientEmail: "owner@baska-ornek.net",
        recipientHash: hashEmail("owner@baska-ornek.net"),
        recipientDomain: "baska-ornek.net",
        status: "pending",
        addedAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: campaignLeads.id });
    // başka işletme (benzer ad), kişisel posta ve bitmiş aynı-işletme dizisi
    const otherBiz = await addSequence(db, c2, { email: "info@alici-ornek2.com" });
    const c3 = await createCampaign(db, { status: "running" });
    const doneSameBiz = await seedSent(db, c3, {
      email: "muhasebe@alici-ornek.com",
      sentAt: NOW - 3 * 86_400_000,
    });
    await setStatus(doneSameBiz.cl, "completed");

    const r = await complain(a);
    expect(r).toMatchObject({ effects: { suppressed: true, sequenceStopped: true } });
    for (const id of [sub.cl, sameLead!.id]) {
      expect(await row(id)).toMatchObject({
        status: "unsubscribed",
        stopReason: "complaint",
        exclusionReasons: ["arf_complaint", "business_complaint"],
        nextSendAt: null,
      });
    }
    expect((await row(otherBiz.cl)).status).toBe("scheduled");
    expect(await row(doneSameBiz.cl)).toMatchObject({ status: "completed", stopReason: null });
    // diğer adresler ENGELLENMEZ: yalnızca şikâyet eden adres suppression alır
    const sup = await db.select().from(suppressions);
    expect(sup.map((s) => s.emailHash)).toEqual([hashEmail(RCPT)]);
    expect((await checkSuppression(db, "satis@shop.alici-ornek.com")).suppressed).toBe(false);
    const [au] = await db.select().from(auditLog).where(eq(auditLog.action, "inbound.complaint"));
    expect(au!.detail).toMatchObject({
      stopped: 1,
      stoppedIds: [a.cl],
      businessStopped: 2,
      businessDomain: "alici-ornek.com",
    });
    // TB-11(d) başka lead/kampanyaya uzanır: hangi dizilerin durduğu denetimden izlenebilir
    expect([...(au!.detail as { businessStoppedIds: number[] }).businessStoppedIds].sort()).toEqual(
      [sub.cl, sameLead!.id].sort(),
    );
    // arayüz: gerekçe etiketi okunur
    const q = await listCampaignQueue(db, c2, {});
    const sq = q.items.find((i) => i.id === sub.cl)!;
    expect(sq.stopReason).toBe("complaint");
    expect(sq.exclusionReasons).toContain("business_complaint");
  });

  it("doğrulanmamış şikâyet işletmeye dokunmaz; çıkış (unsubscribe) işletme geneline yayılmaz", async () => {
    const a = await seedSent(db, campaign, { email: RCPT });
    const c2 = await createCampaign(db, { status: "running" });
    const sub = await addSequence(db, c2, { email: "satis@alici-ornek.com" });
    await feed(rawArf({ outboundMessageId: a.rfc, rcptTo: a.email, nonce: nonce() }), null);
    await unsubscribeMail(a);
    expect((await row(sub.cl)).status).toBe("scheduled");
  });

  it("kişisel posta alan adı işletme sayılmaz: yalnızca aynı lead durur", async () => {
    const stopped = await db.transaction((tx) =>
      stopBusinessSequences(tx, { leadId: null, recipientDomain: "gmail.com" }, NOW),
    );
    expect(stopped).toEqual({ stopped: [], businessDomain: null });
    const s = await addSequence(db, campaign, { email: "biri@gmail.com" });
    const res = await db.transaction((tx) =>
      stopBusinessSequences(tx, { leadId: s.leadId, recipientDomain: "gmail.com" }, NOW),
    );
    expect(res).toEqual({ stopped: [s.cl], businessDomain: null });
  });
});

describe("kampanya sayaçları: gönderim almadan 'gönderildi' sayılmaz; çıkış ve şikâyet ayrı", () => {
  it("sunucu ayrıntısı + düz özet: çapraz kampanya çıkışı gönderimsiz kişiyi 'ileti almadan durdu' yapar", async () => {
    await seedSent(db, campaign, { email: RCPT }); // ileti aldı
    const b = await seedSent(db, campaign, { email: "sales@ikinci-ornek.com" });
    const waiting = await addSequence(db, campaign, { email: "bekleyen@ucuncu-ornek.com" });
    await setStatus(waiting.cl, "pending");
    // Aynı alıcı başka kampanyada: hiç ileti almadan çıkış ile durur
    const c2 = await createCampaign(db, { status: "running" });
    const cross = await addSequence(db, c2, { email: RCPT });
    // Bağlantı/tek tık çıkışı adres düzeyindedir: a (gönderim almış) + cross (gönderimsiz) durur
    await db.transaction((tx) =>
      stopSequences(tx, { recipientHash: hashEmail(RCPT) }, "unsubscribe", NOW),
    );
    await complain(b); // b gönderim almış, şikâyet
    // eski sürümün yazdığı satır: unsubscribed + işaret, stop_reason boş, gönderim yok
    const legacy = await addSequence(db, c2, { email: "eski@dorduncu-ornek.com" });
    await db
      .update(campaignLeads)
      .set({ status: "unsubscribed", exclusionReasons: ["arf_complaint"], stopReason: null })
      .where(eq(campaignLeads.id, legacy.cl));

    const c1 = await getCampaign(db, campaign);
    expect(c1.counts).toEqual({ pending: 1, unsubscribed: 2 });
    expect(plainCounts(c1.counts, c1.breakdown)).toEqual({
      sent: 2,
      queued: 1,
      failed: 0,
      repliedBeforeSend: 0,
      stoppedBeforeSend: 0,
      optedOut: 1,
      complained: 1,
    });
    const [s2] = (await listCampaigns(db)).filter((c) => c.id === c2);
    expect(s2!.breakdown).toEqual(
      expect.arrayContaining([
        { status: "unsubscribed", contacted: false, stopReason: "unsubscribe", n: 1 },
        { status: "unsubscribed", contacted: false, stopReason: "complaint", n: 1 },
      ]),
    );
    const p2 = plainCounts(s2!.counts, s2!.breakdown);
    expect(p2).toMatchObject({ sent: 0, stoppedBeforeSend: 2, optedOut: 1, complained: 1 });
    expect(statusStats(s2!.counts, s2!.breakdown)).toEqual([
      { key: "unsubscribed", label: "Listeden çıktı", value: 1 },
      { key: "complaint", label: "Şikâyet nedeniyle durdu", value: 1 },
    ]);
    expect(cross.cl).toBeGreaterThan(0);
    // lead ayrıntısındaki kampanya listesi de etkin nedeni taşır
    const lc = await listLeadCampaigns(db, legacy.leadId);
    expect(lc[0]!.stopReason).toBe("complaint");
  });

  it("plainCounts kovaları ayrıktır ve toplam hariç tutulanlar dışındaki diziye eşittir", () => {
    const rows: BreakdownRow[] = [
      { status: "waiting_next", contacted: true, stopReason: null, n: 3 },
      { status: "completed", contacted: true, stopReason: "unsubscribe", n: 1 },
      { status: "replied", contacted: true, stopReason: null, n: 2 },
      { status: "replied", contacted: false, stopReason: null, n: 1 },
      { status: "bounced", contacted: true, stopReason: null, n: 2 },
      { status: "failed", contacted: true, stopReason: null, n: 1 },
      { status: "failed", contacted: false, stopReason: null, n: 4 },
      { status: "pending", contacted: false, stopReason: null, n: 5 },
      { status: "scheduled", contacted: true, stopReason: null, n: 1 },
      { status: "in_flight", contacted: false, stopReason: null, n: 1 },
      { status: "unsubscribed", contacted: false, stopReason: "complaint", n: 2 },
      { status: "removed", contacted: false, stopReason: null, n: 1 },
      { status: "cancelled", contacted: false, stopReason: null, n: 1 },
      { status: "excluded", contacted: false, stopReason: null, n: 9 },
      { status: "completed", contacted: false, stopReason: null, n: 1 }, // olağan dışı: sayılmaz
    ];
    const counts: Partial<Record<BreakdownRow["status"], number>> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + r.n;
    const p = plainCounts(counts, rows);
    expect(p).toEqual({
      sent: 3 + 1 + 2 + 1 + 1,
      queued: 5 + 1,
      failed: 2 + 4,
      repliedBeforeSend: 1,
      stoppedBeforeSend: 2 + 1 + 1,
      optedOut: 1,
      complained: 2,
    });
    expect(p.sent + p.queued + p.failed + p.repliedBeforeSend + p.stoppedBeforeSend).toBe(
      rows.filter((r) => r.status !== "excluded").reduce((a, r) => a + r.n, 0) - 1,
    );
  });

  it("ayrıntı yoksa (eski önbellek) temkinli: çıkış/yanıt asla 'gönderildi' sayılmaz", () => {
    expect(
      plainCounts({ completed: 2, waiting_next: 1, unsubscribed: 4, replied: 3, pending: 1 }),
    ).toEqual({
      sent: 3,
      queued: 1,
      failed: 0,
      repliedBeforeSend: 0,
      stoppedBeforeSend: 0,
      optedOut: 0,
      complained: 0,
    });
    expect(statusStats({ unsubscribed: 2, completed: 1 })).toEqual([
      { key: "completed", label: "Tamamlandı", value: 1 },
      { key: "unsubscribed", label: "Listeden çıkmak istedi", value: 2 },
    ]);
  });

  it("düz metin: yalnızca ayrık kovalar toplanır; durma nedenleri ayrı 'Bunlardan' notunda", () => {
    const base = {
      sent: 4,
      queued: 2,
      failed: 1,
      repliedBeforeSend: 0,
      stoppedBeforeSend: 0,
      optedOut: 0,
      complained: 0,
    };
    expect(plainCountsText(base)).toBe("4 gönderildi · 2 sırada · 1 hata");
    expect(plainCountsNote(base)).toBeNull();
    const full = {
      ...base,
      repliedBeforeSend: 1,
      stoppedBeforeSend: 3,
      optedOut: 1,
      complained: 2,
    };
    expect(plainCountsText(full, (x) => `#${x}`)).toBe(
      "#4 gönderildi · #2 sırada · #1 hata · #1 kişi önceden yanıt verdiği için ileti almadı · #3 kişi ileti almadan durdu",
    );
    // örtüşen sayılar ana satıra girmez (iki kez sayılmış gibi okunmasın)
    expect(plainCountsText(full)).not.toContain("listeden");
    expect(plainCountsNote(full, (x) => `#${x}`)).toBe(
      "Bunlardan: #1 kişi listeden çıktı, #2 kişi şikâyet nedeniyle durdu",
    );
    expect(plainCountsNote({ ...base, complained: 1 })).toBe(
      "Bunlardan: 1 kişi şikâyet nedeniyle durdu",
    );
  });

  it("hariç tutulan dizinin nedeni sayılmaz", () => {
    const rows: BreakdownRow[] = [
      { status: "excluded", contacted: false, stopReason: "complaint", n: 3 },
      { status: "unsubscribed", contacted: true, stopReason: "unsubscribe", n: 1 },
    ];
    expect(plainCounts({ excluded: 3, unsubscribed: 1 }, rows)).toMatchObject({
      sent: 1,
      optedOut: 1,
      complained: 0,
    });
  });

  it("boş kampanya: ayrıntı boş dizi, sayaçlar sıfır", async () => {
    const c = await getCampaign(db, campaign);
    expect(c.breakdown).toEqual([]);
    expect(plainCounts(c.counts, c.breakdown).sent).toBe(0);
    const rows = await db
      .select()
      .from(campaignLeads)
      .where(inArray(campaignLeads.campaignId, [campaign]));
    expect(rows).toHaveLength(0);
  });
});

describe("arayüz: gerekçe rozetleri ve kuyruk süzgeci", () => {
  it("işletme şikâyetiyle durdurulan dizide `arf_complaint` rozeti gizlenir; kısa etiket + açıklama ipucu", () => {
    const chips = reasonChips(["arf_complaint", "business_complaint"]);
    expect(chips).toEqual([
      {
        code: "business_complaint",
        label: "İşletmenin başka adresi şikâyet etti",
        hint: expect.stringContaining("Bu adres engellenmedi"),
      },
    ]);
    expect(chips[0]!.label.length).toBeLessThanOrEqual(40);
    expect(reasonChips(["arf_complaint"]).map((c) => c.code)).toEqual(["arf_complaint"]);
    expect(reasonChips(["bilinmeyen_kod"])).toEqual([
      { code: "bilinmeyen_kod", label: "bilinmeyen_kod", hint: "bilinmeyen_kod" },
    ]);
    expect(reasonChips([])).toEqual([]);
  });

  it("kuyruk süzgecindeki `unsubscribed` seçeneği çıkış ve şikâyeti birlikte adlandırır", () => {
    expect(queueFilterLabel("unsubscribed")).toBe("Durduruldu (listeden çıkış veya şikâyet)");
    expect(queueFilterLabel("completed")).toBe("Tamamlandı");
  });
});
