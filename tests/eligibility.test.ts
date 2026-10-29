import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluateEnrollment,
  evaluateSend,
  type EligibilityResult,
  type IneligibleCode,
} from "@/lib/compliance/eligibility";
import {
  DAY_MS,
  DEFAULT_FREQUENCY_LIMITS,
  FrequencyLimitError,
  isAtLeastAsStrict,
  tightenFrequencyLimits,
  utcDay,
} from "@/lib/compliance/frequency";
import { seedCountryPolicies } from "@/lib/compliance/policies";
import { tightenDemoPolicy } from "@/lib/compliance/policy-service";
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
  mailboxes,
  messages,
} from "@/lib/db/schema";
import { seedBuiltinTemplates, seedDemoMailbox } from "@/lib/mail/seed";
import { setSetting } from "@/lib/settings";

/**
 * Gönderim uygunluğu ve temas sıklığı. Veritabanı BELLEKTE açılır; gerçek `.data` veritabanına dokunulmaz,
 * hiçbir e-posta gönderilmez (iletiler yalnızca geçmiş kaydı olarak eklenir).
 */

let client: Client;
let db: Db;
/** 2026-11-02 10:00 UTC (Pazartesi). */
const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);

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

/* ------------------------------------------------------------------------------------------------
 * Yardımcılar
 * ---------------------------------------------------------------------------------------------- */

const DEMO_MAILBOX = 1;

async function addLead(
  o: {
    email?: string | null;
    country?: string | null;
    kind?: "generic" | "personal" | "consumer";
    verify?: "verified" | "unverified" | "invalid";
    status?: schema.LeadStatus;
  } = {},
): Promise<{ leadId: number; emailId: number | null; email: string | null }> {
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: o.status ?? "enriched",
      countryCode: o.country === undefined ? "GB" : o.country,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leads.id });
  const email = o.email === undefined ? `info@lead${l!.id}.example` : o.email;
  if (email === null) return { leadId: l!.id, emailId: null, email: null };
  const [e] = await db
    .insert(leadEmails)
    .values({
      leadId: l!.id,
      email,
      domain: email.split("@")[1]!,
      kind: o.kind ?? "generic",
      sourceType: "mailto",
      verifyStatus: o.verify ?? "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    })
    .returning({ id: leadEmails.id });
  return { leadId: l!.id, emailId: e!.id, email };
}

async function addCampaign(
  o: { mailboxId?: number | null; status?: schema.CampaignStatus; delays?: number[] } = {},
): Promise<number> {
  const status = o.status ?? "running";
  const [c] = await db
    .insert(campaigns)
    .values({
      name: "Test",
      status,
      mailboxId: o.mailboxId === undefined ? DEMO_MAILBOX : o.mailboxId,
      selection: {},
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      startConfirmedAt: ["draft", "ready", "cancelled"].includes(status) ? null : T0,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id });
  for (const [i, d] of (o.delays ?? [0, 5, 7]).entries()) {
    await db.insert(campaignSteps).values({
      campaignId: c!.id,
      stepIndex: i,
      language: "en",
      templateId: 1,
      delayDays: d,
    });
  }
  return c!.id;
}

async function enroll(
  campaignId: number,
  lead: { leadId: number; emailId: number | null; email: string | null },
  o: { status?: schema.CampaignLeadStatus; nextStep?: number } = {},
): Promise<number> {
  const [cl] = await db
    .insert(campaignLeads)
    .values({
      campaignId,
      leadId: lead.leadId,
      emailId: lead.emailId,
      recipientEmail: lead.email,
      recipientHash: lead.email ? hashEmail(lead.email) : null,
      recipientDomain: lead.email ? lead.email.split("@")[1]! : null,
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

function codes(r: EligibilityResult): IneligibleCode[] {
  return r.reasons.map((x) => x.code).sort();
}

function reason(r: EligibilityResult, code: IneligibleCode) {
  return r.reasons.find((x) => x.code === code);
}

/* ------------------------------------------------------------------------------------------------
 * Sıklık sınırları
 * ---------------------------------------------------------------------------------------------- */

describe("sıklık sınırları yalnızca sıkılaştırılabilir", () => {
  it("varsayılanlar SRS 5.6.1 ile aynıdır", () => {
    expect(DEFAULT_FREQUENCY_LIMITS).toEqual({
      maxMessagesPerSequence: 3,
      minFollowupGapDays: 5,
      restAfterSequenceDays: 180,
      crossCampaignGapDays: 30,
      maxDomainMessagesPerDay: 1,
    });
    expect(Object.isFrozen(DEFAULT_FREQUENCY_LIMITS)).toBe(true);
  });

  it("daha sıkı değerleri kabul eder", () => {
    expect(
      tightenFrequencyLimits({
        maxMessagesPerSequence: 2,
        minFollowupGapDays: 7,
        restAfterSequenceDays: 365,
        crossCampaignGapDays: 60,
      }),
    ).toEqual({
      ...DEFAULT_FREQUENCY_LIMITS,
      maxMessagesPerSequence: 2,
      minFollowupGapDays: 7,
      restAfterSequenceDays: 365,
      crossCampaignGapDays: 60,
    });
  });

  it.each([
    ["maxMessagesPerSequence", 4],
    ["minFollowupGapDays", 4],
    ["restAfterSequenceDays", 179],
    ["crossCampaignGapDays", 29],
    ["maxDomainMessagesPerDay", 2],
  ])("%s = %s gevşetmedir ve reddedilir", (field, value) => {
    expect(() => tightenFrequencyLimits({ [field]: value })).toThrow(FrequencyLimitError);
  });

  it("bilinmeyen alan, tam sayı olmayan, negatif ve aşırı değerler reddedilir", () => {
    expect(() => tightenFrequencyLimits({ dailyCap: 1 })).toThrow(FrequencyLimitError);
    expect(() => tightenFrequencyLimits({ minFollowupGapDays: 5.5 })).toThrow(FrequencyLimitError);
    expect(() => tightenFrequencyLimits({ minFollowupGapDays: "9" })).toThrow(FrequencyLimitError);
    expect(() => tightenFrequencyLimits({ maxMessagesPerSequence: -1 })).toThrow(
      FrequencyLimitError,
    );
    expect(() => tightenFrequencyLimits({ restAfterSequenceDays: 1e9 })).toThrow(
      FrequencyLimitError,
    );
  });

  it("dışarıdan gelen gevşek sınır nesnesi uygunluk değerlendirmesinde reddedilir", async () => {
    expect(isAtLeastAsStrict({ ...DEFAULT_FREQUENCY_LIMITS, minFollowupGapDays: 1 })).toBe(false);
    const campaignId = await addCampaign();
    const lead = await addLead();
    const r = await evaluateEnrollment(
      db,
      { campaignId, leadId: lead.leadId },
      {
        now: T0,
        limits: { ...DEFAULT_FREQUENCY_LIMITS, maxMessagesPerSequence: 10 },
      },
    );
    expect(codes(r)).toContain("invalid_limits");
    expect(r.eligible).toBe(false);
  });

  it("UTC günü işlem saat diliminden bağımsızdır", () => {
    expect(utcDay(Date.UTC(2026, 10, 2, 23, 59, 59, 999))).toBe("2026-11-02");
    expect(utcDay(Date.UTC(2026, 10, 3, 0, 0, 0, 0))).toBe("2026-11-03");
    // İstanbul (UTC+3) 3 Kasım 01:30 = UTC 2 Kasım 22:30
    expect(utcDay(Date.parse("2026-11-03T01:30:00+03:00"))).toBe("2026-11-02");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Kampanyaya ekleme
 * ---------------------------------------------------------------------------------------------- */

describe("kampanyaya ekleme uygunluğu", () => {
  it("demo kutusu, izinli ülke, doğrulanmış genel adres: uygun (yalnızca demo kapsamında)", async () => {
    const campaignId = await addCampaign();
    const lead = await addLead();
    expect(await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 })).toEqual({
      eligible: true,
      scope: "demo",
      reasons: [],
    });
  });

  it("aynı lead gerçek bir posta kutusuyla live kapsamında engellenir", async () => {
    const [mb] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@sirket.example",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    const campaignId = await addCampaign({ mailboxId: mb!.id });
    const lead = await addLead();
    const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
    expect(r.scope).toBe("live");
    expect(r.eligible).toBe(false);
    expect(codes(r)).toEqual(["country_blocked", "live_sending_disabled"]);
    expect(reason(r, "country_blocked")?.detail).toBe("live_disabled");
  });

  it("onay ve gönderen profili zorunlu", async () => {
    await client.execute("DELETE FROM settings WHERE key IN ('consent', 'company.profile')");
    const campaignId = await addCampaign();
    const lead = await addLead();
    const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
    expect(codes(r)).toEqual(["consent_missing", "sender_profile_incomplete"]);
  });

  it("posta kutusu yoksa, hazır değilse veya kampanya kapanmışsa reddedilir", async () => {
    const lead = await addLead();
    const noMailbox = await addCampaign({ mailboxId: null, status: "draft" });
    expect(
      codes(
        await evaluateEnrollment(db, { campaignId: noMailbox, leadId: lead.leadId }, { now: T0 }),
      ),
    ).toContain("mailbox_missing");
    await db.update(mailboxes).set({ status: "disabled" });
    const c = await addCampaign();
    expect(
      codes(await evaluateEnrollment(db, { campaignId: c, leadId: lead.leadId }, { now: T0 })),
    ).toContain("mailbox_not_ready");
    await db.update(mailboxes).set({ status: "connected" });
    const closed = await addCampaign({ status: "cancelled" });
    expect(
      codes(await evaluateEnrollment(db, { campaignId: closed, leadId: lead.leadId }, { now: T0 })),
    ).toContain("campaign_closed");
    expect(
      codes(await evaluateEnrollment(db, { campaignId: 999, leadId: lead.leadId }, { now: T0 })),
    ).toContain("campaign_not_found");
  });

  it.each([
    ["DE", "country_blocked"],
    ["TR", "country_blocked"],
    ["US", "country_blocked"],
    [null, "country_blocked"],
  ] as const)("ülke %s → %s", async (country, code) => {
    const campaignId = await addCampaign();
    const lead = await addLead({ country });
    const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
    expect(codes(r)).toEqual([code]);
  });

  it("generic_only ülkede genel adres uygundur; demo politikası sıkılaştırılınca engellenir", async () => {
    const campaignId = await addCampaign();
    const lead = await addLead({ country: "ES" });
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 })).eligible,
    ).toBe(true);
    await tightenDemoPolicy(db, { scope: "demo", countryCode: "ES", mode: "blocked" });
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 })),
    ).toEqual(["country_blocked"]);
  });

  it("e-posta niteliği: yalnızca doğrulanmış genel işletme adresi", async () => {
    const campaignId = await addCampaign();
    const cases: [Parameters<typeof addLead>[0], IneligibleCode][] = [
      [{ verify: "unverified" }, "email_not_verified"],
      [{ verify: "invalid" }, "email_not_verified"],
      [{ kind: "personal", email: "ali.veli@kafe1.example" }, "email_personal"],
      [{ kind: "generic", email: "ali.veli@kafe2.example" }, "email_personal"], // kayıt ile hesap çelişkisi
      [{ kind: "consumer", email: "kafe@gmail.com" }, "email_consumer"],
      [{ kind: "generic", email: "info@gmail.com" }, "email_consumer"],
      [{ email: null }, "no_email"],
      [{ email: "INFO@Kafe3.example" }, "email_invalid"], // normalleştirilmemiş kayıt = bozuk veri
    ];
    for (const [o, code] of cases) {
      const lead = await addLead(o);
      const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
      expect(codes(r), JSON.stringify(o)).toEqual([code]);
    }
  });

  it("lead durumu temas istemiyorsa reddedilir", async () => {
    const campaignId = await addCampaign();
    for (const status of ["do_not_contact", "not_interested", "customer", "replied"] as const) {
      const lead = await addLead({ status });
      const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
      expect(r.reasons).toEqual([{ code: "lead_status_blocked", detail: status }]);
    }
    expect(codes(await evaluateEnrollment(db, { campaignId, leadId: 999 }, { now: T0 }))).toEqual([
      "lead_not_found",
    ]);
  });

  it("adres veya alan adı engelliyse reddedilir", async () => {
    const campaignId = await addCampaign();
    const a = await addLead();
    await suppressEmail(db, { email: a.email!, reason: "unsubscribe", source: "link" });
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: a.leadId }, { now: T0 })).reasons,
    ).toEqual([{ code: "suppressed", detail: "email:unsubscribe" }]);
    const b = await addLead({ email: "info@shop.chain.example" });
    await suppressDomain(db, { domain: "chain.example", reason: "manual", source: "manual" });
    expect(
      (await evaluateEnrollment(db, { campaignId, leadId: b.leadId }, { now: T0 })).reasons,
    ).toEqual([{ code: "suppressed", detail: "domain:manual" }]);
  });

  it("aynı kampanyada aynı lead, aynı adres veya aynı alan adı ikinci kez eklenemez", async () => {
    const campaignId = await addCampaign();
    const a = await addLead({ email: "info@zincir.example" });
    await enroll(campaignId, a);
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: a.leadId }, { now: T0 })),
    ).toContain("already_in_campaign");
    const sameAddress = await addLead({ email: "info@zincir.example" });
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: sameAddress.leadId }, { now: T0 })),
    ).toContain("already_in_campaign");
    const sameDomain = await addLead({ email: "sales@zincir.example" });
    expect(
      codes(await evaluateEnrollment(db, { campaignId, leadId: sameDomain.leadId }, { now: T0 })),
    ).toEqual(["domain_already_in_campaign"]);
  });

  it("başka kampanyada sürmekte olan dizi varsa reddedilir", async () => {
    const first = await addCampaign();
    const second = await addCampaign();
    const a = await addLead();
    await enroll(first, a);
    expect(
      codes(await evaluateEnrollment(db, { campaignId: second, leadId: a.leadId }, { now: T0 })),
    ).toEqual(["active_sequence_elsewhere"]);
  });

  describe("geçmiş temas", () => {
    async function previous(status: schema.CampaignLeadStatus, lastAt: number) {
      const old = await addCampaign({ status: "completed" });
      const a = await addLead();
      const cl = await enroll(old, a, { status });
      await sent(cl, 0, lastAt);
      return { a, next: await addCampaign() };
    }

    it("yanıtsız tamamlanan dizi: 180 gün dinlenme (sınırda tam 180. gün serbest), her zaman elle inceleme", async () => {
      const last = T0 - 100 * DAY_MS;
      const { a, next } = await previous("completed", last);
      const r = await evaluateEnrollment(db, { campaignId: next, leadId: a.leadId }, { now: T0 });
      expect(codes(r)).toEqual(["recontact_requires_review", "rest_period"]);
      expect(reason(r, "rest_period")?.until).toBe(last + 180 * DAY_MS);

      const justBefore = await evaluateEnrollment(
        db,
        { campaignId: next, leadId: a.leadId },
        {
          now: last + 180 * DAY_MS - 1,
        },
      );
      expect(codes(justBefore)).toContain("rest_period");
      const atLimit = await evaluateEnrollment(
        db,
        { campaignId: next, leadId: a.leadId },
        {
          now: last + 180 * DAY_MS,
        },
      );
      expect(codes(atLimit)).toEqual(["recontact_requires_review"]);
    });

    it("iptal edilen dizi: kampanyalar arası 30 gün (180 gün uygulanmaz), yine elle inceleme", async () => {
      const last = T0 - 10 * DAY_MS;
      const { a, next } = await previous("cancelled", last);
      const r = await evaluateEnrollment(db, { campaignId: next, leadId: a.leadId }, { now: T0 });
      expect(codes(r)).toEqual(["cross_campaign_gap", "recontact_requires_review"]);
      expect(reason(r, "cross_campaign_gap")?.until).toBe(last + 30 * DAY_MS);
      const after = await evaluateEnrollment(
        db,
        { campaignId: next, leadId: a.leadId },
        {
          now: last + 30 * DAY_MS,
        },
      );
      expect(codes(after)).toEqual(["recontact_requires_review"]);
    });

    it("sıkılaştırılmış dinlenme süresi uygulanır", async () => {
      const last = T0 - 200 * DAY_MS;
      const { a, next } = await previous("completed", last);
      const limits = tightenFrequencyLimits({ restAfterSequenceDays: 365 });
      const r = await evaluateEnrollment(
        db,
        { campaignId: next, leadId: a.leadId },
        { now: T0, limits },
      );
      expect(reason(r, "rest_period")?.until).toBe(last + 365 * DAY_MS);
    });

    it("sonucu belirsiz (unknown) ileti güvenli tarafta temas sayılır ve tekrar gönderimi engeller", async () => {
      const old = await addCampaign();
      const a = await addLead();
      const cl = await enroll(old, a, { status: "in_flight" });
      await sent(cl, 0, T0 - 60 * DAY_MS, "unknown");
      await db.update(campaignLeads).set({ status: "cancelled" }).where(eq(campaignLeads.id, cl));
      const next = await addCampaign();
      const r = await evaluateEnrollment(db, { campaignId: next, leadId: a.leadId }, { now: T0 });
      expect(codes(r)).toEqual(["recontact_requires_review", "unresolved_delivery"]);
    });

    it("sağlayıcıya ulaşmamış (failed) ileti temas sayılmaz", async () => {
      const old = await addCampaign({ status: "completed" });
      const a = await addLead();
      const cl = await enroll(old, a, { status: "cancelled" });
      await sent(cl, 0, T0 - DAY_MS, "failed");
      const next = await addCampaign();
      expect(
        (await evaluateEnrollment(db, { campaignId: next, leadId: a.leadId }, { now: T0 }))
          .eligible,
      ).toBe(true);
    });

    it("lead silinip aynı adres yeniden eklense de geçmiş korunur", async () => {
      const last = T0 - 5 * DAY_MS;
      const { a, next } = await previous("completed", last);
      // Geçmişi olan lead silinemez (RESTRICT); yeniden taramayı yeni bir lead ile taklit et.
      const again = await addLead({ email: a.email });
      const r = await evaluateEnrollment(
        db,
        { campaignId: next, leadId: again.leadId },
        { now: T0 },
      );
      expect(codes(r)).toEqual(["cross_campaign_gap", "recontact_requires_review", "rest_period"]);
    });
  });

  it("beklenmeyen hata güvenli tarafta 'uygun değil' döner", async () => {
    const campaignId = await addCampaign();
    const lead = await addLead();
    await client.execute("DROP TABLE suppressions");
    const r = await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
    expect(r.eligible).toBe(false);
    expect(codes(r)).toContain("evaluation_error");
  });

  it("değerlendirme hiçbir kayıt yazmaz", async () => {
    const campaignId = await addCampaign();
    const lead = await addLead();
    const before = await client.execute(
      "SELECT (SELECT COUNT(*) FROM campaign_leads) + (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM audit_log) AS n",
    );
    await evaluateEnrollment(db, { campaignId, leadId: lead.leadId }, { now: T0 });
    const after = await client.execute(
      "SELECT (SELECT COUNT(*) FROM campaign_leads) + (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM audit_log) AS n",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Gönderim öncesi
 * ---------------------------------------------------------------------------------------------- */

describe("gönderim öncesi uygunluk", () => {
  async function setup(o: { email?: string; delays?: number[] } = {}) {
    const campaignId = await addCampaign({ delays: o.delays });
    const lead = await addLead(o.email ? { email: o.email } : {});
    const cl = await enroll(campaignId, lead);
    return { campaignId, lead, cl };
  }

  it("ilk adım: uygun (demo kapsamı)", async () => {
    const { cl } = await setup();
    expect(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })).toEqual({
      eligible: true,
      scope: "demo",
      reasons: [],
    });
  });

  it("kampanya çalışmıyorsa, dizi durumu uygun değilse veya adım sırası yanlışsa reddedilir", async () => {
    const { campaignId, cl } = await setup();
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 })),
    ).toContain("step_out_of_range");
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 3 }, { now: T0 })),
    ).toContain("step_out_of_range");
    await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, campaignId));
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
    ).toEqual(["campaign_not_active"]);
    await db.update(campaigns).set({ status: "running" }).where(eq(campaigns.id, campaignId));
    await db.update(campaignLeads).set({ status: "excluded" }).where(eq(campaignLeads.id, cl));
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })).reasons,
    ).toEqual([{ code: "campaign_lead_not_sendable", detail: "excluded" }]);
    expect(
      codes(await evaluateSend(db, { campaignLeadId: 999, stepIndex: 0 }, { now: T0 })),
    ).toEqual(["campaign_lead_not_found"]);
  });

  it("takip aralığı: en az 5 gün; adımın daha uzun gecikmesi geçerli; sınırda tam süre serbest", async () => {
    const { cl } = await setup({ delays: [0, 5, 7] });
    await sent(cl, 0, T0);
    await db
      .update(campaignLeads)
      .set({ nextStep: 1, status: "waiting_next" })
      .where(eq(campaignLeads.id, cl));

    const early = await evaluateSend(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { now: T0 + 5 * DAY_MS - 1 },
    );
    expect(codes(early)).toEqual(["followup_too_soon"]);
    expect(reason(early, "followup_too_soon")?.until).toBe(T0 + 5 * DAY_MS);
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 5 * DAY_MS }))
        .eligible,
    ).toBe(true);

    await sent(cl, 1, T0 + 5 * DAY_MS);
    await db.update(campaignLeads).set({ nextStep: 2 }).where(eq(campaignLeads.id, cl));
    const step2 = await evaluateSend(
      db,
      { campaignLeadId: cl, stepIndex: 2 },
      { now: T0 + 11 * DAY_MS },
    );
    expect(codes(step2)).toEqual(["followup_too_soon"]);
    expect(reason(step2, "followup_too_soon")?.until).toBe(T0 + 12 * DAY_MS);
  });

  it("adım gecikmesi 5 günden kısa tanımlansa bile en az 5 gün beklenir; sıkılaştırılmış aralık uygulanır", async () => {
    const { cl } = await setup({ delays: [0, 5, 5] });
    await sent(cl, 0, T0);
    await db
      .update(campaignLeads)
      .set({ nextStep: 1, status: "waiting_next" })
      .where(eq(campaignLeads.id, cl));
    const limits = tightenFrequencyLimits({ minFollowupGapDays: 8 });
    const r = await evaluateSend(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { now: T0 + 6 * DAY_MS, limits },
    );
    expect(reason(r, "followup_too_soon")?.until).toBe(T0 + 8 * DAY_MS);
  });

  it("önceki adım gönderilmemişse veya sonucu belirsizse takip gönderilmez", async () => {
    const { cl } = await setup();
    await db
      .update(campaignLeads)
      .set({ nextStep: 1, status: "waiting_next" })
      .where(eq(campaignLeads.id, cl));
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 9 * DAY_MS })),
    ).toEqual(["previous_step_not_sent"]);
    await sent(cl, 0, T0, "unknown");
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 9 * DAY_MS })),
    ).toEqual(["previous_step_not_sent", "unresolved_delivery"]);
  });

  it("aynı adım belirsiz/gönderilmiş durumdayken tekrar değerlendirilirse reddedilir", async () => {
    const { cl } = await setup();
    await sent(cl, 0, T0, "unknown");
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 + DAY_MS })),
    ).toEqual(["already_sent", "unresolved_delivery"]);
  });

  it("sağlayıcıya ulaşmamış (failed) adım yeniden denenebilir", async () => {
    const { cl } = await setup();
    await sent(cl, 0, T0, "failed");
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 + DAY_MS })).eligible,
    ).toBe(true);
  });

  it("dizide en fazla 3 ileti (sıkılaştırılınca 2)", async () => {
    const { cl } = await setup();
    await sent(cl, 0, T0);
    await sent(cl, 1, T0 + 5 * DAY_MS);
    await db
      .update(campaignLeads)
      .set({ nextStep: 2, status: "waiting_next" })
      .where(eq(campaignLeads.id, cl));
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 2 }, { now: T0 + 20 * DAY_MS }))
        .eligible,
    ).toBe(true);
    const limits = tightenFrequencyLimits({ maxMessagesPerSequence: 2 });
    expect(
      codes(
        await evaluateSend(
          db,
          { campaignLeadId: cl, stepIndex: 2 },
          { now: T0 + 20 * DAY_MS, limits },
        ),
      ),
    ).toEqual(["sequence_limit", "step_out_of_range"]);
    await sent(cl, 2, T0 + 20 * DAY_MS);
    await db.update(campaignLeads).set({ nextStep: 3 }).where(eq(campaignLeads.id, cl));
    expect(
      codes(
        await evaluateSend(db, { campaignLeadId: cl, stepIndex: 3 }, { now: T0 + 40 * DAY_MS }),
      ),
    ).toEqual(["sequence_limit", "step_missing", "step_out_of_range"]); // 4. adım hiç tanımlanamaz
  });

  it("yanıt geldiyse takip durur", async () => {
    const { cl } = await setup();
    await sent(cl, 0, T0);
    await db
      .update(campaignLeads)
      .set({ nextStep: 1, status: "waiting_next" })
      .where(eq(campaignLeads.id, cl));
    const [row] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, cl));
    await db.insert(messages).values({
      direction: "in",
      purpose: "inbound",
      campaignId: row!.campaignId,
      campaignLeadId: cl,
      leadId: row!.leadId,
      mailboxId: DEMO_MAILBOX,
      peerHash: row!.recipientHash!,
      peerDomain: row!.recipientDomain!,
      status: "matched",
      classification: "reply",
      createdAt: T0 + DAY_MS,
      receivedAt: T0 + DAY_MS,
    });
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 9 * DAY_MS })),
    ).toEqual(["reply_received"]);
  });

  describe("alan adı başına günlük sınır (UTC günü)", () => {
    it("aynı alan adına aynı gün ikinci kampanya iletisi engellenir; ertesi UTC günü serbest", async () => {
      const a = await setup({ email: "info@zincir.example" });
      const b = await setup({ email: "sales@zincir.example" });
      await sent(a.cl, 0, T0);
      const r = await evaluateSend(
        db,
        { campaignLeadId: b.cl, stepIndex: 0 },
        { now: T0 + 3_600_000 },
      );
      expect(codes(r)).toEqual(["domain_daily_cap"]);
      expect(reason(r, "domain_daily_cap")?.until).toBe(Date.UTC(2026, 10, 3));
      expect(
        (
          await evaluateSend(
            db,
            { campaignLeadId: b.cl, stepIndex: 0 },
            { now: Date.UTC(2026, 10, 3) },
          )
        ).eligible,
      ).toBe(true);
    });

    it("gün sınırı UTC gece yarısıdır: 23:59 UTC ile 00:00 UTC farklı günlerdir", async () => {
      const a = await setup({ email: "info@zincir.example" });
      const b = await setup({ email: "sales@zincir.example" });
      await sent(a.cl, 0, Date.UTC(2026, 10, 2, 23, 59, 0));
      expect(
        codes(
          await evaluateSend(
            db,
            { campaignLeadId: b.cl, stepIndex: 0 },
            { now: Date.UTC(2026, 10, 2, 23, 59, 30) },
          ),
        ),
      ).toEqual(["domain_daily_cap"]);
      expect(
        (
          await evaluateSend(
            db,
            { campaignLeadId: b.cl, stepIndex: 0 },
            { now: Date.UTC(2026, 10, 3, 0, 0, 0) },
          )
        ).eligible,
      ).toBe(true);
    });

    it("belirsiz ileti günü doldurur; sağlayıcıya ulaşmamış ileti doldurmaz", async () => {
      const a = await setup({ email: "info@zincir.example" });
      const b = await setup({ email: "sales@zincir.example" });
      await sent(a.cl, 0, T0, "failed");
      expect(
        (await evaluateSend(db, { campaignLeadId: b.cl, stepIndex: 0 }, { now: T0 + 60_000 }))
          .eligible,
      ).toBe(true);
      await sent(a.cl, 0, T0 + 60_000, "unknown");
      expect(
        codes(
          await evaluateSend(db, { campaignLeadId: b.cl, stepIndex: 0 }, { now: T0 + 120_000 }),
        ),
      ).toEqual(["domain_daily_cap"]);
    });
  });

  describe("eklemeden sonra değişen veri gönderimde yakalanır", () => {
    it("sonradan eklenen suppression", async () => {
      const { lead, cl } = await setup();
      await suppressEmail(db, { email: lead.email!, reason: "complaint", source: "inbox" });
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["suppressed"]);
    });

    it("sıkılaştırılan ülke politikası", async () => {
      const { cl } = await setup();
      await tightenDemoPolicy(db, { scope: "demo", countryCode: "GB", mode: "blocked" });
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["country_blocked"]);
    });

    it("gerçek posta kutusuna geçirilen kampanya", async () => {
      const { campaignId, cl } = await setup();
      const [mb] = await db
        .insert(mailboxes)
        .values({
          provider: "smtp",
          label: "SMTP",
          status: "not_configured",
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: mailboxes.id });
      await db.update(campaigns).set({ mailboxId: mb!.id }).where(eq(campaigns.id, campaignId));
      const r = await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 });
      expect(r.scope).toBe("live");
      expect(codes(r)).toEqual(["country_blocked", "live_sending_disabled", "mailbox_not_ready"]);
    });

    it("lead e-postası değişti, silindi veya alıcı silme talebiyle kaldırıldı", async () => {
      const { lead, cl } = await setup();
      await db
        .update(leadEmails)
        .set({ email: "sales@lead.example" })
        .where(eq(leadEmails.id, lead.emailId!));
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["recipient_mismatch"]);
      await db.delete(leadEmails).where(eq(leadEmails.id, lead.emailId!)); // email_id → NULL
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["email_removed"]);
      await db
        .update(campaignLeads)
        .set({ recipientEmail: null, redactedAt: T0 })
        .where(eq(campaignLeads.id, cl));
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["recipient_redacted"]);
    });

    it("adım tanımı yoksa gönderilmez", async () => {
      const { campaignId, cl } = await setup();
      await db.delete(campaignSteps).where(eq(campaignSteps.campaignId, campaignId));
      expect(
        codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 })),
      ).toEqual(["step_missing"]);
    });
  });
});
