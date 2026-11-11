import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateSend } from "@/lib/compliance/eligibility";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, campaigns, leads, messages, suppressions } from "@/lib/db/schema";
import { classifyInbound } from "@/lib/mail/inbound/classify";
import { buildScenario } from "@/lib/mail/inbound/fake-inbox";
import { parseInbound } from "@/lib/mail/inbound/parse";
import { processInbound, resolveReview, ReviewError } from "@/lib/mail/inbound/process";
import { listReviewQueue } from "@/lib/mail/inbound/review-list";
import { FakeInbox } from "@/lib/mail/inbound/fake-inbox";
import { syncInbox } from "@/lib/mail/inbound/sync";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import {
  addMailbox,
  FAIL_AUTH,
  NO_NULL_PATH,
  NOW,
  rawDsn,
  rawMessage,
  seedSent,
  SIMULATED_DSN_PASS,
  SIMULATED_PASS,
} from "./helpers/inbound-fixture";

/**
 * Gelen ileti işleme (Aşama 13). Odak: Message-ID eşleşmesi TEK BAŞINA kanıt değildir; kanal tasdiki olmayan,
 * alıcısı uyuşmayan, eşleşmeyen, test iletisine ait, eski, başka posta kutusuna ait veya sahte iletiler hiçbir
 * suppression/durdurma/kampanya duraklatma üretmez.
 */

let client: Client;
let db: Db;
let campaignId: number;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
});
afterEach(() => client.close());

const run = (raw: string, attestation = SIMULATED_PASS, extra: { allowEffects?: boolean } = {}) =>
  processInbound(
    db,
    { mailboxId: DEMO_MAILBOX, raw, receivedAt: NOW, attestation },
    { now: NOW, ...extra },
  );

const clStatus = async (id: number) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, id)))[0]!.status;
const activeSuppressions = async () => db.select().from(suppressions);
const inboundRows = async () => db.select().from(messages).where(eq(messages.direction, "in"));
let n = 0;
const nonce = () => `t${++n}`;

describe("ayrıştırma sınırları ve sınıflandırma", () => {
  it("DSN alanlarını ve özgün Message-ID'yi çıkarır", async () => {
    const s = await seedSent(db, campaignId);
    const p = parseInbound(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.dsn?.structural).toBe(true);
    expect(p.dsn?.recipients).toEqual([{ address: s.email, action: "failed", status: "5.1.1" }]);
    expect(p.dsn?.originalMessageId).toBe(s.rfc);
    expect(classifyInbound(p)).toBe("bounce_hard");
  });

  it("aşırı büyük, çıplak CR/NUL, başlıksız ve çok başlıklı iletiyi reddeder", () => {
    expect(parseInbound("a".repeat(300 * 1024))).toEqual({ ok: false, reason: "too_large" });
    expect(parseInbound("From: a@b.example\r\rX: y\r\n\r\nx")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(parseInbound("From: a@b.example\0\r\n\r\nx")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(parseInbound("sadece gövde")).toMatchObject({ ok: false });
    const many = Array.from({ length: 150 }, (_, i) => `X-H${i}: v`).join("\r\n");
    expect(parseInbound(`${many}\r\n\r\nx`)).toMatchObject({
      ok: false,
      reason: "too_many_headers",
    });
  });

  it("yinelenen From/Message-ID kuşkulu sayılır; çok derin MIME sınırı çökertmez", () => {
    const dup = parseInbound("From: a@x.example\r\nFrom: b@x.example\r\nSubject: s\r\n\r\nhi");
    expect(dup.ok && dup.suspicious).toContain("duplicate_from");
    let body = "x";
    for (let i = 0; i < 8; i++) {
      body = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--\r\n`;
    }
    const deep = parseInbound(
      `From: a@x.example\r\nContent-Type: multipart/mixed; boundary="top"\r\n\r\n--top\r\n${body}\r\n--top--\r\n`,
    );
    expect(deep.ok === false || deep.suspicious.length > 0).toBe(true);
  });

  it("türleri ayırır: otomatik yanıt, çıkış, olumsuz, yanıt", () => {
    const k = (subject: string, body: string, extra: string[] = []) => {
      const p = parseInbound(
        rawMessage({
          from: "a@x.example",
          subject,
          body,
          inReplyTo: "<a.b@c.invalid>",
          nonce: nonce(),
          extraHeaders: extra,
        }),
      );
      return p.ok ? classifyInbound(p) : "x";
    };
    expect(k("Re: Hi", "I am away", ["Auto-Submitted: auto-replied"])).toBe("auto_reply");
    expect(k("Automatic reply: Hi", "away")).toBe("auto_reply");
    expect(k("Re: Hi", "Please unsubscribe me")).toBe("unsubscribe");
    expect(k("Re: Hi", "unsubscribe")).toBe("unsubscribe");
    expect(k("Re: Hi", "Thanks but we are not interested")).toBe("negative");
    expect(k("Re: Hi", "ilgilenmiyoruz")).toBe("negative");
    expect(k("Re: Hi", "Sounds good, send the catalogue")).toBe("reply");
    // Alıntıdaki metin sınıflandırmayı etkilemez.
    expect(k("Re: Hi", "Sounds good\r\n> please unsubscribe me")).toBe("reply");
  });
});

describe("doğrulanmış bounce", () => {
  it("adres-yok kalıcı bounce: suppression, dizi durur, giden ileti işaretlenir, denetim kaydı adres içermez", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ outcome: "processed", kind: "bounce_hard", status: "matched" });
    expect((r as { effects: unknown }).effects).toMatchObject({
      suppressed: true,
      sequenceStopped: true,
      bounce: "hard",
    });

    const sup = await activeSuppressions();
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      reason: "bounce_hard",
      source: "bounce",
      emailHash: hashEmail(s.email),
    });
    expect(await clStatus(s.cl)).toBe("bounced");
    const [out] = await db.select().from(messages).where(eq(messages.id, s.outboundId));
    expect(out!.deliveryStatus).toBe("bounced_hard");

    const [inb] = await inboundRows();
    expect(inb).toMatchObject({
      classification: "bounce",
      status: "matched",
      campaignLeadId: s.cl,
    });
    expect(inb!.fromAddress).toBeNull();
    expect(inb!.toAddress).toBeNull();
    const audits = JSON.stringify(await db.select().from(auditLog));
    expect(audits).not.toContain(s.email);
    expect(audits).toContain("inbound.bounce_hard");
  });

  it("aynı ham ileti ikinci kez işlenmez; farklı baytlı tekrar DSN idempotenttir", async () => {
    const s = await seedSent(db, campaignId);
    const raw = rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() });
    expect((await run(raw, SIMULATED_DSN_PASS)).outcome).toBe("processed");
    expect((await run(raw, SIMULATED_DSN_PASS)).outcome).toBe("duplicate");
    const again = rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() });
    expect((await run(again, SIMULATED_DSN_PASS)).outcome).toBe("processed");
    expect(await activeSuppressions()).toHaveLength(1);
  });

  it("geçici bounce yalnızca 'bounced_soft' işaretler; suppression ve durdurma yok", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({
        outboundMessageId: s.rfc,
        recipient: s.email,
        status: "4.2.2",
        action: "delayed",
        nonce: nonce(),
      }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ kind: "bounce_soft", status: "matched" });
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");
    const [out] = await db.select().from(messages).where(eq(messages.id, s.outboundId));
    expect(out!.deliveryStatus).toBe("bounced_soft");
  });

  it.each(["5.7.1", "5.2.2", "5.4.4", "5.0.0"])(
    "%s kalıcı ama adres-yok değil: suppression ve durdurma yok",
    async (status) => {
      const s = await seedSent(db, campaignId);
      await run(
        rawDsn({ outboundMessageId: s.rfc, recipient: s.email, status, nonce: nonce() }),
        SIMULATED_DSN_PASS,
      );
      expect(await activeSuppressions()).toHaveLength(0);
      expect(await clStatus(s.cl)).toBe("waiting_next");
      const [out] = await db.select().from(messages).where(eq(messages.id, s.outboundId));
      expect(out!.deliveryStatus).toBeNull();
    },
  );
});

describe("sahte / doğrulanmamış bounce: hiçbir etki yok", () => {
  async function expectNoEffect(s: { cl: number; outboundId: number }, expectedStatus?: string) {
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");
    const [out] = await db.select().from(messages).where(eq(messages.id, s.outboundId));
    expect(out!.deliveryStatus).toBeNull();
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.status).toBe("running");
    const [inb] = await inboundRows();
    expect(inb!.campaignLeadId).toBeNull(); // bağlantı yazılmaz: uygunluk denetimi de etkilenmez
    if (expectedStatus) expect(inb!.status).toBe(expectedStatus);
  }

  it("doğru Message-ID ama kanal tasdiki YOK → inceleme", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      null as never,
    );
    expect(r).toMatchObject({ status: "received", reviewReason: "no_attestation" });
    await expectNoEffect(s, "received");
    expect(await listReviewQueue(db)).toHaveLength(1);
  });

  it("kimlik doğrulama 'fail' veya boş zarf gönderen yok → etki yok", async () => {
    const s = await seedSent(db, campaignId);
    await run(rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }), FAIL_AUTH);
    await expectNoEffect(s);
    const s2 = await seedSent(db, campaignId);
    await run(
      rawDsn({ outboundMessageId: s2.rfc, recipient: s2.email, nonce: nonce() }),
      NO_NULL_PATH,
    );
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s2.cl)).toBe("waiting_next");
  });

  it("iletinin kendi sahte 'Authentication-Results: pass' başlığı yok sayılır", async () => {
    const s = await seedSent(db, campaignId);
    const raw = rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }).replace(
      "To: demo@",
      "Authentication-Results: mx.demo.invalid; dkim=pass; spf=pass; dmarc=pass\r\nReturn-Path: <>\r\nTo: demo@",
    );
    await run(raw, null as never);
    await expectNoEffect(s);
  });

  it("DSN yapısı sahte (multipart/report değil) → etki yok", async () => {
    const s = await seedSent(db, campaignId);
    await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, structural: false, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");
  });

  it("Message-ID doğru ama DSN'deki alıcı gerçek alıcı değil → etki yok", async () => {
    const s = await seedSent(db, campaignId);
    await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: "kurban@baska.example", nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    await expectNoEffect(s);
    expect(await activeSuppressions()).toHaveLength(0);
  });

  it("Message-ID bilinmiyor → eşleşmedi, etki yok", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({
        outboundMessageId: "<bilinmeyen.abc@universal-mail.invalid>",
        recipient: s.email,
        nonce: nonce(),
      }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ status: "unmatched", reviewReason: "no_match" });
    await expectNoEffect(s, "unmatched");
  });

  it("başka posta kutusunun gönderdiği ileti kimliği → etki yok", async () => {
    const other = await addMailbox(db, {
      provider: "demo",
      address: "baska@universal-mail.invalid",
    });
    const s = await seedSent(db, campaignId, { mailboxId: other });
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ reviewReason: "match_invalid" });
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");
  });

  it("test gönderimine gelen bounce yok sayılır", async () => {
    const s = await seedSent(db, campaignId, { purpose: "test" });
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    expect(r).toMatchObject({ status: "ignored", reviewReason: "test_message" });
    expect(await activeSuppressions()).toHaveLength(0);
  });

  it("30 günden eski gönderim ve henüz kabul edilmemiş ileti eşleşmez", async () => {
    const old = await seedSent(db, campaignId, { sentAt: NOW - 31 * 86_400_000 });
    await run(
      rawDsn({ outboundMessageId: old.rfc, recipient: old.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    const unsent = await seedSent(db, campaignId, { status: "unknown" });
    await run(
      rawDsn({ outboundMessageId: unsent.rfc, recipient: unsent.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
    );
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(old.cl)).toBe("waiting_next");
  });

  it("kendi posta kutumuzdan gelen ileti (döngü) etki üretmez", async () => {
    const s = await seedSent(db, campaignId);
    const raw = rawDsn({
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
      from: "demo@universal-mail.invalid",
    });
    await run(raw, SIMULATED_DSN_PASS);
    expect(await activeSuppressions()).toHaveLength(0);
  });

  it("canlı kapsamlı posta kutusu ve olmayan kutu reddedilir; hiçbir kayıt yazılmaz", async () => {
    const live = await addMailbox(db, {
      provider: "gmail",
      address: "x@canli.example",
      status: "not_configured",
    });
    const s = await seedSent(db, campaignId);
    const raw = rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() });
    expect(
      await processInbound(
        db,
        { mailboxId: live, raw, receivedAt: NOW, attestation: SIMULATED_DSN_PASS },
        { now: NOW },
      ),
    ).toEqual({ outcome: "rejected", code: "live_scope" });
    expect(
      await processInbound(
        db,
        { mailboxId: 9999, raw, receivedAt: NOW, attestation: SIMULATED_DSN_PASS },
        { now: NOW },
      ),
    ).toEqual({ outcome: "rejected", code: "mailbox_not_found" });
    expect(await inboundRows()).toHaveLength(0);
  });

  it("bozuk / aşırı büyük ileti yalnızca 'yok sayıldı' olarak kaydedilir", async () => {
    const r = await run("a".repeat(300 * 1024));
    expect(r).toMatchObject({ kind: "unparseable", status: "ignored" });
    expect(await activeSuppressions()).toHaveLength(0);
  });
});

describe("yanıt, çıkış ve olumsuz ifade", () => {
  it("doğrulanmış yanıt: dizi 'replied', lead 'replied'; takip denetimi yanıt nedeniyle engellenir", async () => {
    const s = await seedSent(db, campaignId);
    const { raw, attestation } = buildScenario({
      scenario: "reply",
      mailboxAddress: "demo@universal-mail.invalid",
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
    });
    const r = await run(raw, attestation!);
    expect(r).toMatchObject({ kind: "reply", status: "matched" });
    expect(await clStatus(s.cl)).toBe("replied");
    const [lead] = await db.select().from(leads).where(eq(leads.id, s.leadId));
    expect(lead!.status).toBe("replied");
    const ev = await evaluateSend(
      db,
      { campaignLeadId: s.cl, stepIndex: 1 },
      { now: NOW + 6 * 86_400_000 },
    );
    expect(ev.eligible).toBe(false);
  });

  it("tasdiksiz yanıt → inceleme; dizi ve uygunluk etkilenmez", async () => {
    const s = await seedSent(db, campaignId);
    const { raw } = buildScenario({
      scenario: "reply_unattested",
      mailboxAddress: "demo@universal-mail.invalid",
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
    });
    const r = await run(raw, null as never);
    expect(r).toMatchObject({ status: "received", reviewReason: "no_attestation" });
    expect(await clStatus(s.cl)).toBe("waiting_next");
    const ev = await evaluateSend(
      db,
      { campaignLeadId: s.cl, stepIndex: 1 },
      { now: NOW + 6 * 86_400_000 },
    );
    expect(ev.reasons.map((x) => x.code)).not.toContain("reply_received");
  });

  it("Message-ID doğru ama yanıtı yazan farklı kişi (aynı alan adı bile) → etki yok", async () => {
    const s = await seedSent(db, campaignId);
    const dom = s.email.split("@")[1];
    const raw = rawMessage({ from: `baska@${dom}`, inReplyTo: s.rfc, nonce: nonce() });
    const r = await run(raw);
    expect(r).toMatchObject({ reviewReason: "recipient_mismatch" });
    expect(await clStatus(s.cl)).toBe("waiting_next");
  });

  it("doğrulanmış çıkış talebi: suppression (unsubscribe/inbox) ve dizi 'unsubscribed'", async () => {
    const s = await seedSent(db, campaignId);
    const { raw, attestation } = buildScenario({
      scenario: "unsubscribe",
      mailboxAddress: "demo@universal-mail.invalid",
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
    });
    const r = await run(raw, attestation!);
    expect(r).toMatchObject({ kind: "unsubscribe", status: "matched" });
    const sup = await activeSuppressions();
    expect(sup[0]).toMatchObject({ reason: "unsubscribe", source: "inbox" });
    expect(await clStatus(s.cl)).toBe("unsubscribed");
  });

  it("çıkış talebi: tasdiksiz veya yabancı gönderenden gelirse suppression YOK", async () => {
    const s = await seedSent(db, campaignId);
    const raw = rawMessage({
      from: s.email,
      inReplyTo: s.rfc,
      body: "Please unsubscribe me",
      nonce: nonce(),
    });
    await run(raw, null as never);
    const raw2 = rawMessage({
      from: "kurban@baska.example",
      inReplyTo: s.rfc,
      body: "Please unsubscribe me",
      nonce: nonce(),
    });
    await run(raw2, SIMULATED_PASS);
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");
  });

  it("olumsuz ifade ASLA otomatik suppression üretmez; kullanıcı 'uygula' derse üretir", async () => {
    const s = await seedSent(db, campaignId);
    const { raw, attestation } = buildScenario({
      scenario: "negative",
      mailboxAddress: "demo@universal-mail.invalid",
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
    });
    const r = await run(raw, attestation!);
    expect(r).toMatchObject({
      kind: "negative",
      status: "received",
      reviewReason: "negative_needs_review",
    });
    expect(await activeSuppressions()).toHaveLength(0);
    expect(await clStatus(s.cl)).toBe("waiting_next");

    const queue = await listReviewQueue(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ classification: "negative", applicable: true });
    const done = await resolveReview(db, (r as { inboundId: number }).inboundId, "apply", NOW);
    expect(done).toEqual({ status: "matched", suppressed: true });
    expect((await activeSuppressions())[0]).toMatchObject({
      reason: "negative_reply",
      source: "inbox",
    });
    expect(await clStatus(s.cl)).toBe("unsubscribed");
    await expect(
      resolveReview(db, (r as { inboundId: number }).inboundId, "ignore"),
    ).rejects.toBeInstanceOf(ReviewError);
  });

  it("inceleme 'yok say' etki üretmez; bounce için 'uygula' desteklenmez", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      null as never,
    );
    const id = (r as { inboundId: number }).inboundId;
    await expect(resolveReview(db, id, "apply")).rejects.toMatchObject({ kind: "cannot_apply" });
    expect(await resolveReview(db, id, "ignore", NOW)).toMatchObject({
      status: "ignored",
      suppressed: false,
    });
    expect(await activeSuppressions()).toHaveLength(0);
    await expect(resolveReview(db, 99999, "ignore")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("incelemede alıcı uyuşmazsa 'uygula' reddedilir", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawMessage({
        from: "baska@yabanci.example",
        inReplyTo: s.rfc,
        body: "no thanks, not interested",
        nonce: nonce(),
      }),
      SIMULATED_PASS,
    );
    expect(r).toMatchObject({ status: "received" });
    await expect(
      resolveReview(db, (r as { inboundId: number }).inboundId, "apply"),
    ).rejects.toMatchObject({ kind: "cannot_apply" });
  });

  it("otomatik yanıt yok sayılır; takip akışı sürer", async () => {
    const s = await seedSent(db, campaignId);
    const { raw, attestation } = buildScenario({
      scenario: "auto_reply",
      mailboxAddress: "demo@universal-mail.invalid",
      outboundMessageId: s.rfc,
      recipient: s.email,
      nonce: nonce(),
    });
    expect(await run(raw, attestation!)).toMatchObject({ kind: "auto_reply", status: "ignored" });
    expect(await clStatus(s.cl)).toBe("waiting_next");
  });
});

describe("sel koruması ve otomatik durdurma", () => {
  it("allowEffects=false iken doğrulanmış bounce bile yalnızca inceleme olur", async () => {
    const s = await seedSent(db, campaignId);
    const r = await run(
      rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      SIMULATED_DSN_PASS,
      { allowEffects: false },
    );
    expect(r).toMatchObject({ status: "received", reviewReason: "flood_guard" });
    expect(await activeSuppressions()).toHaveLength(0);
  });

  it("tek turda en çok 50 otomatik etki; fazlası incelemeye düşer ve uyarı denetim kaydı yazılır", async () => {
    const inbox = new FakeInbox();
    for (let i = 0; i < 60; i++) {
      const s = await seedSent(db, campaignId);
      inbox.deliver({
        mailboxId: DEMO_MAILBOX,
        raw: rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
        receivedAt: NOW,
        attestation: SIMULATED_DSN_PASS,
      });
    }
    const sum = await syncInbox(db, inbox, DEMO_MAILBOX, { now: () => NOW });
    expect(sum).toMatchObject({ fetched: 60, effects: 50, floodGuard: true, needsReview: 10 });
    expect(await activeSuppressions()).toHaveLength(50);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain("inbound.flood_guard");
  });

  it("eşitleme turu tekrarında aynı iletiler yinelenmiş sayılır (imleç ilerler)", async () => {
    const inbox = new FakeInbox();
    const s = await seedSent(db, campaignId);
    inbox.deliver({
      mailboxId: DEMO_MAILBOX,
      raw: rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
      receivedAt: NOW,
      attestation: SIMULATED_DSN_PASS,
    });
    expect((await syncInbox(db, inbox, DEMO_MAILBOX, { now: () => NOW })).processed).toBe(1);
    expect((await syncInbox(db, inbox, DEMO_MAILBOX, { now: () => NOW })).fetched).toBe(0);
  });

  it("20 alıcıda 2 doğrulanmış bounce kampanyayı duraklatır; ilk bounce ve sahte bounce duraklatmaz", async () => {
    const all: Awaited<ReturnType<typeof seedSent>>[] = [];
    for (let i = 0; i < 20; i++) all.push(await seedSent(db, campaignId));
    const bounce = (s: (typeof all)[number], att = SIMULATED_DSN_PASS as never) =>
      run(rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }), att);
    const status = async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!;

    // Sahte (tasdiksiz) bounce'lar kaç tane olursa olsun duraklatmaz.
    for (let i = 0; i < 5; i++) await bounce(all[i]!, null as never);
    expect((await status()).status).toBe("running");

    await bounce(all[5]!);
    expect((await status()).status).toBe("running"); // 1/20: bounce sayısı yetersiz
    const r = await bounce(all[6]!);
    expect(r).toMatchObject({ effects: { campaignPaused: true } });
    const c = await status();
    expect(c).toMatchObject({ status: "paused", pauseReason: "auto_bounce_rate" });
    const a = (await db.select().from(auditLog)).filter((x) => x.action === "campaign.auto_paused");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatchObject({
      recipients: 20,
      bounced: 2,
      minRecipients: 20,
      minBounces: 2,
      minRateBp: 500,
    });
  });

  it("19 alıcıda 2 bounce duraklatmaz (asgari alıcı sayısı)", async () => {
    const all: Awaited<ReturnType<typeof seedSent>>[] = [];
    for (let i = 0; i < 19; i++) all.push(await seedSent(db, campaignId));
    for (const s of all.slice(0, 2))
      await run(
        rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
        SIMULATED_DSN_PASS,
      );
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.status).toBe("running");
  });

  it("duraklatılmış / başka durumdaki kampanya yeniden duraklatılmaz (yalnızca running)", async () => {
    const paused = await createCampaign(db, { status: "paused" });
    const all: Awaited<ReturnType<typeof seedSent>>[] = [];
    for (let i = 0; i < 20; i++) all.push(await seedSent(db, paused));
    for (const s of all.slice(0, 3))
      await run(
        rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: nonce() }),
        SIMULATED_DSN_PASS,
      );
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, paused));
    expect(c).toMatchObject({ status: "paused", pauseReason: null });
    const a = (await db.select().from(auditLog)).filter((x) => x.action === "campaign.auto_paused");
    expect(a).toHaveLength(0);
  });
});

describe("kayıt gizliliği", () => {
  it("gelen satırda gönderen adresi, alıcı adresi ve gövde saklanmaz", async () => {
    const s = await seedSent(db, campaignId);
    const raw = rawMessage({
      from: s.email,
      inReplyTo: s.rfc,
      body: "Gizli içerik: 12345",
      nonce: nonce(),
    });
    await run(raw);
    const dump = JSON.stringify(await inboundRows());
    expect(dump).not.toContain(s.email);
    expect(dump).not.toContain("Gizli içerik");
    const [row] = await inboundRows();
    expect(row!.subjectLogged).toBeNull();
    expect(row!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    // Suppression kaydı açık adres tutmaz.
    expect(JSON.stringify(await activeSuppressions())).not.toContain(s.email);
  });
});
