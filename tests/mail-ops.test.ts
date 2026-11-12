import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, suppressions, templates } from "@/lib/db/schema";
import { audit } from "@/lib/db/audit";
import { listAudit, summarizeAuditDetail, exportAuditCsv } from "@/lib/audit-list";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import {
  checkDomainAuth,
  evaluateDkim,
  evaluateDmarc,
  evaluateSpf,
  type TxtResolver,
} from "@/lib/mail/dns-check";
import { exportMailLogCsv, listMailLog } from "@/lib/mail/mail-log";
import { processInbound } from "@/lib/mail/inbound/process";
import { sendTestEmail, TestSendError } from "@/lib/mail/test-send";
import {
  createUnsubscribeToken,
  processUnsubscribe,
  resetUnsubscribeRateLimitForTests,
  unsubscribeRateLimited,
  verifyUnsubscribeToken,
} from "@/lib/mail/unsubscribe-service";
import {
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox, NOW, rawDsn, seedSent, SIMULATED_DSN_PASS } from "./helpers/inbound-fixture";

let client: Client;
let db: Db;
let campaignId: number;
const KEY = "ab".repeat(32);

beforeEach(async () => {
  process.env.UM_MASTER_KEY = KEY;
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
  resetUnsubscribeRateLimitForTests();
});
afterEach(() => {
  client.close();
  delete process.env.UM_MASTER_KEY;
});

describe("çıkış belirteci (demo)", () => {
  it("üretilip doğrulanır; kişisel veri içermez", async () => {
    const s = await seedSent(db, campaignId);
    const t = createUnsubscribeToken(s.cl);
    expect(t).toMatch(/^v1\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect(t).not.toContain(s.email);
    expect(verifyUnsubscribeToken(t)).toBe(s.cl);
  });

  it("kurcalanmış, başka kimliğe taşınmış, bozuk ve uzun belirteçler geçersiz", async () => {
    const s = await seedSent(db, campaignId);
    const t = createUnsubscribeToken(s.cl);
    const [v, id, mac] = t.split(".");
    expect(verifyUnsubscribeToken(`${v}.${(s.cl + 1).toString(36)}.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${v}.${id}.${mac!.slice(0, -1)}A`)).toBeNull();
    expect(verifyUnsubscribeToken(`v2.${id}.${mac}`)).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("x".repeat(500))).toBeNull();
    expect(verifyUnsubscribeToken(`${v}.${id}`)).toBeNull();
  });

  it("başka anahtarla üretilen belirteç geçersiz; anahtar yoksa fail-closed ('unavailable')", async () => {
    const s = await seedSent(db, campaignId);
    const t = createUnsubscribeToken(s.cl);
    process.env.UM_MASTER_KEY = "cd".repeat(32);
    expect(verifyUnsubscribeToken(t)).toBeNull();
    expect(await processUnsubscribe(db, t)).toBe("invalid");
    process.env.UM_MASTER_KEY = "geçersiz";
    expect(await processUnsubscribe(db, t)).toBe("unavailable");
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("işlem suppression üretir, idempotenttir, diziyi durdurur", async () => {
    const s = await seedSent(db, campaignId);
    const t = createUnsubscribeToken(s.cl);
    expect(await processUnsubscribe(db, t, NOW)).toBe("unsubscribed");
    expect(await processUnsubscribe(db, t, NOW)).toBe("already");
    const sup = await db.select().from(suppressions);
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      reason: "unsubscribe",
      source: "link",
      emailHash: hashEmail(s.email),
    });
    const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
    expect(cl!.status).toBe("unsubscribed");
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(s.email);
  });

  it("15.10-2: durma nedeni yazılır (TB-2); bitmiş dizi `completed` kalır, neden yalnızca bağlantının dizisine (TB-10)", async () => {
    const s = await seedSent(db, campaignId);
    const done = await seedSent(db, await createCampaign(db, { status: "running" }), {
      email: s.email,
      sentAt: T0 - 3 * 86_400_000,
    });
    await db
      .update(campaignLeads)
      .set({ status: "completed" })
      .where(eq(campaignLeads.id, done.cl));
    expect(await processUnsubscribe(db, createUnsubscribeToken(s.cl), NOW)).toBe("unsubscribed");
    const rows = await db.select().from(campaignLeads);
    expect(rows.find((r) => r.id === s.cl)).toMatchObject({
      status: "unsubscribed",
      stopReason: "unsubscribe",
    });
    // Başka kampanyanın bitmiş dizisi: durumu ve nedeni değişmez (o kampanyanın sayaçlarına çıkış yazılmaz).
    expect(rows.find((r) => r.id === done.cl)).toMatchObject({
      status: "completed",
      stopReason: null,
    });
    // Bitmiş dizinin KENDİ bağlantısı: durum korunur, neden kaydedilir.
    expect(await processUnsubscribe(db, createUnsubscribeToken(done.cl), NOW)).toBe("unsubscribed");
    const [d] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, done.cl));
    expect(d).toMatchObject({ status: "completed", stopReason: "unsubscribe" });
  });

  it("var olmayan kayıt, geçersiz belirteçle aynı yanıtı verir; canlı kapsam kampanyası reddedilir", async () => {
    expect(await processUnsubscribe(db, createUnsubscribeToken(99999))).toBe("invalid");
  });

  it("hız sınırı dakikada 60 denemeden sonra devreye girer", () => {
    resetUnsubscribeRateLimitForTests();
    let limited = false;
    for (let i = 0; i < 61; i++) limited = unsubscribeRateLimited(1_000);
    expect(limited).toBe(true);
    expect(unsubscribeRateLimited(1_000 + 61_000)).toBe(false);
  });
});

describe("kendime test gönder", () => {
  async function leadAndTemplate() {
    const s = await seedSent(db, campaignId);
    const [tpl] = await db.select().from(templates).where(eq(templates.language, "en"));
    return { leadId: s.leadId, templateId: tpl!.id, s };
  }

  it("demo kutusunun kendi adresine gider; purpose=test; kampanya sayaçlarına girmez", async () => {
    const { leadId, templateId } = await leadAndTemplate();
    const provider = new FakeMailProvider();
    const before = (await db.select().from(messages)).length;
    const r = await sendTestEmail(
      db,
      { mailboxId: DEMO_MAILBOX, templateId, leadId },
      { now: () => NOW, provider },
    );
    expect(r.outcome).toBe("sent");
    expect(provider.outbox).toHaveLength(1);
    expect(provider.outbox[0]!.to).toBe("demo@universal-mail.invalid");
    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(before + 1);
    const t = rows.find((m) => m.purpose === "test")!;
    expect(t).toMatchObject({
      direction: "out",
      status: "sent",
      campaignId: null,
      idempotencyKey: null,
      sendDay: null,
    });
    expect(t.subjectLogged).toMatch(/^\[TEST\] /);
  });

  it("test iletisine gelen bounce hiçbir etki üretmez", async () => {
    const { leadId, templateId } = await leadAndTemplate();
    const provider = new FakeMailProvider();
    await sendTestEmail(
      db,
      { mailboxId: DEMO_MAILBOX, templateId, leadId },
      { now: () => NOW, provider },
    );
    const t = (await db.select().from(messages)).find((m) => m.purpose === "test")!;
    const r = await processInbound(
      db,
      {
        mailboxId: DEMO_MAILBOX,
        raw: rawDsn({
          outboundMessageId: t.rfcMessageId!,
          recipient: "demo@universal-mail.invalid",
          nonce: "tt1",
        }),
        receivedAt: NOW,
        attestation: SIMULATED_DSN_PASS,
      },
      { now: NOW },
    );
    expect(r).toMatchObject({ status: "ignored" });
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  it("saatlik sınır, canlı kapsam ve olmayan kutu reddedilir", async () => {
    const { leadId, templateId } = await leadAndTemplate();
    const provider = new FakeMailProvider();
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await sendTestEmail(
            db,
            { mailboxId: DEMO_MAILBOX, templateId, leadId },
            { now: () => NOW, provider },
          )
        ).outcome,
      ).toBe("sent");
    }
    await expect(
      sendTestEmail(
        db,
        { mailboxId: DEMO_MAILBOX, templateId, leadId },
        { now: () => NOW, provider },
      ),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    const live = await addMailbox(db, {
      provider: "gmail",
      address: "x@canli.example",
      status: "not_configured",
    });
    await expect(
      sendTestEmail(db, { mailboxId: live, templateId, leadId }, { provider }),
    ).rejects.toBeInstanceOf(TestSendError);
    await expect(
      sendTestEmail(db, { mailboxId: 999, templateId, leadId }, { provider }),
    ).rejects.toMatchObject({ kind: "mailbox_not_found" });
  });

  it("sağlayıcı reddederse 'failed' kaydedilir; sonuç belirsizse 'unknown'", async () => {
    const { leadId, templateId } = await leadAndTemplate();
    const rej = new FakeMailProvider({
      script: [{ kind: "reject", code: "denied" }, { kind: "unknown-before" }],
    });
    expect(
      await sendTestEmail(
        db,
        { mailboxId: DEMO_MAILBOX, templateId, leadId },
        { now: () => NOW, provider: rej },
      ),
    ).toMatchObject({ outcome: "failed", code: "denied" });
    expect(
      await sendTestEmail(
        db,
        { mailboxId: DEMO_MAILBOX, templateId, leadId },
        { now: () => NOW, provider: rej },
      ),
    ).toMatchObject({ outcome: "unknown" });
  });
});

describe("gönderim günlüğü ve CSV", () => {
  it("adresler maskeli; CSV'de tam adres yok; silinmiş satır kişisel veri taşımaz", async () => {
    const s = await seedSent(db, campaignId);
    const red = await seedSent(db, campaignId);
    await db
      .update(messages)
      .set({
        redactedAt: NOW,
        toAddress: null,
        fromAddress: null,
        subjectLogged: "Gizli konu",
        errorCode: "x@y.example sorunu",
      })
      .where(eq(messages.id, red.outboundId));
    const list = await listMailLog(db, {});
    const item = list.items.find((i) => i.id === s.outboundId)!;
    expect(item.peer).toBe(`i***@${s.email.split("@")[1]}`);
    const redItem = list.items.find((i) => i.id === red.outboundId)!;
    expect(redItem).toMatchObject({
      redacted: true,
      peer: null,
      subject: null,
      errorCode: null,
      campaignName: null,
    });

    let csv = "";
    for await (const c of exportMailLogCsv(db, {})) csv += c;
    expect(csv).not.toContain(s.email);
    expect(csv).not.toContain(red.email);
    expect(csv).not.toContain("Gizli konu");
    expect(csv).not.toContain("x@y.example");
    expect(csv).toContain("i***@");
    expect(csv.split("\r\n")[0]).toContain("alici_maskeli_veya_alan_adi");
  });

  it("CSV formül enjeksiyonu kaçırılır", async () => {
    const s = await seedSent(db, campaignId);
    await db
      .update(messages)
      .set({ subjectLogged: '=HYPERLINK("http://x")' })
      .where(eq(messages.id, s.outboundId));
    let csv = "";
    for await (const c of exportMailLogCsv(db, {})) csv += c;
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it("süzgeçler ve sayfalama çalışır; gelen satırda yalnızca gönderen alan adı görünür", async () => {
    const s = await seedSent(db, campaignId);
    await processInbound(
      db,
      {
        mailboxId: DEMO_MAILBOX,
        raw: rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: "ml1" }),
        receivedAt: NOW,
        attestation: SIMULATED_DSN_PASS,
      },
      { now: NOW },
    );
    const inc = await listMailLog(db, { direction: "in" });
    expect(inc.items).toHaveLength(1);
    expect(inc.items[0]!.peer).toBe("mx.demo.invalid");
    const page1 = await listMailLog(db, {}, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextBeforeId).not.toBeNull();
    expect(
      (await listMailLog(db, {}, { beforeId: page1.nextBeforeId! + 1, limit: 5 })).items.length,
    ).toBeGreaterThan(0);
  });
});

describe("işlem günlüğü özeti", () => {
  it("kişisel veri taşıyabilen işlemlerde ayrıntı boş; izinli ailelerde yalnızca güvenli alanlar", async () => {
    await audit(
      db,
      "email.added",
      "lead",
      1,
      { email: "kisi@firma.example", note: "özel not" },
      NOW,
    );
    await audit(db, "settings.updated", "settings", "x", { name: "Ayşe" }, NOW);
    await audit(
      db,
      "campaign.auto_paused",
      "campaign",
      5,
      {
        reason: "auto_bounce_rate",
        recipients: 20,
        bounced: 2,
        contactEmail: "a@b.example",
        subjectText: "gizli",
      },
      NOW,
    );
    const { items } = await listAudit(db);
    const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
    expect(byAction["email.added"]!.summary).toBe("");
    expect(byAction["settings.updated"]!.summary).toBe("");
    const s = byAction["campaign.auto_paused"]!.summary;
    expect(s).toContain("recipients=20");
    expect(s).toContain("reason=auto_bounce_rate");
    expect(s).not.toContain("@");
    expect(s).not.toContain("gizli");
    let csv = "";
    for await (const c of exportAuditCsv(db)) csv += c;
    expect(csv).not.toContain("kisi@firma.example");
    expect(csv).not.toContain("özel not");
    expect(csv).not.toContain("Ayşe");
  });

  it("serbest metin, @ içeren değer ve alan adı anahtarı özetten atılır", () => {
    const s = summarizeAuditDetail("inbound.reply", {
      inboundId: 3,
      domain: "x.example",
      who: "a@b.example",
      text: "merhaba",
      layers: "1111",
      flag: true,
      long: "x".repeat(200),
    });
    expect(s).toContain("inboundId=3");
    expect(s).toContain("layers=1111");
    expect(s).toContain("flag=true");
    expect(s).not.toContain("x.example");
    expect(s).not.toContain("@");
    expect(s).not.toContain("merhaba");
    expect(s).not.toContain("long=");
  });
});

describe("SPF / DKIM / DMARC", () => {
  it("SPF değerlendirmesi", () => {
    expect(evaluateSpf(["v=spf1 include:_spf.example.net -all"])).toMatchObject({ status: "pass" });
    expect(evaluateSpf(["v=spf1 include:a.example ~all"])).toMatchObject({
      status: "pass",
      codes: ["spf_softfail"],
    });
    expect(evaluateSpf(["v=spf1 ?all"]).status).toBe("warn");
    expect(evaluateSpf(["v=spf1 +all"])).toMatchObject({
      status: "fail",
      codes: ["spf_allows_all"],
    });
    expect(evaluateSpf(["v=spf1 mx"]).codes).toContain("spf_no_all");
    expect(evaluateSpf([])).toMatchObject({ status: "fail", codes: ["spf_missing"] });
    expect(evaluateSpf(["v=spf1 -all", "v=spf1 ~all"]).codes).toEqual(["spf_multiple"]);
    const many = `v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.example`).join(" ")} -all`;
    expect(evaluateSpf([many])).toMatchObject({ status: "fail" });
  });
  it("DMARC ve DKIM değerlendirmesi", () => {
    expect(evaluateDmarc(["v=DMARC1; p=reject; rua=mailto:r@x.example"])).toMatchObject({
      status: "pass",
      codes: ["dmarc_ok"],
    });
    expect(evaluateDmarc(["v=DMARC1; p=quarantine"]).codes).toEqual(["dmarc_no_reports"]);
    expect(evaluateDmarc(["v=DMARC1; p=none"])).toMatchObject({ status: "warn" });
    expect(evaluateDmarc([])).toMatchObject({ status: "fail" });
    expect(evaluateDmarc(["v=DMARC1; p=banana"]).status).toBe("fail");
    expect(evaluateDkim(["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3"])).toMatchObject({ status: "pass" });
    expect(evaluateDkim(["v=DKIM1; p="]).codes).toEqual(["dkim_revoked"]);
    expect(evaluateDkim([])).toMatchObject({ status: "fail" });
  });
  it("demo / ayrılmış alan adlarında DNS sorgusu ATILMAZ", async () => {
    const resolveTxt = vi.fn();
    for (const d of ["universal-mail.invalid", "firma.example", "x.test"]) {
      expect(
        await checkDomainAuth(d, { resolver: { resolveTxt } satisfies TxtResolver }),
      ).toMatchObject({ mode: "demo", spf: null });
    }
    expect(resolveTxt).not.toHaveBeenCalled();
  });
  it("gerçek alan adı için üç sorgu; DNS hatası 'uyarı' olur; geçersiz giriş reddedilir", async () => {
    const calls: string[] = [];
    const resolver: TxtResolver = {
      async resolveTxt(name) {
        calls.push(name);
        if (name.startsWith("_dmarc.")) return [["v=DMARC1; p=reject; rua=mailto:a@firma.com"]];
        if (name.includes("_domainkey")) throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
        return [["v=spf1 ", "include:x.com -all"]];
      },
    };
    const rep = await checkDomainAuth("Firma.com", { selector: "google", resolver });
    expect(calls.sort()).toEqual(["_dmarc.firma.com", "firma.com", "google._domainkey.firma.com"]);
    expect(rep).toMatchObject({
      mode: "checked",
      spf: { status: "pass" },
      dmarc: { status: "pass" },
      dkim: { status: "fail", codes: ["dkim_missing"] },
    });
    const broken: TxtResolver = {
      resolveTxt: async () => {
        throw Object.assign(new Error("t"), { code: "ETIMEOUT" });
      },
    };
    expect((await checkDomainAuth("firma.com", { resolver: broken })).spf).toMatchObject({
      status: "warn",
      codes: ["dns_error"],
    });
    await expect(checkDomainAuth("not a domain", { resolver })).rejects.toThrow("invalid_domain");
    await expect(checkDomainAuth("firma.com", { selector: "../x", resolver })).rejects.toThrow(
      "invalid_selector",
    );
  });
});

describe("tutarlılık", () => {
  it("T0 ve NOW", () => {
    expect(NOW).toBe(T0 + 3_600_000);
  });
});
