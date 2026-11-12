import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as liftRoute from "@/app/api/compliance/suppressions/[id]/lift/route";
import * as suppressionsRoute from "@/app/api/compliance/suppressions/route";
import { sequenceStatusLabel } from "@/features/campaigns/model";
import { classLabel } from "@/features/mail-log/model";
import { listAudit } from "@/lib/audit-list";
import { addLeadsToCampaign, listCampaignQueue } from "@/lib/campaigns/enrollment";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import {
  hashEmail,
  importSuppressionsCsv,
  liftProtectedSuppression,
  suppressEmail,
} from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, campaigns, messages, suppressions } from "@/lib/db/schema";
import { t } from "@/lib/i18n";
import { setTrustedReporters } from "@/lib/mail/inbound/arf";
import { processInbound } from "@/lib/mail/inbound/process";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import type { MailProvider } from "@/lib/mail/provider/provider";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { getMailboxHealth } from "@/lib/mail/mailbox-health";
import { createCampaign, DEMO_MAILBOX, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import {
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
 * ARF şikâyeti sonrası güvenlik incelemesi (Aşama 15.8): durdurulan dizilerin yeniden etkinleşmemesi, korumalı engel,
 * tekrar işleme, sahte rapor, şikâyet–çıkış ayrımı. Bellek içi veritabanı; gerçek ağ/hesap yok.
 */

const REPORTER = "fbl.reporter-ornek.com";
const RCPT = "info@alici-ornek.com";
const RCPT2 = "sales@diger-alan.com";
const HANDLE = "__umDbHandle";
const ORIGIN = "http://127.0.0.1:3000";

let client: Client;
let db: Db;
let campaign: number;
let a: Sent;
let b: Sent;
let n = 0;
let calls = 0;
const provider: MailProvider = {
  id: "demo",
  send: async () => {
    calls++;
    return { status: "accepted", providerMessageId: "x", acceptedAt: NOW };
  },
};

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  campaign = await createCampaign(db, { status: "running" });
  a = await seedSent(db, campaign, { email: RCPT });
  b = await seedSent(db, campaign, { email: RCPT2 });
  await setTrustedReporters(db, [REPORTER], NOW);
  n = 0;
  calls = 0;
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

const arf = (s: Sent, over: Partial<Parameters<typeof rawArf>[0]> = {}) =>
  rawArf({ outboundMessageId: s.rfc, rcptTo: s.email, nonce: `r${++n}`, ...over });
const feed = (
  raw: string,
  attestation: typeof SIMULATED_PASS | typeof SIMULATED_DSN_PASS | null = SIMULATED_PASS,
  now = NOW,
) => processInbound(db, { mailboxId: DEMO_MAILBOX, raw, receivedAt: now, attestation }, { now });
const supp = () => db.select().from(suppressions);
const active = async () => (await supp()).filter((s) => s.liftedAt === null);
const cl = async (s: Sent) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl)))[0]!;
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const step = (s: Sent, now = NOW + 3_600_000) =>
  sendCampaignStep(db, { campaignLeadId: s.cl, stepIndex: 0 }, { now: () => now, provider });

/* ---------------------------------------------------------------------------------------------- */

describe("1) şikâyetle durdurulan dizi yeniden etkinleşemez ('unsubscribed' geçici durumu)", () => {
  beforeEach(async () => {
    expect((await feed(arf(a))).outcome).toBe("processed");
  });

  it("dizi durur ve ŞİKÂYET işaretiyle ayrılır (çıkış talebiyle karışmaz)", async () => {
    expect(await cl(a)).toMatchObject({
      status: "unsubscribed",
      nextSendAt: null,
      exclusionReasons: ["arf_complaint"],
    });
    expect(await cl(b)).toMatchObject({ status: "waiting_next", exclusionReasons: [] });
  });

  it("gönderim denemesi reddedilir; sağlayıcı çağrılmaz (durum + engel çift güvence)", async () => {
    expect((await step(a)).outcome).toBe("ineligible");
    // durum bir hata sonucu 'waiting_next'e geri alınsa bile ENGEL gönderimi durdurur
    await db
      .update(campaignLeads)
      .set({ status: "waiting_next", nextSendAt: NOW })
      .where(eq(campaignLeads.id, a.cl));
    const out = await step(a);
    expect(out.outcome).toBe("ineligible");
    expect((out as { reasons: { code: string }[] }).reasons.map((r) => r.code)).toContain(
      "suppressed",
    );
    expect(calls).toBe(0);
    expect(await db.select().from(messages).where(eq(messages.status, "sending"))).toHaveLength(0);
  });

  it("dağıtıcı turu durdurulmuş diziyi (hatalı 'nextSendAt' dolu olsa bile) ASLA göndermez ve durumunu değiştirmez", async () => {
    await db
      .update(campaignLeads)
      .set({ nextSendAt: NOW - 1000 })
      .where(eq(campaignLeads.id, a.cl));
    const before = (await db.select().from(messages).where(eq(messages.direction, "out"))).length;
    await new MailDispatcher(db).dispatchOnce({ now: () => NOW + 3_600_000, provider });
    expect((await db.select().from(messages).where(eq(messages.direction, "out"))).length).toBe(
      before,
    );
    expect((await cl(a)).status).toBe("unsubscribed");
    expect(calls).toBe(0);
  });

  it("kampanya duraklat/devam ettir/yeniden başlat diziyi canlandırmaz", async () => {
    await transitionCampaign(db, campaign, "pause", { now: NOW });
    await transitionCampaign(db, campaign, "resume", {
      now: NOW + 1000,
      env: { FAZ3_DEMO_SCHEDULER_ENABLED: "1" },
    }).catch(() => undefined);
    expect((await cl(a)).status).toBe("unsubscribed");
    expect((await cl(a)).exclusionReasons).toEqual(["arf_complaint"]);
  });

  it("aynı alıcıyı yeni bir kampanyaya eklemek engellenir (suppressed) ve dizi oluşmaz", async () => {
    const c2 = await createCampaign(db, { status: "running" });
    await db.update(campaigns).set({ status: "draft" }).where(eq(campaigns.id, c2));
    const r = await addLeadsToCampaign(db, c2, [a.leadId], { now: NOW + 1000 });
    expect(r.added).toBe(0);
    expect(r.excluded[0]!.reasons).toContain("suppressed");
  });

  it("gönderim sürerken (in_flight) gelen şikâyet: dizi durumu değişmez ama engel yazılır; sonuç kaydedilince gönderim yapılamaz", async () => {
    // yeni alıcı: gönderimde
    const c = await seedSent(db, campaign, { email: "team@yolda-alan.com" });
    await db.update(campaignLeads).set({ status: "in_flight" }).where(eq(campaignLeads.id, c.cl));
    const r = await feed(arf(c));
    expect(r).toMatchObject({ status: "matched" });
    expect((await cl(c)).status).toBe("in_flight"); // LINKABLE_FROM dışında: dokunulmaz
    expect((await active()).some((s) => s.emailHash === hashEmail("team@yolda-alan.com"))).toBe(
      true,
    );
    // gönderim sonucu kaydedilir (kayıt yolu 'waiting_next' yazar); sonraki adım artık engellidir
    await db
      .update(campaignLeads)
      .set({ status: "waiting_next", nextSendAt: NOW })
      .where(eq(campaignLeads.id, c.cl));
    expect((await step(c, NOW + 6 * 86_400_000)).outcome).toBe("ineligible");
    expect(calls).toBe(0);
  });
});

describe("2) şikâyet engeli sıradan işlemle silinemez veya zayıflatılamaz", () => {
  beforeEach(async () => {
    await feed(arf(a));
  });

  it("sıradan kaldırma servisi ve API reddeder; engel aktif kalır", async () => {
    const [sup] = await active();
    const res = await liftRoute.POST(
      new Request(`${ORIGIN}/api/compliance/suppressions/${sup!.id}/lift`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
        body: JSON.stringify({
          confirm: true,
          justification: "Elle kaldırma denemesi için gerekçe",
        }),
      }),
      { params: Promise.resolve({ id: String(sup!.id) }) },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await active()).toHaveLength(1);
    expect((await audits("suppression.lifted")).length).toBe(0);
  });

  it("daha zayıf nedenler (manuel, olumsuz yanıt, bounce, çıkış) eklenince neden ZAYIFLAMAZ", async () => {
    for (const reason of ["manual", "negative_reply", "bounce_hard", "unsubscribe"] as const) {
      const r = await suppressEmail(db, { email: RCPT, reason, source: "manual" }, NOW + 1);
      expect(r.outcome, reason).toBe("existing");
      expect(r.reason, reason).toBe("complaint");
    }
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("complaint");
    expect((await audits("suppression.strengthened")).length).toBe(0);
  });

  it("CSV içe aktarma aynı adresi zayıf nedenle yazsa da şikâyet engeli korunur", async () => {
    const csv = `email,reason\n${RCPT},manual\n`;
    const report = await importSuppressionsCsv(db, csv, NOW + 1);
    expect(report).toMatchObject({ added: 0, strengthened: 0, duplicates: 1, invalid: [] });
    const rows = await active();
    expect(rows.filter((r) => r.emailHash === hashEmail(RCPT))).toHaveLength(1);
    expect(rows.find((r) => r.emailHash === hashEmail(RCPT))!.reason).toBe("complaint");
  });

  it("YALNIZCA daha güçlü neden (silme talebi) güçlendirir", async () => {
    const r = await suppressEmail(
      db,
      { email: RCPT, reason: "erasure", source: "manual" },
      NOW + 1,
    );
    expect(r.outcome).toBe("strengthened");
    expect((await active())[0]!.reason).toBe("erasure");
  });

  it("korumalı kaldırma yalnızca belgelenmiş talep ve açık onayla (arayüze/API'ye bağlı değil)", async () => {
    const [sup] = await active();
    await expect(
      liftProtectedSuppression(db, { id: sup!.id, confirm: true }, NOW),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    await liftProtectedSuppression(
      db,
      {
        id: sup!.id,
        confirm: "ALICI_TALEBI_DOGRULANDI",
        basis: "recipient_request",
        evidenceRef: "talep-7",
        justification: "Alıcı yazılı olarak yeniden iletişim istedi",
      },
      NOW + 2,
    );
    expect(await active()).toHaveLength(0);
    expect((await audits("suppression.lifted")).length).toBe(1);
  });

  it("kaynak kodda engel tablosunu değiştiren TEK modül suppression.ts'tir; API'de silme/güncelleme ucu yoktur", () => {
    const root = path.resolve(__dirname, "..", "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(e.name) &&
          /(update|delete)\(suppressions\)/.test(fs.readFileSync(p, "utf8"))
        ) {
          hits.push(path.relative(root, p).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(["lib/compliance/suppression.ts"]);
    const r = suppressionsRoute as Record<string, unknown>;
    for (const m of ["DELETE", "PUT", "PATCH"]) expect(r[m], m).toBeUndefined();
  });
});

describe("3) aynı ARF'nin tekrar işlenmesi çift engel veya yanlış sayaç üretmez", () => {
  const verifiedCount = async () =>
    (await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000)).complaint.arf.verifiedRecipients;

  it("aynı ham rapor: 'duplicate'; engel, denetim ve sayaç değişmez", async () => {
    const raw = arf(a);
    await feed(raw);
    const snap = JSON.stringify([
      await supp(),
      (await audits("inbound.complaint")).length,
      await verifiedCount(),
    ]);
    for (let i = 0; i < 3; i++) expect((await feed(raw)).outcome).toBe("duplicate");
    expect(
      JSON.stringify([
        await supp(),
        (await audits("inbound.complaint")).length,
        await verifiedCount(),
      ]),
    ).toBe(snap);
    expect((await db.select().from(messages).where(eq(messages.direction, "in"))).length).toBe(1);
  });

  it("aynı alıcı hakkında FARKLI iki rapor: tek engel, sayaç 1 alıcı", async () => {
    await feed(arf(a));
    await feed(arf(a));
    await feed(arf(a, { rcptTo: null, originalTo: null }));
    expect(await supp()).toHaveLength(1);
    expect(await verifiedCount()).toBe(1);
  });

  it("engel belgelenmiş talepte kaldırıldıktan sonra: eski raporun tekrarı yeniden engel koymaz; YENİ bir rapor koyar", async () => {
    const raw = arf(a);
    await feed(raw);
    const [sup] = await active();
    await liftProtectedSuppression(
      db,
      {
        id: sup!.id,
        confirm: "ALICI_TALEBI_DOGRULANDI",
        basis: "recipient_request",
        evidenceRef: "talep-9",
        justification: "Alıcı yeniden iletişim istedi",
      },
      NOW + 5,
    );
    expect((await feed(raw)).outcome).toBe("duplicate");
    expect(await active()).toHaveLength(0);
    expect((await feed(arf(a))).outcome).toBe("processed"); // gerçekten yeni şikâyet
    expect(await active()).toHaveLength(1);
    expect(await verifiedCount()).toBe(1); // aynı alıcı: tek
  });

  it("doğrulanmamış raporun tekrarı da tek satırdır (incelemede bekleyen sayısı şişmez)", async () => {
    const raw = arf(a);
    await feed(raw, null);
    await feed(raw, null);
    await feed(raw, null);
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000);
    expect(h.complaint.arf).toMatchObject({ verifiedRecipients: 0, pendingReview: 1 });
  });
});

describe("4) doğrulanmamış / sahte ARF: durdurma, engel ve doğrulanmış sayaç YOK", () => {
  const nothing = async () => {
    expect(await supp()).toHaveLength(0);
    expect((await cl(a)).status).toBe("waiting_next");
    expect((await cl(b)).status).toBe("waiting_next");
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000);
    expect(h.complaint.arf.verifiedRecipients).toBe(0);
    const rows = await db.select().from(messages).where(eq(messages.direction, "in"));
    expect(rows.some((r) => r.errorCode === "arf_complaint")).toBe(false);
    expect(rows.every((r) => r.campaignLeadId === null || r.status === "ignored")).toBe(true);
    // bounce sayaçlarına/teslim durumuna dokunulmaz
    const out = await db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out.every((m) => m.deliveryStatus === null)).toBe(true);
  };

  it("sahte gönderen kimliği: görünen ad güvenilir adres olsa da GERÇEK adres başkaysa; benzer alan adları; alt alan adı", async () => {
    const spoofs = [
      `"fbl@${REPORTER}" <fbl@kotu-alan.com>`,
      `fbl@${REPORTER}.kotu-alan.com`,
      `fbl@x${REPORTER}`,
      `fbl@${REPORTER.replace(".com", ".co")}`,
      `fbl@sub.${REPORTER}`,
      `fbl@kotu.com`,
    ];
    for (const from of spoofs) {
      const raw = arf(a).replace(/^From: .*$/m, `From: ${from}`);
      const r = await feed(raw);
      expect(r, from).toMatchObject({ outcome: "processed", status: "received" });
    }
    await nothing();
  });

  it("alan adı büyük/küçük harf farkı güvenilir sayılır (DNS büyük/küçük harf duyarsız) ama yine de tüm kanıtlar gerekir", async () => {
    const raw = arf(a).replace(/^From: .*$/m, `From: <FBL@${REPORTER.toUpperCase()}>`);
    expect(await feed(raw, null)).toMatchObject({
      status: "received",
      reviewReason: "no_attestation",
    });
    await nothing();
  });

  it("normal yanıt/DSN/otomatik yanıt içine gömülü ARF yapısı rapor SAYILMAZ; bounce kanıtı şikâyet doğrulamaz", async () => {
    // DSN: şikâyet sayacı ve engeli oluşturmaz (bounce yoluna gider)
    const dsnRaw = rawDsn({
      outboundMessageId: a.rfc,
      recipient: RCPT,
      nonce: "d1",
      status: "4.2.2",
      action: "delayed",
    });
    await feed(dsnRaw, SIMULATED_DSN_PASS);
    // yanıt: "abuse" "spam" sözcükleri şikâyet yapmaz
    await feed(
      rawMessage({
        from: RCPT2,
        inReplyTo: b.rfc,
        nonce: "p1",
        body: "this is spam and abuse, feedback-report",
      }),
      SIMULATED_PASS,
    );
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000);
    expect(h.complaint.arf).toMatchObject({ verifiedRecipients: 0, pendingReview: 0 });
    expect((await supp()).filter((s) => s.reason === "complaint")).toHaveLength(0);
  });

  it("rapor türü ARF değilse (multipart/mixed, report-type=delivery-status) aynı gövde şikâyet DOĞURMAZ", async () => {
    for (const reportType of [null, "delivery-status", "disposition-notification"]) {
      const r = await feed(arf(a, { reportType }));
      expect(r, String(reportType)).toMatchObject({ outcome: "processed" });
      expect((r as { kind: string }).kind).not.toBe("complaint");
    }
    expect((await supp()).filter((s) => s.reason === "complaint")).toHaveLength(0);
  });

  it("tasdik yok/başarısız veya güvenilir liste boş: inceleme; sayaç yok", async () => {
    await feed(arf(a), null);
    await setTrustedReporters(db, [], NOW);
    await feed(arf(b));
    await nothing();
    const h = await getMailboxHealth(db, DEMO_MAILBOX, NOW + 1000);
    expect(h.complaint.arf.pendingReview).toBe(2);
  });
});

describe("5) şikâyet ve çıkış ayrı nedenler olarak denetimde ve arayüzde ayırt edilir", () => {
  it("denetim: şikâyet → inbound.complaint + suppression.added(reason=complaint); çıkış → inbound.unsubscribe + reason=unsubscribe", async () => {
    await feed(arf(a));
    await feed(
      rawMessage({
        from: RCPT2,
        inReplyTo: b.rfc,
        nonce: "u1",
        body: "Please unsubscribe me from your list.",
      }),
      SIMULATED_PASS,
    );
    expect((await audits("inbound.complaint")).length).toBe(1);
    expect((await audits("inbound.unsubscribe")).length).toBe(1);
    const { items } = await listAudit(db, { actionPrefix: "suppression.added" });
    const sums = items.map((i) => i.summary);
    expect(sums.some((s) => s.includes("reason=complaint") && s.includes("source=inbox"))).toBe(
      true,
    );
    expect(sums.some((s) => s.includes("reason=unsubscribe") && s.includes("source=inbox"))).toBe(
      true,
    );
    const all = (await listAudit(db, { actionPrefix: "inbound." })).items.map((i) => i.action);
    expect(all).toContain("inbound.complaint");
    expect(all).toContain("inbound.unsubscribe");
    const dump = JSON.stringify(items) + JSON.stringify(await audits("inbound.complaint"));
    expect(dump).not.toContain(RCPT);
  });

  it("çıkış sonra şikâyet: neden 'unsubscribe' → 'complaint' güçlendirilir ve bu AYRI bir denetim kaydıdır", async () => {
    await feed(
      rawMessage({
        from: RCPT,
        inReplyTo: a.rfc,
        nonce: "u2",
        body: "Please unsubscribe me from your list.",
      }),
      SIMULATED_PASS,
    );
    expect((await active())[0]!.reason).toBe("unsubscribe");
    await feed(arf(a));
    expect((await active())[0]!.reason).toBe("complaint");
    const [s] = await audits("suppression.strengthened");
    expect(s!.detail).toMatchObject({ from: "unsubscribe", to: "complaint" });
  });

  it("şikâyet sonra çıkış: neden 'complaint' kalır (zayıflamaz)", async () => {
    await feed(arf(a));
    await feed(
      rawMessage({
        from: RCPT,
        inReplyTo: a.rfc,
        nonce: "u3",
        body: "Please unsubscribe me from your list.",
      }),
      SIMULATED_PASS,
    );
    expect((await active())[0]!.reason).toBe("complaint");
  });

  it("arayüz: dizi rozeti, kuyruk gerekçesi, gelen ileti ve engel nedeni etiketleri farklıdır", async () => {
    await feed(arf(a));
    await feed(
      rawMessage({
        from: RCPT2,
        inReplyTo: b.rfc,
        nonce: "u4",
        body: "Please unsubscribe me from your list.",
      }),
      SIMULATED_PASS,
    );
    const ca = await cl(a);
    const cb = await cl(b);
    // 15.10-2: nedenler sütundan (ca.stopReason) da, eski işaretten de aynı etikete varır
    expect(ca.stopReason).toBe("complaint");
    expect(cb.stopReason).toBe("unsubscribe");
    expect(sequenceStatusLabel(ca.status, ca.exclusionReasons, ca.stopReason)).toBe(
      "Şikâyet nedeniyle durdu",
    );
    expect(sequenceStatusLabel(ca.status, ca.exclusionReasons)).toBe("Şikâyet nedeniyle durdu");
    expect(sequenceStatusLabel(cb.status, cb.exclusionReasons, cb.stopReason)).toBe(
      "Listeden çıktı",
    );
    // durum başka ise işaret etkisizdir
    expect(sequenceStatusLabel("removed", ["arf_complaint"])).not.toMatch(/Şikâyet nedeniyle/);
    // kuyruk API'si işareti taşır
    const q = await listCampaignQueue(db, campaign, {});
    const byId = new Map(q.items.map((i) => [i.id, i]));
    expect(byId.get(a.cl)!.exclusionReasons).toEqual(["arf_complaint"]);
    expect(byId.get(b.cl)!.exclusionReasons).toEqual([]);
    expect(byId.get(a.cl)!.stopReason).toBe("complaint");
    expect(byId.get(b.cl)!.stopReason).toBe("unsubscribe");
    // gelen iletiler
    const inb = await db.select().from(messages).where(eq(messages.direction, "in"));
    const labels = inb.map((m) => classLabel(m.classification, m.errorCode));
    expect(labels).toContain("Şikâyet raporu (ARF)");
    expect(labels).toContain("Çıkış talebi");
    // engel nedeni etiketleri
    expect(t("supReason.complaint")).not.toBe(t("supReason.unsubscribe"));
    expect(t("reason.arf_complaint")).toMatch(/Şikâyet/);
  });
});
