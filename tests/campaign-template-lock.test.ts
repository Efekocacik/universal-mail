import type { Client } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { CampaignError } from "@/lib/campaigns/errors";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { runPreflight } from "@/lib/campaigns/preflight";
import { createCampaign, setCampaignSteps } from "@/lib/campaigns/service";
import type { Db } from "@/lib/db/client";
import { leadEmails, leads, templates } from "@/lib/db/schema";
import { SCHEDULER_FLAG } from "@/lib/mail/scheduler/job";
import { createTemplate, TemplateServiceError, updateTemplate } from "@/lib/mail/template-service";
import { setSetting } from "@/lib/settings";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Başlatma onayı ile şablon kilidi birlikte (Aşama 12, K4): onaylanan önizleme ile giden içerik aynı kalmalıdır.
 *  - Hazır/çalışan/duraklatılmış kampanyadaki şablon düzenlenemez.
 *  - Kilidi aşan bir değişiklik olsa bile (savunma derinliği) başlatma belirteci şablon SÜRÜMÜNÜ ve gönderen
 *    profilini kapsar; eskiyen belirteçle başlatma reddedilir.
 */

let client: Client;
let db: Db;
const ON = { [SCHEDULER_FLAG]: "1" };

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});
afterEach(() => client.close());

let seq = 0;
async function addLead(): Promise<number> {
  const email = `info@kilit${++seq}.example`;
  const [l] = await db
    .insert(leads)
    .values({
      source: "demo",
      status: "enriched",
      countryCode: "GB",
      city: "London",
      categoryKey: "cafe",
      displayName: "Kafe",
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
}

/** Kullanıcı şablonu kullanan, hazır duruma getirilmiş kampanya. */
async function readyWithUserTemplate() {
  const tpl = await createTemplate(
    db,
    {
      name: "Benim ilk e-postam",
      language: "en",
      kind: "initial",
      subject: "A short hello from our team",
      bodyHtml: "<p>Hello {{isletme_adi|there}}, we are {{firma}}.</p>",
    },
    T0,
  );
  const c = await createCampaign(db, { name: "Kilit", mailboxId: DEMO_MAILBOX }, { now: T0 });
  await setCampaignSteps(
    db,
    c.id,
    [{ stepIndex: 0, language: "en", templateId: tpl.id, delayDays: 0 }],
    { expectedUpdatedAt: c.updatedAt, now: T0 },
  );
  await addLeadsToCampaign(db, c.id, [await addLead()], { now: T0 });
  await transitionCampaign(db, c.id, "ready", { now: T0, env: ON });
  return { campaignId: c.id, templateId: tpl.id };
}

const token = async (id: number) => (await runPreflight(db, id, { now: T0, env: ON })).confirmToken;

describe("kampanyadaki şablon kilidi (servis)", () => {
  it("hazır kampanyanın şablonu düzenlenemez; taslağa dönünce düzenlenir ve belirteç değişir", async () => {
    const { campaignId, templateId } = await readyWithUserTemplate();
    const t1 = await token(campaignId);
    expect(await token(campaignId)).toBe(t1); // değişiklik yoksa kararlı

    const err = await updateTemplate(db, templateId, { subject: "Onaydan sonra" }, T0, {
      expectedVersion: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateServiceError);
    expect((err as TemplateServiceError).kind).toBe("in_use");

    await transitionCampaign(db, campaignId, "draft", { now: T0 + 1 });
    await updateTemplate(db, templateId, { subject: "Yeni bir konu satırı" }, T0 + 2, {
      expectedVersion: 1,
    });
    await transitionCampaign(db, campaignId, "ready", { now: T0 + 3, env: ON });
    const t2 = await token(campaignId);
    expect(t2).not.toBe(t1);
    // Eski belirteçle başlatılamaz.
    await expect(
      transitionCampaign(db, campaignId, "start", { now: T0 + 4, env: ON, confirmToken: t1 }),
    ).rejects.toMatchObject({ code: "preflight_stale" });
    expect(
      (
        await transitionCampaign(db, campaignId, "start", {
          now: T0 + 4,
          env: ON,
          confirmToken: t2,
        })
      ).status,
    ).toBe("running");
  });

  it("çalışan ve duraklatılmış kampanyada da kilit sürer", async () => {
    const { campaignId, templateId } = await readyWithUserTemplate();
    await transitionCampaign(db, campaignId, "start", {
      now: T0,
      env: ON,
      confirmToken: await token(campaignId),
    });
    for (const action of [null, "pause"] as const) {
      if (action) await transitionCampaign(db, campaignId, action, { now: T0 + 1 });
      await expect(updateTemplate(db, templateId, { name: "Yeni ad" })).rejects.toMatchObject({
        kind: "in_use",
      });
    }
    await transitionCampaign(db, campaignId, "cancel", { now: T0 + 2 });
    await expect(updateTemplate(db, templateId, { name: "Yeni ad" })).resolves.toMatchObject({
      version: 2,
    });
  });
});

describe("başlatma belirteci içerik değişikliğine duyarlı (kilit atlatılsa bile)", () => {
  it("şablon sürümü değişirse belirteç eskir; eski belirteçle başlatma reddedilir", async () => {
    const { campaignId, templateId } = await readyWithUserTemplate();
    const t1 = await token(campaignId);
    // Kilidi aşan, doğrudan veritabanı değişikliği (ör. hatalı bir gelecek kod yolu).
    await db
      .update(templates)
      .set({ version: sql`${templates.version} + 1`, subject: "Sessizce değişen konu" })
      .where(eq(templates.id, templateId));
    const t2 = await token(campaignId);
    expect(t2).not.toBe(t1);
    const err = await transitionCampaign(db, campaignId, "start", {
      now: T0,
      env: ON,
      confirmToken: t1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CampaignError);
    expect((err as CampaignError).code).toBe("preflight_stale");
  });

  it("gönderen firma profili değişirse (alt bilgi değişir) belirteç eskir", async () => {
    const { campaignId } = await readyWithUserTemplate();
    const t1 = await token(campaignId);
    await setSetting(db, "company.profile", {
      legalName: "Yeni Unvan A.Ş.",
      address: "Başka Mah. 2, Ankara",
      taxId: "9876543210",
      phone: "+90 312 111 11 11",
      contactName: "Mehmet Kaya",
    });
    expect(await token(campaignId)).not.toBe(t1);
    await expect(
      transitionCampaign(db, campaignId, "start", { now: T0, env: ON, confirmToken: t1 }),
    ).rejects.toMatchObject({ code: "preflight_stale" });
  });
});
