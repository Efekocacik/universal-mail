import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashEmail, liftSuppression, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, settings, suppressions } from "@/lib/db/schema";
import { classifyInbound } from "@/lib/mail/inbound/classify";
import { ArfConfigError, setTrustedReporters } from "@/lib/mail/inbound/arf";
import { evaluateEvidence } from "@/lib/mail/inbound/evidence";
import { parseInbound, type ParsedInbound } from "@/lib/mail/inbound/parse";
import { processInbound } from "@/lib/mail/inbound/process";
import { listReviewQueue } from "@/lib/mail/inbound/review-list";
import { resolveReview } from "@/lib/mail/inbound/process";
import { getMailboxHealth } from "@/lib/mail/mailbox-health";
import { getSetting } from "@/lib/settings";
import { classLabel, reviewReasonLabel } from "@/features/mail-log/model";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import {
  addMailbox,
  FAIL_AUTH,
  NOW,
  rawArf,
  rawDsn,
  rawMessage,
  seedSent,
  SIMULATED_DSN_PASS,
  SIMULATED_PASS,
  type Sent,
} from "./helpers/inbound-fixture";

/**
 * ARF (RFC 5965) şikâyet raporları (Aşama 15.8). Bellek içi veritabanı; gerçek ağ/hesap yok. Mevcut L1–L4 kanıt
 * katmanları korunur; doğrulanmamış rapor suppression ÜRETMEZ. Şikâyet oranı "ölçülemiyor" kalır, sayı kısmi kapsamdır.
 */

const REPORTER = "fbl.reporter-ornek.com";
const RCPT = "info@alici-ornek.com";
const RCPT2 = "sales@diger-alan.com";

let client: Client;
let db: Db;
let campaign: number;
let a: Sent;
let b: Sent;
let n = 0;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaign = await createCampaign(db, { status: "running" });
  a = await seedSent(db, campaign, { email: RCPT });
  b = await seedSent(db, campaign, { email: RCPT2 });
  await setTrustedReporters(db, [REPORTER], NOW);
  n = 0;
});
afterEach(() => client.close());

const nonce = () => `n${++n}`;
const arf = (s: Sent, over: Partial<Parameters<typeof rawArf>[0]> = {}) =>
  rawArf({ outboundMessageId: s.rfc, rcptTo: s.email, nonce: nonce(), ...over });
const feed = (
  raw: string,
  attestation = SIMULATED_PASS as typeof SIMULATED_PASS | null,
  allowEffects = true,
) =>
  processInbound(
    db,
    { mailboxId: DEMO_MAILBOX, raw, receivedAt: NOW, attestation },
    { now: NOW, allowEffects },
  );
const inbound = () => db.select().from(messages).where(eq(messages.direction, "in"));
const supp = () => db.select().from(suppressions);
const status = async (s: Sent) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl)))[0]!.status;
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const parsed = (raw: string): ParsedInbound => {
  const p = parseInbound(raw);
  if (!p.ok) throw new Error("parse failed");
  return p;
};

/* ---------------------------------------------------------------------------------------------- */

describe("RFC 5965 ayrıştırıcı", () => {
  it("geçerli rapor: yapı, tür, sürüm, alıcı, özgün Message-ID ve To çıkarılır; bounce (dsn) ÜRETİLMEZ", () => {
    const p = parsed(arf(a));
    expect(p.arf).toEqual({
      structural: true,
      feedbackType: "abuse",
      version: "1",
      originalRcptTo: [RCPT],
      originalMessageId: a.rfc,
      originalTo: [RCPT],
    });
    expect(p.dsn).toBeNull();
    expect(p.suspicious).toEqual([]);
    expect(p.from?.domain).toBe(REPORTER);
  });

  it("gizlenmiş alıcı (Original-Rcpt-To ve To yok) hâlâ yapısal olarak geçerlidir", () => {
    const p = parsed(arf(a, { rcptTo: null, originalTo: null }));
    expect(p.arf).toMatchObject({
      structural: true,
      originalRcptTo: [],
      originalTo: [],
      originalMessageId: a.rfc,
    });
  });

  it("alanlar: tür küçük harfe çevrilir, katlanmış satırlar açılır, geçersiz adresler atılır, en çok 5 alıcı", () => {
    const p = parsed(
      arf(a, {
        feedbackType: "Abuse",
        rcptTo: ["gecersiz adres", RCPT, "a@b.com", "c@d.com", "e@f.com", "g@h.com", "i@j.com"],
      }),
    );
    expect(p.arf?.feedbackType).toBe("abuse");
    expect(p.arf?.originalRcptTo).toHaveLength(5);
    expect(p.arf?.originalRcptTo[0]).toBe(RCPT);
    const folded = arf(a).replace("Feedback-Type: abuse", "Feedback-Type:\r\n abuse");
    expect(parsed(folded).arf?.feedbackType).toBe("abuse");
  });

  const broken: [string, Partial<Parameters<typeof rawArf>[0]>][] = [
    ["Version yok", { version: null }],
    ["Version 2", { version: "2" }],
    ["Version 1.0", { version: "1.0" }],
    ["Feedback-Type yok", { feedbackType: null }],
    ["Feedback-Type geçersiz", { feedbackType: "Abuse; x=1" }],
    ["Feedback-Type rakamlı", { feedbackType: "4buse" }],
    ["Feedback-Type çok uzun", { feedbackType: "a".repeat(40) }],
    ["yinelenen feedback-report", { duplicateReport: true }],
  ];
  it.each(broken)("yapısal DEĞİL: %s", (_name, over) => {
    expect(parsed(arf(a, over)).arf?.structural).toBe(false);
  });

  it("farklı ikinci özgün ileti kuşkulu işaretlenir; rapor türü başka veya multipart/mixed ise ARF sayılmaz", () => {
    const p = parsed(arf(a, { secondOriginal: "<baska.id@universal-mail.invalid>" }));
    expect(p.suspicious).toContain("multiple_original_messages");
    expect(parsed(arf(a, { reportType: "delivery-status" })).arf).toBeNull();
    expect(parsed(arf(a, { reportType: null })).arf).toBeNull();
  });

  it("özgün ileti yoksa Message-ID null; DSN ve normal yanıt ARF OLARAK AYRIŞTIRILMAZ", () => {
    expect(parsed(arf(a, { omitOriginal: true })).arf?.originalMessageId).toBeNull();
    const dsn = parsed(rawDsn({ outboundMessageId: a.rfc, recipient: RCPT, nonce: nonce() }));
    expect(dsn.arf).toBeNull();
    expect(dsn.dsn?.structural).toBe(true);
    expect(parsed(rawMessage({ from: RCPT, inReplyTo: a.rfc, nonce: nonce() })).arf).toBeNull();
  });
});

describe("sınıflandırma", () => {
  const kind = (over: Partial<Parameters<typeof rawArf>[0]> = {}) =>
    classifyInbound(parsed(arf(a, over)));
  it("abuse → complaint; diğer türler → feedback_other; ARF bounce/otomatik yanıt/yanıt SANILMAZ", () => {
    expect(kind()).toBe("complaint");
    for (const t of ["fraud", "virus", "other", "not-spam", "opt-out"])
      expect(kind({ feedbackType: t }), t).toBe("feedback_other");
    expect(kind({ extraHeaders: ["Auto-Submitted: auto-generated", "Precedence: bulk"] })).toBe(
      "complaint",
    );
    expect(kind({ from: "mailer-daemon@fbl.reporter-ornek.com" })).toBe("complaint");
    expect(kind({ extraHeaders: [`In-Reply-To: ${a.rfc}`] })).toBe("complaint");
  });
  it("yapısı bozuk ama rapor görünümlü ileti 'complaint' sınıflanır (kanıt katmanı reddeder); ARF olmayanlar değişmez", () => {
    expect(kind({ version: "2" })).toBe("complaint");
    expect(
      classifyInbound(
        parsed(rawDsn({ outboundMessageId: a.rfc, recipient: RCPT, nonce: nonce() })),
      ),
    ).toBe("bounce_hard");
    expect(
      classifyInbound(
        parsed(rawMessage({ from: RCPT, inReplyTo: a.rfc, nonce: nonce(), body: "Thanks!" })),
      ),
    ).toBe("reply");
    expect(
      classifyInbound(
        parsed(
          rawMessage({
            from: RCPT,
            inReplyTo: a.rfc,
            nonce: nonce(),
            body: "This is a spam complaint feedback-report abuse",
          }),
        ),
      ),
    ).toBe("reply");
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe("doğrulanmış şikâyet: suppression + dizi durdurma", () => {
  it("tüm katmanlar geçerse: korumalı 'complaint' engeli, dizi durur, denetim yazılır; sütun CHECK'i bozulmaz (other)", async () => {
    const r = await feed(arf(a));
    expect(r).toMatchObject({ outcome: "processed", kind: "complaint", status: "matched" });
    const [sup] = await supp();
    expect(sup).toMatchObject({ reason: "complaint", source: "inbox", emailHash: hashEmail(RCPT) });
    expect(await status(a)).toBe("unsubscribed");
    expect(await status(b)).toBe("waiting_next"); // başka alıcı etkilenmez
    const [row] = await inbound();
    expect(row).toMatchObject({
      classification: "other",
      errorCode: "arf_complaint",
      status: "matched",
      campaignLeadId: a.cl,
      inReplyTo: a.rfc,
    });
    const [au] = await audits("inbound.complaint");
    expect(au!.detail).toMatchObject({ stopped: 1 });
    const dump = JSON.stringify([await db.select().from(auditLog), await inbound(), await supp()]);
    expect(dump).not.toContain(RCPT);
    expect(dump).not.toContain("Orijinal iletinin gövdesi");
  });

  it("alıcı gizlenmişse (Original-Rcpt-To/To yok) eşleşen iletinin alıcısı kullanılır", async () => {
    await feed(arf(a, { rcptTo: null, originalTo: null }));
    expect((await supp())[0]).toMatchObject({ reason: "complaint", emailHash: hashEmail(RCPT) });
    expect(await status(a)).toBe("unsubscribed");
  });

  it("engel adresi RAPORDAKİ alandan değil kampanya alıcısı kaydından gelir", async () => {
    // rapor, kayıtlı alıcıyla aynı adresi gösterir ama büyük/küçük harf farkıyla
    await feed(arf(a, { rcptTo: RCPT.toUpperCase(), originalTo: RCPT.toUpperCase() }));
    expect((await supp())[0]!.emailHash).toBe(hashEmail(RCPT));
  });

  it("aynı alıcının BAŞKA kampanyadaki bekleyen dizisi de durur; diğer alıcılar etkilenmez", async () => {
    const c2 = await createCampaign(db, { status: "running" });
    const dup = await seedSent(db, c2, { email: RCPT, sentAt: NOW - 3 * 86_400_000 });
    await feed(arf(a));
    expect(await status(a)).toBe("unsubscribed");
    expect(await status(dup)).toBe("unsubscribed");
    expect(await status(b)).toBe("waiting_next");
  });

  it("engel KORUMALIDIR: sıradan işlemle kaldırılamaz", async () => {
    await feed(arf(a));
    const [sup] = await supp();
    await expect(
      liftSuppression(
        db,
        { id: sup!.id, confirm: true, justification: "Elle kaldırma denemesi" },
        NOW,
      ),
    ).rejects.toMatchObject({ kind: "protected" });
  });

  it("tekrar: aynı ham rapor 'duplicate'; ikinci FARKLI rapor aynı alıcıda ikinci engel/denetim üretmez", async () => {
    const raw = arf(a);
    expect((await feed(raw)).outcome).toBe("processed");
    expect((await feed(raw)).outcome).toBe("duplicate");
    expect((await feed(arf(a))).outcome).toBe("processed"); // yeni rapor (farklı nonce)
    expect(await supp()).toHaveLength(1);
    expect(await audits("inbound.complaint")).toHaveLength(2); // iki rapor kaydı; engel kopyalanmadı
  });

  it("daha güçlü engel (silme talebi) şikâyetle ZAYIFLATILMAZ", async () => {
    await suppressEmail(db, { email: RCPT, reason: "erasure", source: "manual" }, NOW);
    await feed(arf(a));
    const rows = await supp();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("erasure");
  });
});

describe("doğrulanmamış şikâyet ASLA otomatik etki üretmez", () => {
  const noEffect = async () => {
    expect(await supp()).toHaveLength(0);
    expect(await status(a)).toBe("waiting_next");
    expect(await status(b)).toBe("waiting_next");
    expect(await audits("inbound.complaint")).toHaveLength(0);
  };

  it("tasdik yok / tasdik başarısız → inceleme (received), neden işaretlidir", async () => {
    const r1 = await feed(arf(a), null);
    expect(r1).toMatchObject({
      outcome: "processed",
      status: "received",
      reviewReason: "no_attestation",
    });
    const r2 = await feed(arf(a), FAIL_AUTH);
    expect(r2).toMatchObject({ status: "received", reviewReason: "attestation_failed" });
    const rows = await inbound();
    expect(rows.map((r) => r.errorCode)).toEqual([
      "arf_complaint:no_attestation",
      "arf_complaint:attestation_failed",
    ]);
    expect(rows.every((r) => r.campaignLeadId === null)).toBe(true); // doğrulanmamış satıra bağlantı yazılmaz
    await noEffect();
  });

  it("rapor sağlayıcısı güvenilir listede DEĞİLSE (varsayılan boş liste dahil) doğrulanmaz", async () => {
    await setTrustedReporters(db, [], NOW);
    expect(await feed(arf(a))).toMatchObject({
      status: "received",
      reviewReason: "reporter_untrusted",
    });
    await setTrustedReporters(db, ["baska-raporcu.com"], NOW);
    expect(await feed(arf(a))).toMatchObject({
      status: "received",
      reviewReason: "reporter_untrusted",
    });
    // alt alan adı otomatik güvenilir SAYILMAZ (tam eşleşme)
    await setTrustedReporters(db, ["reporter-ornek.com"], NOW);
    expect(await feed(arf(a))).toMatchObject({ reviewReason: "reporter_untrusted" });
    await noEffect();
  });

  it("alıcı uyuşmazlığı: Original-Rcpt-To veya özgün To başka birini gösteriyorsa ya da biri uyuşmuyorsa", async () => {
    expect(await feed(arf(a, { rcptTo: RCPT2 }))).toMatchObject({
      status: "received",
      reviewReason: "recipient_mismatch",
    });
    expect(await feed(arf(a, { rcptTo: RCPT, originalTo: RCPT2 }))).toMatchObject({
      reviewReason: "recipient_mismatch",
    });
    expect(await feed(arf(a, { rcptTo: [RCPT, RCPT2] }))).toMatchObject({
      reviewReason: "recipient_mismatch",
    });
    await noEffect();
  });

  it("yapı bozuk / kuşkulu / abuse dışı → etki yok", async () => {
    for (const over of [
      { version: "2" },
      { version: null },
      { feedbackType: null },
      { duplicateReport: true },
      { secondOriginal: "<x.y@z.example>" },
    ]) {
      const r = await feed(arf(a, over));
      expect(r, JSON.stringify(over)).toMatchObject({ outcome: "processed", status: "received" });
    }
    for (const t of ["fraud", "virus", "other", "opt-out"]) {
      expect(await feed(arf(a, { feedbackType: t })), t).toMatchObject({
        kind: "feedback_other",
        status: "received",
        reviewReason: "arf_other_type",
      });
    }
    await noEffect();
  });

  it("'not-spam' olumlu sinyaldir: yok sayılır (inceleme yok, etki yok)", async () => {
    expect(await feed(arf(a, { feedbackType: "not-spam" }))).toMatchObject({
      kind: "feedback_other",
      status: "ignored",
    });
    await noEffect();
  });

  it("eşleşme yok / geçersiz: bilinmeyen Message-ID, test iletisi, başka posta kutusu, eski ileti, gönderilmemiş", async () => {
    expect(
      await feed(
        rawArf({
          outboundMessageId: "<yok.yok@universal-mail.invalid>",
          rcptTo: RCPT,
          nonce: nonce(),
        }),
      ),
    ).toMatchObject({ status: "unmatched", reviewReason: "no_match" });
    expect(
      await feed(
        rawArf({
          outboundMessageId: "<yok@universal-mail.invalid>",
          rcptTo: null,
          nonce: nonce(),
          omitOriginal: true,
        }),
      ),
    ).toMatchObject({ status: "unmatched" });
    const test = await seedSent(db, campaign, { email: "ops@test-alan.com", purpose: "test" });
    expect(await feed(arf(test))).toMatchObject({
      status: "ignored",
      reviewReason: "test_message",
    });
    const old = await seedSent(db, campaign, {
      email: "hello@eski-alan.com",
      sentAt: NOW - 40 * 86_400_000,
    });
    expect(await feed(arf(old))).toMatchObject({
      status: "unmatched",
      reviewReason: "match_invalid",
    });
    const failed = await seedSent(db, campaign, { email: "team@fail-alan.com", status: "failed" });
    expect(await feed(arf(failed))).toMatchObject({
      status: "unmatched",
      reviewReason: "match_invalid",
    });
    const other = await addMailbox(db, {
      provider: "demo",
      address: "baska@universal-mail.invalid",
    });
    const foreign = await seedSent(db, campaign, {
      email: "desk@yabanci-alan.com",
      mailboxId: other,
    });
    expect(await feed(arf(foreign))).toMatchObject({
      status: "unmatched",
      reviewReason: "match_invalid",
    });
    await noEffect();
  });

  it("raporu kendi posta kutumuz gönderdiyse (L4) veya hacim sınırı aşıldıysa etki yok", async () => {
    const own = await feed(arf(a, { from: "demo@universal-mail.invalid" }));
    expect(own.outcome).toBe("processed");
    expect(await supp()).toHaveLength(0);
    const flood = await feed(arf(a), SIMULATED_PASS, false);
    expect(flood).toMatchObject({ status: "received", reviewReason: "flood_guard" });
    await noEffect();
  });

  it("kuşkulu başlık yinelenmesi (sahte Message-ID/From) → etki yok", async () => {
    const dupFrom = arf(a).replace(
      "Subject: FW: Merhaba",
      "From: <baska@fbl.reporter-ornek.com>\r\nSubject: FW: Merhaba",
    );
    expect(parsed(dupFrom).suspicious).toContain("duplicate_from");
    expect(await feed(dupFrom)).toMatchObject({ status: "received" });
    await noEffect();
  });

  it("silinmiş alıcı: adres kayıtlı değilse engel yazılamaz → inceleme (recipient_unavailable)", async () => {
    await db
      .update(campaignLeads)
      .set({ recipientEmail: null, recipientHash: null, redactedAt: NOW })
      .where(eq(campaignLeads.id, a.cl));
    expect(await feed(arf(a))).toMatchObject({
      status: "received",
      reviewReason: "recipient_unavailable",
    });
    expect(await supp()).toHaveLength(0);
  });

  it("alıcı özeti iletiyle tutarsızsa (kayıt sonradan değişti) engel yazılmaz", async () => {
    await db
      .update(campaignLeads)
      .set({
        recipientEmail: "baska@degisen-alan.com",
        recipientHash: hashEmail("baska@degisen-alan.com"),
      })
      .where(eq(campaignLeads.id, a.cl));
    expect(await feed(arf(a))).toMatchObject({
      status: "received",
      reviewReason: "recipient_unavailable",
    });
    expect(await supp()).toHaveLength(0);
  });

  it("DSN tasdiki (boş zarf) ARF doğrulamasının yerine geçmez; sahte 'mailer-daemon' ARF'i bounce olarak uygulanmaz", async () => {
    const r = await feed(
      arf(a, { from: "mailer-daemon@fbl.reporter-ornek.com" }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ kind: "complaint" });
    expect(await supp()).toHaveLength(1); // bu yine de tam doğrulanmış bir şikâyettir (bounce değil)
    expect(await supp().then((x) => x[0]!.reason)).toBe("complaint");
    const [row] = await inbound();
    expect(row!.classification).toBe("other");
  });
});

describe("kanıt katmanları doğrudan (evaluateEvidence)", () => {
  const ev = (raw: string, o: { trusted?: string[]; resolvable?: boolean } = {}) =>
    evaluateEvidence({
      parsed: parsed(raw),
      kind: "complaint",
      attestation: SIMULATED_PASS,
      match: {
        id: 1,
        mailboxId: 1,
        purpose: "campaign",
        status: "sent",
        sentAt: NOW - 1000,
        peerHash: hashEmail(RCPT),
        campaignId: 1,
        campaignLeadId: 1,
        leadId: 1,
      },
      mailboxId: 1,
      mailboxAddress: "demo@universal-mail.invalid",
      now: NOW,
      allowEffects: true,
      trustedReporters: new Set(o.trusted ?? [REPORTER]),
      recipientResolvable: o.resolvable ?? true,
    });
  it("hepsi geçerli → L1–L4 tam", () => {
    expect(ev(arf(a))).toMatchObject({
      l1: true,
      l2: true,
      l3: true,
      l4: true,
      reviewReason: null,
    });
  });
  it("güvenilir raporcu verilmezse L3 yok; çözülemeyen alıcıda L2 yok", () => {
    expect(ev(arf(a), { trusted: [] })).toMatchObject({
      l3: false,
      reviewReason: "reporter_untrusted",
    });
    expect(ev(arf(a), { resolvable: false })).toMatchObject({
      l2: false,
      reviewReason: "recipient_unavailable",
    });
  });
  it("trustedReporters hiç verilmezse (varsayılan) ARF doğrulanmaz", () => {
    const e = evaluateEvidence({
      parsed: parsed(arf(a)),
      kind: "complaint",
      attestation: SIMULATED_PASS,
      match: null,
      mailboxId: 1,
      mailboxAddress: null,
      now: NOW,
      allowEffects: true,
    });
    expect(e.l3).toBe(false);
  });
});

describe("inceleme kuyruğu ve etiketler", () => {
  it("doğrulanamayan şikâyet inceleme kuyruğunda görünür; yalnızca 'yok say' seçilebilir (şikâyet elle uygulanamaz)", async () => {
    await feed(arf(a), null);
    const q = await listReviewQueue(db);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      classification: "other",
      reason: "arf_complaint:no_attestation",
      applicable: false,
    });
    await expect(resolveReview(db, q[0]!.id, "apply", NOW)).rejects.toMatchObject({
      kind: "cannot_apply",
    });
    expect(await resolveReview(db, q[0]!.id, "ignore", NOW)).toMatchObject({
      status: "ignored",
      suppressed: false,
    });
    expect(await supp()).toHaveLength(0);
  });
  it("arayüz etiketleri: işaretli satır 'Şikâyet raporu (ARF)'; neden etiketi ayrıştırılır; bilinmeyen kod genel metne düşer", () => {
    expect(classLabel("other", "arf_complaint")).toMatch(/ARF/);
    expect(classLabel("other", "arf_complaint:no_attestation")).toMatch(/ARF/);
    expect(classLabel("other", null)).toBe("Diğer");
    expect(reviewReasonLabel("arf_complaint:reporter_untrusted")).toMatch(/güvenilir/);
    expect(reviewReasonLabel("arf_complaint:bilinmeyen_kod_x")).toMatch(/Şikâyet raporu/);
    expect(reviewReasonLabel("arf_other_type")).toMatch(/Şikâyet dışı/);
  });
});

describe("şikâyet sayısı KISMİ kapsamdır; oran ölçülemiyor; hiçbir otomatik durdurma doğmaz", () => {
  it("doğrulanmış alıcı sayısı alt sınır olarak gösterilir; doğrulanmamışlar yalnızca 'incelemede' sayılır; oran HER ZAMAN ölçülemiyor", async () => {
    const h0 = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(h0.complaint).toEqual({
      status: "not_measurable",
      thresholdBp: 10,
      manualRecords: 0,
      arf: { coverage: "partial", windowDays: 30, verifiedRecipients: 0, pendingReview: 0 },
    });
    await feed(arf(a));
    await feed(arf(a)); // aynı alıcı ikinci rapor: BİR alıcı
    await feed(arf(b), null); // doğrulanmamış
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000);
    expect(h.complaint.status).toBe("not_measurable");
    expect(h.complaint.arf).toMatchObject({
      coverage: "partial",
      verifiedRecipients: 1,
      pendingReview: 1,
    });
  });

  it("pencere dışı (30 gün öncesi) doğrulanmış şikâyet sayıya girmez; başka posta kutusunun sayısı karışmaz", async () => {
    await feed(arf(a));
    expect(
      (await getMailboxHealth(db, DEMO_MAILBOX, NOW + 29 * 86_400_000)).complaint.arf
        .verifiedRecipients,
    ).toBe(1);
    expect(
      (await getMailboxHealth(db, DEMO_MAILBOX, NOW + 31 * 86_400_000)).complaint.arf
        .verifiedRecipients,
    ).toBe(0);
    const other = await addMailbox(db, {
      provider: "demo",
      address: "baska@universal-mail.invalid",
    });
    expect((await getMailboxHealth(db, other, NOW)).complaint.arf).toMatchObject({
      verifiedRecipients: 0,
      pendingReview: 0,
    });
  });

  it("elle girilen şikâyet kaydı ARF sayısına KATILMAZ", async () => {
    await suppressEmail(
      db,
      { email: "man@elle-alan.com", reason: "complaint", source: "manual" },
      NOW,
    );
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(h.complaint).toMatchObject({ manualRecords: 1, arf: { verifiedRecipients: 0 } });
  });

  it("çok sayıda doğrulanmış şikâyet bile kutuyu/kampanyayı OTOMATİK durdurmaz (oran güvenilir değil)", async () => {
    for (let i = 0; i < 12; i++) {
      const s = await seedSent(db, campaign, { email: `info@sikayet${i}.com` });
      expect((await feed(arf(s))).outcome).toBe("processed");
    }
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(h.complaint.arf.verifiedRecipients).toBe(12);
    expect(h.halted).toBeNull();
    expect(await getSetting(db, "mail.mailboxHalts")).toEqual({});
    const [c] = await db.select().from(settings).where(eq(settings.key, "mail.mailboxHalts"));
    expect(c).toBeUndefined();
    const { campaigns } = await import("@/lib/db/schema");
    expect((await db.select().from(campaigns).where(eq(campaigns.id, campaign)))[0]!.status).toBe(
      "running",
    );
  });
});

describe("rapor sağlayıcısı yapılandırması", () => {
  it("varsayılan boş; geçerli alan adları normalleştirilir; kök (public suffix)/geçersiz reddedilir; liste en çok 50", async () => {
    expect(await getSetting(db, "mail.arfReporters")).toEqual([REPORTER]);
    expect(
      await setTrustedReporters(
        db,
        ["FBL.Yahoo-Ornek.com", "fbl.yahoo-ornek.com", " jmrp.outlook-ornek.com "],
        NOW,
      ),
    ).toEqual(["fbl.yahoo-ornek.com", "jmrp.outlook-ornek.com"]);
    for (const bad of ["com", "co.uk", "", "yok yok", "a@b.com", "http://x.com"]) {
      await expect(setTrustedReporters(db, [bad], NOW), bad).rejects.toBeInstanceOf(ArfConfigError);
    }
    await expect(
      setTrustedReporters(
        db,
        Array.from({ length: 51 }, (_, i) => `r${i}.ornek.com`),
        NOW,
      ),
    ).rejects.toMatchObject({ code: "too_many" });
    expect(await getSetting(db, "mail.arfReporters")).toEqual([
      "fbl.yahoo-ornek.com",
      "jmrp.outlook-ornek.com",
    ]); // başarısız çağrı listeyi bozmadı
    expect((await audits("arf.reporters_set")).length).toBe(2);
  });
});
