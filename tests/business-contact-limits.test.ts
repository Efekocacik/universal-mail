import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { computeStartPlan } from "@/lib/campaigns/preflight";
import {
  businessDomainOf,
  evaluateEnrollment,
  evaluateSend,
  type EligibilityResult,
  type IneligibleCode,
} from "@/lib/compliance/eligibility";
import { DAY_MS, utcDay } from "@/lib/compliance/frequency";
import { seedCountryPolicies } from "@/lib/compliance/policies";
import { hashEmail, suppressDomain, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import * as cacheSchema from "@/lib/db/cache-schema";
import * as schema from "@/lib/db/schema";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  leadEmails,
  leads,
  messages,
} from "@/lib/db/schema";
import { tr } from "@/lib/i18n/tr";
import { classifyReasons } from "@/lib/mail/scheduler/dispatcher";
import { seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { setSetting } from "@/lib/settings";

/**
 * Go-live C8: temas sınırları adres başına DEĞİL, işletme başına da uygulanır (SRS 5.6.1 "Aynı işletme veya aynı
 * e-posta adresine"). İşletme = lead kaydı veya alıcının kayıtlı alan adı. Veritabanı BELLEKTE; ileti gönderilmez
 * (iletiler yalnızca geçmiş kaydı olarak eklenir).
 */

let client: Client;
let db: Db;
/** 2026-11-02 10:00 UTC (Pazartesi). */
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const DEMO_MAILBOX = 1;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  db = drizzle(client, { schema: { ...schema, ...cacheSchema } });
  await migrate(db, { migrationsFolder: path.resolve(__dirname, "..", "drizzle") });
  await seedCountryPolicies(db, T0);
  await seedBuiltinTemplates(db, T0);
  await seedDemoMailbox(db, T0);
  await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test Yetkilisi" });
  await setSetting(db, "company.profile", {
    legalName: "Örnek Dış Ticaret A.Ş.",
    address: "Örnek Mah. 1, İstanbul",
    taxId: "1234567890",
    phone: "+90 212 000 00 00",
    contactName: "Test Kişi",
  });
});

afterEach(() => {
  client.close();
});

type LeadRef = { leadId: number; emailId: number; email: string };

async function addLead(email: string, status: schema.LeadStatus = "enriched"): Promise<LeadRef> {
  const [l] = await db
    .insert(leads)
    .values({ source: "demo", status, countryCode: "GB", createdAt: T0, updatedAt: T0 })
    .returning({ id: leads.id });
  return { leadId: l!.id, ...(await addEmail(l!.id, email)) };
}

/** Lead'e yeni birincil adres ekler (öncekinin birincilliği kalkar). */
async function addEmail(
  leadId: number,
  email: string,
): Promise<{ emailId: number; email: string }> {
  await db.update(leadEmails).set({ isPrimary: false }).where(eq(leadEmails.leadId, leadId));
  const [e] = await db
    .insert(leadEmails)
    .values({
      leadId,
      email,
      domain: email.split("@")[1]!,
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leadEmails.id });
  return { emailId: e!.id, email };
}

async function addCampaign(status: schema.CampaignStatus = "running"): Promise<number> {
  const [c] = await db
    .insert(campaigns)
    .values({
      name: "Test",
      status,
      mailboxId: DEMO_MAILBOX,
      selection: {},
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      startConfirmedAt: ["draft", "ready", "cancelled"].includes(status) ? null : T0,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id });
  for (const [i, d] of [0, 5, 7].entries()) {
    await db
      .insert(campaignSteps)
      .values({ campaignId: c!.id, stepIndex: i, language: "en", templateId: 1, delayDays: d });
  }
  return c!.id;
}

async function enroll(
  campaignId: number,
  lead: LeadRef,
  o: { status?: schema.CampaignLeadStatus; nextStep?: number } = {},
): Promise<number> {
  const [cl] = await db
    .insert(campaignLeads)
    .values({
      campaignId,
      leadId: lead.leadId,
      emailId: lead.emailId,
      recipientEmail: lead.email,
      recipientHash: hashEmail(lead.email),
      recipientDomain: lead.email.split("@")[1]!,
      language: "en",
      status: o.status ?? "scheduled",
      nextStep: o.nextStep ?? 0,
      addedAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaignLeads.id });
  return cl!.id;
}

async function sent(
  campaignLeadId: number,
  step: number,
  at: number,
  status: schema.OutboundStatus = "sent",
) {
  const [cl] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, campaignLeadId));
  await db.insert(messages).values({
    direction: "out",
    purpose: "campaign",
    campaignId: cl!.campaignId,
    campaignLeadId,
    leadId: cl!.leadId,
    mailboxId: DEMO_MAILBOX,
    stepIndex: step,
    idempotencyKey: `cl:${campaignLeadId}:s:${step}`,
    toAddress: cl!.recipientEmail,
    peerHash: cl!.recipientHash!,
    peerDomain: cl!.recipientDomain!,
    sendDay: utcDay(at),
    status,
    createdAt: at,
    sentAt: status === "sent" ? at : null,
  });
}

/** Önceki kampanyada `email`'e `lastAt` anında bir ileti gitmiş, dizi `status` ile bitmiş. */
async function contactedBefore(
  lead: LeadRef,
  lastAt: number,
  status: schema.CampaignLeadStatus = "completed",
) {
  const old = await addCampaign("completed");
  const cl = await enroll(old, lead, { status });
  await sent(cl, 0, lastAt);
  return cl;
}

function codes(r: EligibilityResult): IneligibleCode[] {
  return r.reasons.map((x) => x.code).sort();
}

function reason(r: EligibilityResult, code: IneligibleCode) {
  return r.reasons.find((x) => x.code === code);
}

describe("işletme alan adı", () => {
  it("kayıtlı alan adı (eTLD+1); kişisel sağlayıcı ve genel uzantı işletme sayılmaz", () => {
    expect(businessDomainOf("shop.firma.de")).toBe("firma.de");
    expect(businessDomainOf("FIRMA.de")).toBe("firma.de");
    expect(businessDomainOf("satis.firma.co.uk")).toBe("firma.co.uk");
    expect(businessDomainOf("a.magaza.github.io")).toBe("magaza.github.io");
    expect(businessDomainOf("gmail.com")).toBeNull();
    expect(businessDomainOf("co.uk")).toBeNull();
    expect(businessDomainOf(null)).toBeNull();
    expect(businessDomainOf("")).toBeNull();
  });

  it("yeni kodların Türkçe etiketi var", () => {
    expect(tr["reason.business_already_in_campaign"]).toMatch(/işletme/);
    expect(tr["reason.business_contact_cooldown"]).toMatch(/işletme/);
  });
});

describe("kampanyaya ekleme: işletme başına sınırlar", () => {
  it("aynı lead'in birincil adresi değişse de (sales@ → info@) dinlenme süresi sıfırlanmaz", async () => {
    const lead = await addLead("sales@firma.example");
    const last = T0 - 20 * DAY_MS;
    await contactedBefore(lead, last);
    // Yeni birincil adres başka bir alan adında: yalnızca lead kimliği işletmeyi bağlar.
    await addEmail(lead.leadId, "info@firma-yeni.example");
    const next = await addCampaign("draft");
    const r = await evaluateEnrollment(db, { campaignId: next, leadId: lead.leadId }, { now: T0 });
    expect(codes(r)).toEqual(["business_contact_cooldown"]);
    expect(reason(r, "business_contact_cooldown")?.until).toBe(last + 180 * DAY_MS);
    // Süre dolunca serbest (adres düzeyinde yeni adrese hiç yazılmadığı için elle inceleme istenmez).
    expect(
      (
        await evaluateEnrollment(
          db,
          { campaignId: next, leadId: lead.leadId },
          { now: last + 180 * DAY_MS },
        )
      ).eligible,
    ).toBe(true);
  });

  it("aynı işletme alan adındaki başka lead/adres (alt alan adı dahil) beklemeye takılır", async () => {
    const a = await addLead("info@zincir.example");
    const last = T0 - 10 * DAY_MS;
    await contactedBefore(a, last, "cancelled");
    const b = await addLead("sales@shop.zincir.example");
    const next = await addCampaign("draft");
    const r = await evaluateEnrollment(db, { campaignId: next, leadId: b.leadId }, { now: T0 });
    expect(codes(r)).toEqual(["business_contact_cooldown"]);
    // İptal edilen dizi: kampanyalar arası aralık (30 gün), dinlenme değil.
    expect(reason(r, "business_contact_cooldown")?.until).toBe(last + 30 * DAY_MS);
    const other = await addLead("info@baska-firma.example");
    expect(
      (await evaluateEnrollment(db, { campaignId: next, leadId: other.leadId }, { now: T0 }))
        .eligible,
    ).toBe(true);
  });

  it("sağlayıcıya ulaşmamış (failed) ileti işletme teması sayılmaz; belirsiz ileti belirsiz sayılır", async () => {
    const a = await addLead("info@zincir.example");
    const old = await addCampaign("completed");
    const cl = await enroll(old, a, { status: "cancelled" });
    await sent(cl, 0, T0 - DAY_MS, "failed");
    const b = await addLead("sales@zincir.example");
    const next = await addCampaign("draft");
    expect(
      (await evaluateEnrollment(db, { campaignId: next, leadId: b.leadId }, { now: T0 })).eligible,
    ).toBe(true);
    await db.delete(messages);
    await sent(cl, 0, T0 - DAY_MS, "unknown");
    expect(
      codes(await evaluateEnrollment(db, { campaignId: next, leadId: b.leadId }, { now: T0 })),
    ).toEqual(["business_contact_cooldown", "unresolved_delivery"]);
  });

  it("başka kampanyada aynı lead'in (farklı adres) veya aynı işletmenin süren dizisi", async () => {
    const lead = await addLead("sales@firma.example");
    const first = await addCampaign();
    await enroll(first, lead, { status: "waiting_next" });
    await addEmail(lead.leadId, "info@firma-yeni.example");
    const second = await addCampaign("draft");
    expect(
      codes(await evaluateEnrollment(db, { campaignId: second, leadId: lead.leadId }, { now: T0 })),
    ).toEqual(["active_sequence_elsewhere"]);

    const other = await addLead("info@zincir.example");
    const sibling = await addLead("sales@zincir.example");
    const cl = await enroll(first, sibling, { status: "pending" });
    // Başlatılmamış (pending) dizi başka kampanyayı kilitlemez.
    expect(
      (await evaluateEnrollment(db, { campaignId: second, leadId: other.leadId }, { now: T0 }))
        .eligible,
    ).toBe(true);
    await db.update(campaignLeads).set({ status: "scheduled" }).where(eq(campaignLeads.id, cl));
    expect(
      (await evaluateEnrollment(db, { campaignId: second, leadId: other.leadId }, { now: T0 }))
        .reasons,
    ).toEqual([{ code: "active_sequence_elsewhere", detail: "business" }]);
  });

  it("aynı kampanyada: alt alan adı aynı işletmedir; kapanmış ama ileti almış dizi de işletmeyi tutar", async () => {
    const campaignId = await addCampaign();
    const a = await addLead("info@zincir.example");
    const cl = await enroll(campaignId, a);
    const sub = await addLead("sales@shop.zincir.example");
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: sub.leadId }, { now: T0 })),
    ).toEqual(["business_already_in_campaign"]);

    // Kapanmış, ileti almamış dizi işletmeyi tutmaz.
    await db.update(campaignLeads).set({ status: "removed" }).where(eq(campaignLeads.id, cl));
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: sub.leadId }, { now: T0 })).eligible,
    ).toBe(true);
    // Aynı tam alan adında da: kapanmış ama ileti almışsa işletmeye bu kampanyada yazılmıştır.
    await sent(cl, 0, T0 - DAY_MS);
    const same = await addLead("sales@zincir.example");
    for (const l of [sub, same]) {
      expect(
        codes(await evaluateEnrollment(db, { campaignId, leadId: l.leadId }, { now: T0 })),
      ).toEqual(["business_already_in_campaign"]);
    }
  });

  it("bir adresin çıkışı/şikâyeti işletmenin diğer adreslerini engellemez; alan adı engeli ve lead kararı uygulanır", async () => {
    const campaignId = await addCampaign("draft");
    const a = await addLead("sales@firma.example");
    await suppressEmail(db, { email: a.email, reason: "unsubscribe", source: "link" });
    await suppressEmail(db, {
      email: "muhasebe@firma.example",
      reason: "complaint",
      source: "inbox",
    });
    const b = await addLead("info@firma.example");
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: b.leadId }, { now: T0 })).eligible,
    ).toBe(true);
    // Aynı lead'in başka adresi de engellenmez (adres kapsamlı engel).
    await addEmail(a.leadId, "info@firma-ikinci.example");
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: a.leadId }, { now: T0 })).eligible,
    ).toBe(true);

    // İşletme düzeyinde kesin karar: lead durumu `do_not_contact` ve açık alan adı engeli.
    await db.update(leads).set({ status: "do_not_contact" }).where(eq(leads.id, a.leadId));
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: a.leadId }, { now: T0 })).reasons,
    ).toEqual([{ code: "lead_status_blocked", detail: "do_not_contact" }]);
    await suppressDomain(db, { domain: "firma.example", reason: "manual", source: "manual" });
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: b.leadId }, { now: T0 })),
    ).toEqual(["suppressed"]);
  });

  it("ekleme ve başlatma öncesi özet işletme beklemesini yansıtır", async () => {
    const a = await addLead("info@zincir.example");
    await contactedBefore(a, T0 - 5 * DAY_MS);
    const campaignId = await addCampaign("draft");
    const b = await addLead("sales@zincir.example");
    const c = await addLead("info@baska.example");
    const res = await addLeadsToCampaign(db, campaignId, [b.leadId, c.leadId], { now: T0 });
    expect(res.added).toBe(1);
    expect(res.excluded).toEqual([{ leadId: b.leadId, reasons: ["business_contact_cooldown"] }]);

    // Eklendikten SONRA işletmeye başka kampanyada yazıldı: başlatma özeti diziyi uygun saymaz.
    const d = await addLead("info@sonra.example");
    await addLeadsToCampaign(db, campaignId, [d.leadId], { now: T0 });
    const sibling = await addLead("sales@sonra.example");
    await contactedBefore(sibling, T0 + 1_000);
    const plan = await computeStartPlan(db, campaignId, { now: T0 + 2_000, env: {} });
    expect(plan.eligible.map((e) => e.leadId)).toEqual([c.leadId]);
    expect(plan.ineligible).toHaveLength(1);
    expect(plan.ineligible[0]!.reasons).toContain("business_contact_cooldown");
  });

  it("başlatma özeti: eski çift pending dizilerde küçük kimlik uygun kalır, yalnızca diğeri dışlanır", async () => {
    const campaignId = await addCampaign("draft");
    const a = await addLead("info@ortak.example");
    const b = await addLead("sales@shop.ortak.example");
    const c = await addLead("info@ikiz.example");
    const d = await addLead("sales@ikiz.example");
    // C8 öncesinden kalmış kayıtlar: ekleme bugün ikincileri engeller, bu yüzden doğrudan yazılır.
    const ids = [];
    for (const l of [a, b, c, d]) ids.push(await enroll(campaignId, l, { status: "pending" }));
    const plan = await computeStartPlan(db, campaignId, { now: T0, env: {} });
    expect(plan.eligible.map((e) => e.leadId)).toEqual([a.leadId, c.leadId]);
    expect(plan.ineligible).toEqual([
      { id: ids[1], reasons: ["business_already_in_campaign"] },
      { id: ids[3], reasons: ["domain_already_in_campaign"] },
    ]);

    // Dışlanmış dizinin yeniden denetimi ise açık (pending) kardeşe karşı engellenmeye devam eder.
    await db.update(campaignLeads).set({ status: "excluded" }).where(eq(campaignLeads.id, ids[0]!));
    expect(
      codes(
        await evaluateEnrollment(
          db,
          { campaignId, leadId: a.leadId },
          { now: T0, ignoreCampaignLeadId: ids[0] },
        ),
      ),
    ).toEqual(["business_already_in_campaign"]);
  });
});

describe("gönderim öncesi: işletme başına sınırlar", () => {
  it("aynı kampanyada aynı işletmenin iki dizisi: küçük kimlik gönderir, diğeri dışlanır", async () => {
    const campaignId = await addCampaign();
    const a = await enroll(campaignId, await addLead("info@ortak.example"));
    const b = await enroll(campaignId, await addLead("sales@shop.ortak.example"));
    expect(
      (await evaluateSend(db, { campaignLeadId: a, stepIndex: 0 }, { now: T0 })).eligible,
    ).toBe(true);
    const r = await evaluateSend(db, { campaignLeadId: b, stepIndex: 0 }, { now: T0 });
    expect(codes(r)).toEqual(["business_already_in_campaign"]);
    expect(classifyReasons(r.reasons, T0)).toEqual({ action: "exclude" });

    // İlk dizi ileti aldıktan sonra kendi takipleri sürer; ikinci dizi (ertesi gün de) dışlanır.
    await sent(a, 0, T0);
    await db
      .update(campaignLeads)
      .set({ status: "waiting_next", nextStep: 1 })
      .where(eq(campaignLeads.id, a));
    expect(
      (await evaluateSend(db, { campaignLeadId: a, stepIndex: 1 }, { now: T0 + 6 * DAY_MS }))
        .eligible,
    ).toBe(true);
    expect(
      codes(await evaluateSend(db, { campaignLeadId: b, stepIndex: 0 }, { now: T0 + DAY_MS })),
    ).toEqual(["business_already_in_campaign"]);
  });

  it("eski kayıtta büyük kimlikli dizi önce ileti aldıysa işletmeyi o tutar", async () => {
    const campaignId = await addCampaign();
    const a = await enroll(campaignId, await addLead("info@ortak.example"));
    const b = await enroll(campaignId, await addLead("sales@ortak.example"));
    await sent(b, 0, T0 - 6 * DAY_MS);
    await db
      .update(campaignLeads)
      .set({ status: "waiting_next", nextStep: 1 })
      .where(eq(campaignLeads.id, b));
    expect(codes(await evaluateSend(db, { campaignLeadId: a, stepIndex: 0 }, { now: T0 }))).toEqual(
      ["business_already_in_campaign"],
    );
    expect(
      (await evaluateSend(db, { campaignLeadId: b, stepIndex: 1 }, { now: T0 })).eligible,
    ).toBe(true);
  });

  it("kapanmış ve ileti almamış aynı işletme dizisi engel değildir", async () => {
    const campaignId = await addCampaign();
    const a = await enroll(campaignId, await addLead("info@ortak.example"), {
      status: "cancelled",
    });
    const b = await enroll(campaignId, await addLead("sales@ortak.example"));
    expect(a).toBeLessThan(b);
    expect(
      (await evaluateSend(db, { campaignLeadId: b, stepIndex: 0 }, { now: T0 })).eligible,
    ).toBe(true);
  });

  it("başka kampanyada işletmenin başka adresine yazıldıysa ertelenir (dışlanmaz), bekleme bitince serbest", async () => {
    const a = await addLead("info@zincir.example");
    const last = T0 - 3 * DAY_MS;
    await contactedBefore(a, last);
    const campaignId = await addCampaign();
    const b = await enroll(campaignId, await addLead("sales@zincir.example"));
    const r = await evaluateSend(db, { campaignLeadId: b, stepIndex: 0 }, { now: T0 });
    expect(codes(r)).toEqual(["business_contact_cooldown"]);
    const until = last + 180 * DAY_MS;
    expect(reason(r, "business_contact_cooldown")?.until).toBe(until);
    expect(classifyReasons(r.reasons, T0)).toEqual({ action: "defer", retryAt: until });
    expect(
      (await evaluateSend(db, { campaignLeadId: b, stepIndex: 0 }, { now: until })).eligible,
    ).toBe(true);
  });

  it("aynı lead'in eski adresine başka kampanyada yazılması da gönderimde ertelenir", async () => {
    const lead = await addLead("sales@firma.example");
    const last = T0 - 2 * DAY_MS;
    await contactedBefore(lead, last, "replied");
    const fresh = await addEmail(lead.leadId, "info@firma-yeni.example");
    const campaignId = await addCampaign();
    const cl = await enroll(campaignId, { leadId: lead.leadId, ...fresh });
    const r = await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 });
    expect(codes(r)).toEqual(["business_contact_cooldown"]);
    // Yanıtlanmış dizi: dinlenme değil, kampanyalar arası aralık.
    expect(reason(r, "business_contact_cooldown")?.until).toBe(last + 30 * DAY_MS);
  });
});
