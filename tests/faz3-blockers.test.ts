import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CampaignError } from "@/lib/campaigns/errors";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { evaluateSend } from "@/lib/compliance/eligibility";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, leads, templates } from "@/lib/db/schema";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { renderTemplate } from "@/lib/mail/template-engine";
import {
  addSequence,
  createCampaign,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * 10 Kasım incelemesinde bulunan Faz 3 hataları:
 * 1. Demo kampanyası gerçek (demo olmayan) lead'leri kalıcı olarak "temas kuruldu" yapıyordu.
 * 2. Taslak kampanyanın şablonu sonradan arşivlenince/değişince hazır/başlat bunu fark etmiyordu.
 * 3. Bazı gönderim engelleri her gün bir gün ertelenip kampanyayı hiç bitirmiyordu.
 * 4. Gövdedeki yedek metin iki kez kaçışlanıyordu ("Tom &amp; Jerry").
 */

let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});
afterEach(() => client.close());

const seq = async (id: number) =>
  (await db.select().from(campaignLeads).where(eq(campaignLeads.id, id)))[0]!;
const campaign = async (id: number) =>
  (await db.select().from(campaigns).where(eq(campaigns.id, id)))[0]!;

describe("demo kutusu yalnızca demo lead'lerine", () => {
  it("demo olmayan lead uygun sayılmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, leadId } = await addSequence(db, c);
    await db.update(leads).set({ source: "google" }).where(eq(leads.id, leadId));
    const r = await evaluateSend(db, { campaignLeadId: cl, stepIndex: 0 }, { now: T0 });
    expect(r.eligible).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain("lead_not_demo");
  });

  it("dağıtıcı göndermez, diziyi sonlandırır ve lead'i temas kurulmuş yapmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, leadId } = await addSequence(db, c);
    await db.update(leads).set({ source: "google" }).where(eq(leads.id, leadId));
    const p = new FakeMailProvider();
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({ status: "removed", exclusionReasons: ["lead_not_demo"] });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ status: "enriched", lastContactedAt: null });
  });
});

describe("kampanya sonsuza dek açık kalmaz", () => {
  it("şablon arşivlenince kampanya gerekçesiyle duraklar, gönderim olmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    await db.update(templates).set({ archivedAt: T0 });
    const p = new FakeMailProvider();
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(r.pausedCampaigns).toEqual([c]);
    expect((await campaign(c)).pauseReason).toContain("template_archived");
    expect((await seq(cl)).status).toBe("scheduled");
  });

  it("yalnızca bir lead'e özgü eksik değişken diziyi sonlandırır; kampanya duraklamaz, biter", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, leadId } = await addSequence(db, c);
    // Yerleşik şablon {{sehir}}'i yedeksiz kullanır.
    await db.update(leads).set({ city: null }).where(eq(leads.id, leadId));
    const p = new FakeMailProvider();
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({ status: "removed", nextSendAt: null });
    expect((await seq(cl)).exclusionReasons).toContain("missing_variables");
    // Tek dizi sonlandı: kampanya duraklatılmaz, tamamlanır (önceden her gün ertelenip hiç bitmiyordu).
    expect((await campaign(c)).status).toBe("completed");
  });
});

describe("taslak kampanyanın şablonu sonradan bozulursa", () => {
  async function draft(): Promise<number> {
    const c = await createCampaign(db, { steps: 1 });
    await db
      .update(campaigns)
      .set({ status: "draft", startConfirmedAt: null, startedAt: null })
      .where(eq(campaigns.id, c));
    return c;
  }

  async function readyBlockers(c: number): Promise<unknown> {
    try {
      await transitionCampaign(db, c, "ready", { now: T0 + 1, env: {} });
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(CampaignError);
      return (e as CampaignError).detail;
    }
  }

  it("arşivlenmiş şablonla hazır yapılamaz", async () => {
    const c = await draft();
    await db.update(templates).set({ archivedAt: T0 });
    expect(await readyBlockers(c)).toMatchObject({ blockers: ["steps_invalid"] });
  });

  it("dili değişmiş şablonla hazır yapılamaz", async () => {
    const c = await draft();
    await db.update(templates).set({ language: "tr" }).where(eq(templates.language, "en"));
    expect(await readyBlockers(c)).toMatchObject({ blockers: ["steps_invalid"] });
  });

  it("şablon sağlamsa hazır yapılabilir", async () => {
    const c = await draft();
    expect(await readyBlockers(c)).toBeNull();
    expect((await campaign(c)).status).toBe("ready");
  });
});

describe("yedek metin", () => {
  it("gövdede bir kez kaçışlanır, konuda düz metindir", () => {
    const r = renderTemplate(
      { subject: "Merhaba {{sehir|Tom & Jerry}}", bodyHtml: "<p>{{sehir|Tom &amp; Jerry}}</p>" },
      {},
    );
    expect(r.subject).toBe("Merhaba Tom & Jerry");
    expect(r.html).toContain("Tom &amp; Jerry");
    expect(r.html).not.toContain("&amp;amp;");
    expect(r.text).toContain("Tom & Jerry");
  });

  it("gerçek değer yine kaçışlanır", () => {
    const r = renderTemplate({ subject: "x", bodyHtml: "<p>{{sehir|y}}</p>" }, { sehir: "<b>A&B" });
    expect(r.html).toContain("&lt;b&gt;A&amp;B");
  });
});

describe("saat dilimi tablosu", () => {
  it("hedef ülkelerin hepsini kapsar (eksik ülke dizileri gönderilemez kalırdı)", async () => {
    const { COUNTRY_CODES } = await import("@/lib/geo/countries");
    const { COUNTRY_TIME_ZONES } = await import("@/lib/mail/scheduler/window");
    expect(COUNTRY_CODES.filter((c) => !COUNTRY_TIME_ZONES[c])).toEqual([]);
  });
});
