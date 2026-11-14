import type { Client } from "@libsql/client";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { computeStartPlan } from "@/lib/campaigns/preflight";
import { evaluateEnrollment, evaluateEnrollmentBatch } from "@/lib/compliance/eligibility";
import type { Db } from "@/lib/db/client";
import { campaignLeads, leadEmails, leads } from "@/lib/db/schema";
import { openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";
import { buildEligibilityFixture, type EligibilityFixture } from "./helpers/eligibility-fixture";

/**
 * Toplu uygunluk denetimi (N+1 düzeltmesi): kampanyaya ekleme, yeniden denetim ve başlatma özeti artık lead başına
 * ~15-18 sorgu ve kampanyanın bütün dizilerini her lead için okumak yerine sabit sayıda toplu sorgu kullanır. Kurallar
 * değişmemelidir: ortak alan adları, alt alan adları, başka kampanyada süren diziler, geçmiş ve engeller içeren ~50
 * lead'lik fikstürde toplu sonuçlar tek tek `evaluateEnrollment` sonuçlarıyla birebir aynıdır.
 */

let client: Client;
let db: Db;
let fx: EligibilityFixture;
const NOW = T0 + 86_400_000;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  fx = await buildEligibilityFixture(db);
});
afterEach(() => client.close());

describe("evaluateEnrollmentBatch", () => {
  it("bütün lead'ler için tek tek değerlendirmeyle aynı sonuçlar (gerekçe sırası dahil)", async () => {
    const single = [];
    for (const leadId of fx.leadIds)
      single.push(
        await evaluateEnrollment(db, { campaignId: fx.campaignId, leadId }, { now: NOW }),
      );
    const batch = await evaluateEnrollmentBatch(
      db,
      fx.campaignId,
      fx.leadIds.map((leadId) => ({ leadId })),
      { now: NOW },
    );
    expect(batch).toEqual(single);
    // fikstür gerçekten çeşitli: hem uygun hem çok sayıda farklı gerekçe
    const codes = new Set(batch.flatMap((r) => r.reasons.map((x) => x.code)));
    expect(batch.some((r) => r.eligible)).toBe(true);
    for (const code of [
      "already_in_campaign",
      "domain_already_in_campaign",
      "active_sequence_elsewhere",
      "business_contact_cooldown",
      "suppressed",
      "unresolved_delivery",
      "rest_period",
      "country_blocked",
      "no_email",
      "email_consumer",
    ])
      expect(codes).toContain(code);
  });

  it("başlatma yeniden denetimi (ignoreCampaignLeadId, kardeş kuralı) tek tek ile aynı", async () => {
    const pending = await db
      .select()
      .from(campaignLeads)
      .where(eq(campaignLeads.campaignId, fx.campaignId))
      .orderBy(asc(campaignLeads.id));
    const rows = pending
      .filter((r) => r.status === "pending")
      .map((r) => ({ leadId: r.leadId, ignoreCampaignLeadId: r.id }));
    const single = [];
    for (const r of rows)
      single.push(
        await evaluateEnrollment(
          db,
          { campaignId: fx.campaignId, leadId: r.leadId },
          { now: NOW, ignoreCampaignLeadId: r.ignoreCampaignLeadId },
        ),
      );
    expect(await evaluateEnrollmentBatch(db, fx.campaignId, rows, { now: NOW })).toEqual(single);
  });

  it("sorgu sayısı lead sayısından bağımsız (başlatma özeti ve ekleme)", async () => {
    const spy = vi.spyOn(client, "execute");
    await computeStartPlan(db, fx.campaignId, { now: NOW, env: {} });
    const planQueries = spy.mock.calls.length;
    // 27 `pending` dizi: eski yolda ~15-18 sorgu/dizi (> 400). Toplu yol sabit (+ ülke politikası başına bir).
    expect(planQueries).toBeLessThan(40);
    spy.mockClear();
    await addLeadsToCampaign(db, fx.campaignId, fx.notEnrolled, { now: NOW });
    expect(spy.mock.calls.length).toBeLessThan(40);
    spy.mockRestore();
  });

  it("aynı istekte önce eklenen lead sonrakini aynı alan adı kuralıyla etkiler (bellek içi görüntü)", async () => {
    const mk = async (email: string) => {
      const [l] = await db
        .insert(leads)
        .values({
          source: "demo",
          status: "enriched",
          countryCode: "GB",
          city: "London",
          categoryKey: "cafe",
          createdAt: T0,
          updatedAt: T0,
        })
        .returning({ id: leads.id });
      await db.insert(leadEmails).values({
        leadId: l!.id,
        email,
        domain: email.split("@")[1]!,
        kind: "generic",
        sourceType: "mailto",
        verifyStatus: "verified",
        isPrimary: true,
        foundAt: T0,
        updatedAt: T0,
      });
      return l!.id;
    };
    const a = await mk("info@ikiz-ornek.example");
    const b = await mk("sales@ikiz-ornek.example");
    const res = await addLeadsToCampaign(db, fx.campaignId, [a, b], { now: NOW });
    expect(res.added).toBe(1);
    expect(res.excluded).toEqual([{ leadId: b, reasons: ["domain_already_in_campaign"] }]);
  });
});
