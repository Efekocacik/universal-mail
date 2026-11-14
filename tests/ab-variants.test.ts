import type { Client } from "@libsql/client";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as campaignRoute from "@/app/api/campaigns/[id]/route";
import * as statsRoute from "@/app/api/campaigns/[id]/stats/route";
import * as stepsRoute from "@/app/api/campaigns/[id]/steps/route";
import * as templateRoute from "@/app/api/templates/[id]/route";
import * as templatesRoute from "@/app/api/templates/route";
import { computeStartPlan } from "@/lib/campaigns/preflight";
import { getCampaignStats } from "@/lib/campaigns/stats";
import type { Db } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  campaignSteps,
  campaignStepTemplates,
  leads,
  messages,
  templates,
} from "@/lib/db/schema";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { seedCategories } from "@/lib/scan/categories";
import { sendCampaignStep } from "@/lib/mail/send-service";
import {
  assignSubjectVariant,
  listTemplates,
  resolveStepTemplateId,
} from "@/lib/mail/template-service";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * Faz 5 (paket T): kategori varyantları ve A/B konu. Adımların API ile yazılması (uyuşmazlık, bilgi amaçlı şablon,
 * değiştirmede eski varyantların silinmesi, şablon kilidi), gönderimde kategoriye göre şablon seçimi, deterministik
 * ve dengeli A/B ataması, `subject_variant` kaydı ve `/stats`. Bellek içi veritabanı; demo sağlayıcı, ağ yok.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HANDLE];
  client.close();
});

type Json = Record<string, unknown>;
const req = (method: string, url: string, payload?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
async function call(res: Promise<Response>): Promise<{ status: number; body: Json }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Json };
}

async function tpl(language: string, kind: "initial" | "followup", categoryKey: string | null) {
  const rows = await db
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.language, language),
        eq(templates.kind, kind),
        categoryKey === null
          ? isNull(templates.categoryKey)
          : eq(templates.categoryKey, categoryKey),
      ),
    );
  return rows[0]!;
}

async function draftCampaign(): Promise<{ id: number; updatedAt: number }> {
  const [c] = await db
    .insert(campaigns)
    .values({
      name: "Varyant",
      status: "draft",
      mailboxId: DEMO_MAILBOX,
      selection: {},
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: campaigns.id, updatedAt: campaigns.updatedAt });
  return c!;
}

const putSteps = (id: number, expectedUpdatedAt: number, steps: unknown[]) =>
  call(
    stepsRoute.PUT(req("PUT", `/api/campaigns/${id}/steps`, { expectedUpdatedAt, steps }), ctx(id)),
  );

describe("A/B ataması ve şablon çözümleme (saf)", () => {
  it("varyant deterministik ve dengeli: çift no A, tek no B", () => {
    expect(assignSubjectVariant(2)).toBe("a");
    expect(assignSubjectVariant(3)).toBe("b");
    expect(assignSubjectVariant(3)).toBe(assignSubjectVariant(3));
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const a = ids.filter((i) => assignSubjectVariant(i) === "a").length;
    expect(a).toBe(50);
  });

  it("kategori varyantı varsa o, yoksa adımın şablonu; kategorisiz lead adımın şablonunu alır", async () => {
    const general = await tpl("en", "initial", null);
    const cafe = await tpl("en", "initial", "cafe");
    const c = await draftCampaign();
    await db.insert(campaignSteps).values({
      campaignId: c.id,
      stepIndex: 0,
      language: "en",
      templateId: general.id,
      delayDays: 0,
    });
    await db.insert(campaignStepTemplates).values({
      campaignId: c.id,
      stepIndex: 0,
      language: "en",
      categoryKey: "cafe",
      templateId: cafe.id,
    });
    const base = { campaignId: c.id, stepIndex: 0, language: "en" };
    expect(await resolveStepTemplateId(db, { ...base, categoryKey: "cafe" }, general.id)).toBe(
      cafe.id,
    );
    expect(await resolveStepTemplateId(db, { ...base, categoryKey: "pub" }, general.id)).toBe(
      general.id,
    );
    expect(await resolveStepTemplateId(db, { ...base, categoryKey: null }, general.id)).toBe(
      general.id,
    );
    expect(await resolveStepTemplateId(db, { ...base, categoryKey: "  " }, general.id)).toBe(
      general.id,
    );
  });
});

describe("PUT /api/campaigns/:id/steps — kategori varyantları", () => {
  it("varyantlar yazılır, GET'te döner; yeniden yazmada eskiler silinir (CASCADE)", async () => {
    const general = await tpl("en", "initial", null);
    const cafe = await tpl("en", "initial", "cafe");
    const pub = await tpl("en", "initial", "pub");
    const c = await draftCampaign();
    const r1 = await putSteps(c.id, c.updatedAt, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: [
          { categoryKey: "cafe", templateId: cafe.id },
          { categoryKey: "pub", templateId: pub.id },
        ],
      },
    ]);
    expect(r1.status).toBe(200);
    const g = await call(campaignRoute.GET(req("GET", `/api/campaigns/${c.id}`), ctx(c.id)));
    const steps = g.body.steps as { categoryTemplates?: { categoryKey: string }[] }[];
    expect(steps[0]!.categoryTemplates!.map((x) => x.categoryKey)).toEqual(["cafe", "pub"]);

    const r2 = await putSteps(c.id, r1.body.updatedAt as number, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: [{ categoryKey: "pub", templateId: pub.id }],
      },
    ]);
    expect(r2.status).toBe(200);
    const rows = await db
      .select()
      .from(campaignStepTemplates)
      .where(eq(campaignStepTemplates.campaignId, c.id));
    expect(rows.map((r) => r.categoryKey)).toEqual(["pub"]);

    // Varyantsız adım: alan hiç dönmez (eski istemcilerin gördüğü biçim).
    const r3 = await putSteps(c.id, r2.body.updatedAt as number, [
      { stepIndex: 0, language: "en", templateId: general.id, delayDays: 0 },
    ]);
    expect(r3.status).toBe(200);
    const g3 = await call(campaignRoute.GET(req("GET", `/api/campaigns/${c.id}`), ctx(c.id)));
    expect((g3.body.steps as Json[])[0]).not.toHaveProperty("categoryTemplates");
  });

  it("dili veya türü farklı varyant: 400 CATEGORY_TEMPLATE_MISMATCH; hiçbir şey yazılmaz", async () => {
    const general = await tpl("en", "initial", null);
    const trCafe = await tpl("tr", "initial", "cafe");
    const enFollow = await tpl("en", "followup", null);
    const c = await draftCampaign();
    for (const wrong of [trCafe.id, enFollow.id]) {
      const r = await putSteps(c.id, c.updatedAt, [
        {
          stepIndex: 0,
          language: "en",
          templateId: general.id,
          delayDays: 0,
          categoryTemplates: [{ categoryKey: "cafe", templateId: wrong }],
        },
      ]);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("CATEGORY_TEMPLATE_MISMATCH");
    }
    expect(await db.select().from(campaignSteps)).toHaveLength(0);
  });

  it("bilgi amaçlı (DE) şablon adımda veya varyantta: 400 TEMPLATE_INFO_ONLY", async () => {
    const de = await tpl("de", "initial", null);
    expect(de.infoOnly).toBe(true);
    const c = await draftCampaign();
    const r = await putSteps(c.id, c.updatedAt, [
      { stepIndex: 0, language: "de", templateId: de.id, delayDays: 0 },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TEMPLATE_INFO_ONLY");

    const general = await tpl("en", "initial", null);
    await db.update(templates).set({ infoOnly: true }).where(eq(templates.id, general.id));
    const cafe = await tpl("en", "initial", "cafe");
    await db.update(templates).set({ infoOnly: false }).where(eq(templates.id, general.id));
    await db.update(templates).set({ infoOnly: true }).where(eq(templates.id, cafe.id));
    const r2 = await putSteps(c.id, c.updatedAt, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: [{ categoryKey: "cafe", templateId: cafe.id }],
      },
    ]);
    expect(r2.body.code).toBe("TEMPLATE_INFO_ONLY");
  });

  it("aynı kategori iki kez veya 10'dan fazla varyant: 400 VALIDATION", async () => {
    const general = await tpl("en", "initial", null);
    const cafe = await tpl("en", "initial", "cafe");
    const c = await draftCampaign();
    const dup = await putSteps(c.id, c.updatedAt, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: [
          { categoryKey: "cafe", templateId: cafe.id },
          { categoryKey: "cafe", templateId: cafe.id },
        ],
      },
    ]);
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe("VALIDATION");
    const many = await putSteps(c.id, c.updatedAt, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: Array.from({ length: 11 }, (_, i) => ({
          categoryKey: `k${i}`,
          templateId: cafe.id,
        })),
      },
    ]);
    expect(many.body.code).toBe("VALIDATION");
  });

  it("şablon kilidi varyantı da kapsar: hazır kampanyanın varyant şablonu değiştirilemez (409 IN_USE)", async () => {
    const general = await tpl("en", "initial", null);
    // Kullanıcı kopyası (yerleşik şablon zaten salt okunur). Kategori anahtarı bilinen bir kategori olmalı.
    await seedCategories(db);
    const created = await call(
      templatesRoute.POST(
        req("POST", "/api/templates", {
          name: "Kafe kopyası",
          language: "en",
          kind: "initial",
          categoryKey: "cafe",
          subject: "Supplies for your café",
          bodyHtml: "<p>Hello from {{firma}}.</p>",
        }),
        undefined,
      ),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const copyId = created.body.id as number;
    const c = await draftCampaign();
    const put = await putSteps(c.id, c.updatedAt, [
      {
        stepIndex: 0,
        language: "en",
        templateId: general.id,
        delayDays: 0,
        categoryTemplates: [{ categoryKey: "cafe", templateId: copyId }],
      },
    ]);
    expect(put.status).toBe(200);
    await db.update(campaigns).set({ status: "ready" }).where(eq(campaigns.id, c.id));

    const list = await listTemplates(db);
    expect(list.find((x) => x.id === copyId)!.lockedBy).toBe(1);
    const patch = await call(
      templateRoute.PATCH(
        req("PATCH", `/api/templates/${copyId}`, { expectedVersion: 1, subject: "Changed" }),
        ctx(copyId),
      ),
    );
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("IN_USE");
  });
});

describe("gönderim: kategori varyantı + A/B konu (demo)", () => {
  async function setupAb() {
    const campaignId = await createCampaign(db, { steps: 2 });
    const cafe = await tpl("en", "initial", "cafe");
    const follow = await tpl("en", "followup", null);
    await db
      .update(campaignSteps)
      .set({ templateId: follow.id })
      .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepIndex, 1)));
    await db.insert(campaignStepTemplates).values({
      campaignId,
      stepIndex: 0,
      language: "en",
      categoryKey: "cafe",
      templateId: cafe.id,
    });
    return { campaignId, cafe };
  }

  it("kafe lead'i kafe şablonunu alır; konu varyantı dizi numarasına göre; kategorisi farklı lead genel şablonu", async () => {
    const { campaignId, cafe } = await setupAb();
    const general = (
      await db.select().from(campaignSteps).where(eq(campaignSteps.campaignId, campaignId))
    ).find((s) => s.stepIndex === 0)!.templateId;
    const seqs = [] as Awaited<ReturnType<typeof addSequence>>[];
    for (let i = 0; i < 4; i++) seqs.push(await addSequence(db, campaignId));
    // Biri bar/pub: varyantı olmayan kategori → genel şablon, A/B yok.
    await db.update(leads).set({ categoryKey: "pub" }).where(eq(leads.id, seqs[3]!.leadId));

    const p = new FakeMailProvider({ now: () => T0 });
    for (const [i, s] of seqs.entries()) {
      const at = T0 + i * 10 * 60_000;
      const r = await sendCampaignStep(
        db,
        { campaignLeadId: s.cl, stepIndex: 0 },
        { provider: p, now: () => at },
      );
      expect(r.outcome, `dizi ${i}`).toBe("sent");
    }
    const sent = await db
      .select()
      .from(messages)
      .where(eq(messages.campaignId, campaignId))
      .orderBy(messages.id);
    for (const [i, s] of seqs.slice(0, 3).entries()) {
      const m = sent[i]!;
      expect(m.templateId).toBe(cafe.id);
      const v = assignSubjectVariant(s.cl);
      expect(m.subjectVariant).toBe(v);
      const expected = v === "a" ? cafe.subject : cafe.subjectB!.replace("{{sehir}}", "London");
      expect(m.subjectLogged).toBe(expected);
    }
    expect(sent[3]).toMatchObject({ templateId: general, subjectVariant: null });

    // İstatistik: varyant başına gönderilen; yanıt dizi durumundan.
    const replier = seqs.find((s) => assignSubjectVariant(s.cl) === "b")!;
    await db
      .update(campaignLeads)
      .set({ status: "replied" })
      .where(eq(campaignLeads.id, replier.cl));
    const stats = await getCampaignStats(db, campaignId);
    const bCount = seqs.slice(0, 3).filter((s) => assignSubjectVariant(s.cl) === "b").length;
    expect(stats.ab).toEqual({
      a: { sent: 3 - bCount, replied: 0, opened: 0 },
      b: { sent: bCount, replied: 1, opened: 0 },
    });
    expect(stats.opens).toEqual({ enabled: false, liveSupported: false, sent: 4, opened: 0 });

    const route = await call(
      statsRoute.GET(req("GET", `/api/campaigns/${campaignId}/stats`), ctx(campaignId)),
    );
    expect(route.status).toBe(200);
    expect(route.body).toEqual(stats);
  });

  it("takip iletisi ilk konuyu devralır ve varyantı NULL'dır; yeniden deneme aynı varyantı verir", async () => {
    const { campaignId } = await setupAb();
    const s = await addSequence(db, campaignId);
    const p = new FakeMailProvider({ now: () => T0 });
    expect(
      (
        await sendCampaignStep(
          db,
          { campaignLeadId: s.cl, stepIndex: 0 },
          { provider: p, now: () => T0 },
        )
      ).outcome,
    ).toBe("sent");
    const first = (await db.select().from(messages).where(eq(messages.campaignLeadId, s.cl)))[0]!;
    const later = T0 + 7 * 86_400_000;
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 1 },
      { provider: p, now: () => later },
    );
    expect(r.outcome).toBe("sent");
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.campaignLeadId, s.cl))
      .orderBy(messages.stepIndex);
    expect(msgs[1]!.subjectVariant).toBeNull();
    expect(msgs[1]!.subjectLogged).toBe(`Re: ${first.subjectLogged}`);
    expect(first.subjectVariant).toBe(assignSubjectVariant(s.cl));
  });

  it("bilgi amaçlı şablona dönüşen adım gönderilmez: compose_failed + template_info_only", async () => {
    const campaignId = await createCampaign(db, { steps: 1 });
    const s = await addSequence(db, campaignId);
    const [step] = await db
      .select()
      .from(campaignSteps)
      .where(eq(campaignSteps.campaignId, campaignId));
    await db.update(templates).set({ infoOnly: true }).where(eq(templates.id, step!.templateId));
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { provider: new FakeMailProvider({ now: () => T0 }), now: () => T0 },
    );
    expect(r.outcome).toBe("not_sendable");
    expect(r).toMatchObject({ code: "compose_failed" });
    expect((r as { errors: { code: string }[] }).errors.map((e) => e.code)).toContain(
      "template_info_only",
    );
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("istatistik: bilinmeyen kampanya 404, varyantsız kampanyada ab null", async () => {
    const missing = await call(statsRoute.GET(req("GET", "/api/campaigns/999/stats"), ctx(999)));
    expect(missing.status).toBe(404);
    const campaignId = await createCampaign(db, { steps: 1 });
    expect((await getCampaignStats(db, campaignId)).ab).toBeNull();
  });
});

describe("başlatma özeti: varyantlar denetlenir ve belirtece girer", () => {
  it("arşivlenen varyant şablonu steps_invalid; varyant değişince belirteç değişir", async () => {
    const general = await tpl("en", "initial", null);
    const cafe = await tpl("en", "initial", "cafe");
    const c = await draftCampaign();
    await db.insert(campaignSteps).values({
      campaignId: c.id,
      stepIndex: 0,
      language: "en",
      templateId: general.id,
      delayDays: 0,
    });
    const env = { FAZ3_DEMO_SCHEDULER_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
    const before = await computeStartPlan(db, c.id, { now: T0, env });
    await db.insert(campaignStepTemplates).values({
      campaignId: c.id,
      stepIndex: 0,
      language: "en",
      categoryKey: "cafe",
      templateId: cafe.id,
    });
    const after = await computeStartPlan(db, c.id, { now: T0, env });
    expect(after.token).not.toBe(before.token);
    expect(after.blockers).not.toContain("steps_invalid");

    await db.update(templates).set({ archivedAt: T0 }).where(eq(templates.id, cafe.id));
    const archived = await computeStartPlan(db, c.id, { now: T0, env });
    expect(archived.blockers).toContain("steps_invalid");
  });
});
