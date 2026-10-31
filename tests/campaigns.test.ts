import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLeadsToCampaign,
  listCampaignQueue,
  removeCampaignLead,
} from "@/lib/campaigns/enrollment";
import { CampaignError } from "@/lib/campaigns/errors";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { runPreflight } from "@/lib/campaigns/preflight";
import { purgeDemoCampaignData } from "@/lib/campaigns/purge";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  setCampaignSteps,
  updateCampaign,
} from "@/lib/campaigns/service";
import { tightenDemoPolicy } from "@/lib/compliance/policy-service";
import { hashEmail, suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import {
  auditLog,
  campaignLeads,
  campaigns,
  campaignSteps,
  jobs,
  leadEmails,
  leads,
  mailboxes,
  messages,
  suppressions,
  templates,
} from "@/lib/db/schema";
import { purgeDemoData } from "@/lib/leads/mutations";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import type { MailProvider, ProviderResult } from "@/lib/mail/provider/provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { MAIL_SEND_JOB, SCHEDULER_FLAG } from "@/lib/mail/scheduler/job";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import { createTemplate } from "@/lib/mail/template-service";
import { setSetting } from "@/lib/settings";
import { DEMO_MAILBOX, openMemoryDb, seedBase, T0 } from "./helpers/campaign-fixture";

/**
 * Aşama 10: kampanya yönetimi servisleri, durum geçişleri, dağıtıcıyla yarışlar ve demo temizliği.
 * Veritabanı BELLEKTE; gerçek gönderim yok, `.data` kullanılmaz, Google verisi yok.
 */

let client: Client;
let db: Db;
const ON = { [SCHEDULER_FLAG]: "1" };
const OFF = {};
const DAY = 86_400_000;
let initialTpl: number;
let followupTpl: number;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  const [en] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.language, "en"), eq(templates.kind, "initial")));
  initialTpl = en!.id;
  followupTpl = (
    await createTemplate(
      db,
      {
        name: "Takip",
        language: "en",
        kind: "followup",
        subject: "Following up",
        bodyHtml: "<p>Hello again from our team.</p>",
      },
      T0,
    )
  ).id;
});

afterEach(() => {
  client.close();
});

let seq = 0;
async function lead(
  o: {
    country?: string;
    email?: string;
    source?: "demo" | "import";
    kind?: "generic" | "personal" | "consumer";
    verify?: "verified" | "unverified";
  } = {},
): Promise<number> {
  const email = o.email ?? `info@shop${++seq}.example`;
  const [l] = await db
    .insert(leads)
    .values({
      source: o.source ?? "demo",
      status: "enriched",
      countryCode: o.country ?? "GB",
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
    kind: o.kind ?? "generic",
    sourceType: "mailto",
    verifyStatus: o.verify ?? "verified",
    isPrimary: true,
    foundAt: T0,
    updatedAt: T0,
  });
  return l!.id;
}

async function campaignRow(id: number) {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return c!;
}

async function sequences(id: number) {
  return db
    .select()
    .from(campaignLeads)
    .where(eq(campaignLeads.campaignId, id))
    .orderBy(campaignLeads.id);
}

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(CampaignError);
  await p.catch((e: CampaignError) => expect(e.code).toBe(code));
}

/** Demo posta kutulu, tek (veya iki) adımlı, hazır bir kampanya ve verilen lead'ler. */
async function readyCampaign(o: { leads?: number; steps?: 1 | 2; dailyCap?: number } = {}) {
  const c = await createCampaign(
    db,
    { name: "Açılış", mailboxId: DEMO_MAILBOX, dailyCap: o.dailyCap },
    { now: T0 },
  );
  const steps = [{ stepIndex: 0, language: "en", templateId: initialTpl, delayDays: 0 }];
  if (o.steps === 2)
    steps.push({ stepIndex: 1, language: "en", templateId: followupTpl, delayDays: 5 });
  const s = await setCampaignSteps(db, c.id, steps, { expectedUpdatedAt: c.updatedAt, now: T0 });
  void s;
  const ids: number[] = [];
  for (let i = 0; i < (o.leads ?? 2); i++) ids.push(await lead());
  await addLeadsToCampaign(db, c.id, ids, { now: T0 });
  await transitionCampaign(db, c.id, "ready", { now: T0, env: ON });
  return { id: c.id, leadIds: ids };
}

async function start(id: number, now = T0) {
  const pf = await runPreflight(db, id, { now, env: ON });
  return transitionCampaign(db, id, "start", { now, env: ON, confirmToken: pf.confirmToken });
}

function fake() {
  return new FakeMailProvider({ now: () => T0 });
}

/* ------------------------------------------------------------------------------------------------ */

describe("iyimser kilit (updated_at kesin artar)", () => {
  it("aynı milisaniyedeki ikinci güncelleme belirteci değiştirir; eski belirteç eşleşmez", async () => {
    const c = await createCampaign(db, { name: "A" }, { now: T0 });
    const u1 = await updateCampaign(
      db,
      c.id,
      { name: "B" },
      { expectedUpdatedAt: c.updatedAt, now: T0 },
    );
    expect(u1.updatedAt).toBe(T0 + 1);
    const u2 = await updateCampaign(
      db,
      c.id,
      { name: "C" },
      { expectedUpdatedAt: u1.updatedAt, now: T0 },
    );
    expect(u2.updatedAt).toBe(T0 + 2);
    await expectError(
      updateCampaign(db, c.id, { name: "X" }, { expectedUpdatedAt: c.updatedAt, now: T0 }),
      "conflict",
    );
    await expectError(
      updateCampaign(db, c.id, { name: "X" }, { expectedUpdatedAt: u1.updatedAt, now: T0 }),
      "conflict",
    );
    expect((await campaignRow(c.id)).name).toBe("C");
  });

  it("saat geriye gitse bile belirteç artar", async () => {
    const c = await createCampaign(db, { name: "A" }, { now: T0 });
    const u = await updateCampaign(
      db,
      c.id,
      { name: "B" },
      { expectedUpdatedAt: c.updatedAt, now: T0 - DAY },
    );
    expect(u.updatedAt).toBe(T0 + 1);
  });

  it("aynı belirteçle eşzamanlı iki düzenlemeden en fazla biri uygulanır", async () => {
    const c = await createCampaign(db, { name: "A" }, { now: T0 });
    const results = await Promise.allSettled(
      ["B", "C", "D"].map((name) =>
        updateCampaign(db, c.id, { name }, { expectedUpdatedAt: c.updatedAt, now: T0 }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect((await campaignRow(c.id)).updatedAt).toBe(T0 + 1);
  });

  it("dağıtıcının otomatik duraklatması da belirteci artırır", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await start(id);
    const before = (await campaignRow(id)).updatedAt;
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: fake() });
    const after = await campaignRow(id);
    expect(after.status).toBe("paused");
    expect(after.updatedAt).toBeGreaterThan(before);
  });
});

describe("kampanya oluşturma ve düzenleme", () => {
  it("taslak olarak oluşur; liste ve detay sayılarla döner", async () => {
    const c = await createCampaign(db, { name: "  Kasım  ", mailboxId: DEMO_MAILBOX }, { now: T0 });
    const d = await getCampaign(db, c.id);
    expect(d).toMatchObject({
      name: "Kasım",
      status: "draft",
      dailyCap: 20,
      minGapS: 90,
      maxGapS: 240,
      sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      steps: [],
      counts: {},
    });
    expect((await listCampaigns(db)).map((x) => x.id)).toEqual([c.id]);
    expect(await listCampaigns(db, { status: "running" })).toHaveLength(0);
  });

  it("yalnızca bağlı demo posta kutusu atanabilir (gerçek gönderim kapalı)", async () => {
    const [live] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    await expectError(createCampaign(db, { name: "X", mailboxId: live!.id }), "live_disabled");
    await expectError(createCampaign(db, { name: "X", mailboxId: 999 }), "not_found");
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, DEMO_MAILBOX));
    await expectError(createCampaign(db, { name: "X", mailboxId: DEMO_MAILBOX }), "invalid_input");
  });

  it("geçersiz ayarlar reddedilir (pencere yalnızca daraltılabilir)", async () => {
    for (const bad of [
      { name: "" },
      { name: "x".repeat(121) },
      { name: "A", sendWindow: { days: [1, 6], start: "09:00", end: "17:00" } },
      { name: "A", sendWindow: { days: [1], start: "08:00", end: "12:00" } },
      { name: "A", dailyCap: 81 },
      { name: "A", minGapS: 60 },
      { name: "A", minGapS: 200, maxGapS: 100 },
    ]) {
      await expectError(createCampaign(db, bad), "invalid_input");
    }
  });

  it("adımlar doğrulanır", async () => {
    const c = await createCampaign(db, { name: "A" }, { now: T0 });
    const tok = { expectedUpdatedAt: c.updatedAt, now: T0 };
    const s0 = { stepIndex: 0, language: "en", templateId: initialTpl, delayDays: 0 };
    const s1 = { stepIndex: 1, language: "en", templateId: followupTpl, delayDays: 5 };
    for (const steps of [
      [],
      [s1],
      [{ ...s0, delayDays: 2 }],
      [s0, { ...s1, delayDays: 3 }],
      [s0, { ...s1, stepIndex: 2 }],
      [{ ...s0, templateId: followupTpl }],
      [s0, { ...s1, templateId: initialTpl }],
      [{ ...s0, language: "tr" }],
      [{ ...s0, templateId: 9999 }],
      [s0, s0],
    ]) {
      await expectError(setCampaignSteps(db, c.id, steps, tok), "invalid_steps");
    }
    const ok = await setCampaignSteps(db, c.id, [s0, s1], tok);
    expect((await getCampaign(db, c.id)).steps).toEqual([s0, s1]);
    await db.update(templates).set({ archivedAt: T0 }).where(eq(templates.id, followupTpl));
    await expectError(
      setCampaignSteps(db, c.id, [s0, s1], { expectedUpdatedAt: ok.updatedAt, now: T0 }),
      "invalid_steps",
    );
  });

  it("taslak dışındaki kampanya düzenlenemez", async () => {
    const { id } = await readyCampaign();
    const cur = await campaignRow(id);
    await expectError(
      updateCampaign(db, id, { name: "Y" }, { expectedUpdatedAt: cur.updatedAt }),
      "not_editable",
    );
    await expectError(
      setCampaignSteps(
        db,
        id,
        [{ stepIndex: 0, language: "en", templateId: initialTpl, delayDays: 0 }],
        { expectedUpdatedAt: cur.updatedAt },
      ),
      "not_editable",
    );
  });
});

describe("lead ekleme ve çıkarma", () => {
  it("uygun lead pending eklenir; uygunsuzlar gerekçesiyle excluded; tekrar eklenemez", async () => {
    const c = await createCampaign(db, { name: "A", mailboxId: DEMO_MAILBOX }, { now: T0 });
    const ok = await lead({ email: "info@good.example" });
    const de = await lead({ country: "DE" });
    const consumer = await lead({ email: "someone@gmail.com" });
    const unverified = await lead({ verify: "unverified" });
    const suppressed = await lead({ email: "hello@blocked.example" });
    await suppressEmail(db, {
      email: "hello@blocked.example",
      reason: "unsubscribe",
      source: "link",
    });
    const sameDomain = await lead({ email: "sales@good.example" });

    const r = await addLeadsToCampaign(
      db,
      c.id,
      [ok, de, consumer, unverified, suppressed, sameDomain, ok, 424242],
      { now: T0 },
    );
    expect(r.added).toBe(1);
    const reasons = Object.fromEntries(r.excluded.map((e) => [e.leadId, e.reasons]));
    expect(reasons[de]).toContain("country_blocked");
    expect(reasons[consumer]).toContain("email_consumer");
    expect(reasons[unverified]).toContain("email_not_verified");
    expect(reasons[suppressed]).toContain("suppressed");
    expect(reasons[sameDomain]).toContain("domain_already_in_campaign");
    expect(reasons[424242]).toEqual(["lead_not_found"]);

    const rows = await sequences(c.id);
    const good = rows.find((x) => x.leadId === ok)!;
    expect(good).toMatchObject({
      status: "pending",
      recipientEmail: "info@good.example",
      recipientHash: hashEmail("info@good.example"),
      recipientDomain: "good.example",
      language: "en",
    });
    expect(
      rows.filter((x) => x.status === "excluded").every((x) => x.recipientEmail === null),
    ).toBe(true);

    const again = await addLeadsToCampaign(db, c.id, [ok, de], { now: T0 });
    expect(again).toMatchObject({ added: 0, duplicates: [ok, de] });

    // Çıkarılan lead aynı kampanyaya tekrar eklenemez.
    await removeCampaignLead(db, c.id, good.id, { now: T0 });
    expect((await addLeadsToCampaign(db, c.id, [ok], { now: T0 })).duplicates).toEqual([ok]);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "campaign.leads_added")),
    ).toHaveLength(3);
  });

  it("çalışan kampanyaya lead eklenmez; sınır ve girdi denetlenir", async () => {
    const { id } = await readyCampaign();
    await start(id);
    await expectError(addLeadsToCampaign(db, id, [await lead()]), "not_editable");
    await expectError(addLeadsToCampaign(db, id, []), "invalid_input");
    await expectError(
      addLeadsToCampaign(
        db,
        id,
        Array.from({ length: 501 }, (_, i) => i + 1),
      ),
      "invalid_input",
    );
  });

  it("gönderimdeki dizi çıkarılamaz; çıkarılan zamanlanmış dizi hiç gönderilmez", async () => {
    const { id } = await readyCampaign({ leads: 2 });
    await start(id);
    const [a, b] = await sequences(id);
    await db.update(campaignLeads).set({ status: "in_flight" }).where(eq(campaignLeads.id, a!.id));
    await expectError(removeCampaignLead(db, id, a!.id), "in_flight");
    await removeCampaignLead(db, id, b!.id, { now: T0 });
    const p = fake();
    const d = new MailDispatcher(db);
    for (let i = 0; i < 5; i++) await d.dispatchOnce({ now: () => T0 + i * 300_000, provider: p });
    expect(p.calls).toBe(0);
    expect((await sequences(id)).map((x) => x.status)).toEqual(["in_flight", "removed"]);
    await expectError(removeCampaignLead(db, id, 99999), "not_found");
    const q = await listCampaignQueue(db, id);
    expect(q.total).toBe(2);
    expect(q.items[1]!.recipientMasked).toMatch(/^i\*\*\*@/);
    expect(JSON.stringify(q)).not.toContain("info@shop");
  });
});

describe("başlatma öncesi denetim (preflight)", () => {
  it("engelleri, sayıları ve en fazla 5 önizlemeyi verir; veritabanına yazmaz", async () => {
    const { id } = await readyCampaign({ leads: 7 });
    const before = JSON.stringify([
      await db.select().from(campaigns),
      await db.select().from(campaignLeads),
      await db.select().from(messages),
      await db.select().from(auditLog),
    ]);
    const pf = await runPreflight(db, id, { now: T0, env: ON });
    expect(pf).toMatchObject({
      ready: true,
      blockers: [],
      counts: { pending: 7, eligible: 7, ineligible: 0 },
      estimate: { perDay: 20, days: 1, earliestSendAt: T0 },
    });
    expect(pf.previews).toHaveLength(5);
    expect(pf.previews[0]!.recipientMasked).toMatch(/^i\*\*\*@/);
    expect(pf.previews[0]!.subject.length).toBeGreaterThan(0);
    expect(pf.previews[0]!.html).toContain("[DEMO]");
    expect(pf.confirmToken).toMatch(/^[0-9a-f]{32}$/);
    const after = JSON.stringify([
      await db.select().from(campaigns),
      await db.select().from(campaignLeads),
      await db.select().from(messages),
      await db.select().from(auditLog),
    ]);
    expect(after).toBe(before);
  });

  it("engeller: bayrak kapalı, onay ve profil eksik, adım yok", async () => {
    const { id } = await readyCampaign();
    expect((await runPreflight(db, id, { now: T0, env: OFF })).blockers).toEqual([
      "scheduler_disabled",
    ]);
    await client.execute("DELETE FROM settings WHERE key IN ('consent', 'company.profile')");
    await client.execute(`DELETE FROM campaign_steps WHERE campaign_id = ${id}`);
    const pf = await runPreflight(db, id, { now: T0, env: ON });
    expect(pf.ready).toBe(false);
    expect(pf.blockers).toEqual(
      expect.arrayContaining(["consent_missing", "sender_profile_incomplete", "steps_missing"]),
    );
  });

  it("belirteç değişikliklerle eskir (lead ekleme, suppression)", async () => {
    const { id } = await readyCampaign();
    const t1 = (await runPreflight(db, id, { now: T0, env: ON })).confirmToken;
    expect((await runPreflight(db, id, { now: T0, env: ON })).confirmToken).toBe(t1);
    const [first] = await sequences(id);
    await suppressEmail(db, { email: first!.recipientEmail!, reason: "manual", source: "manual" });
    const pf2 = await runPreflight(db, id, { now: T0, env: ON });
    expect(pf2.confirmToken).not.toBe(t1);
    expect(pf2.exclusions).toEqual({ suppressed: 1 });
    await expectError(
      transitionCampaign(db, id, "start", { now: T0, env: ON, confirmToken: t1 }),
      "preflight_stale",
    );
  });
});

describe("durum geçişleri", () => {
  it("geçerli geçişler; geçersizler reddedilir; tekrar istek idempotent", async () => {
    const c = await createCampaign(db, { name: "A", mailboxId: DEMO_MAILBOX }, { now: T0 });
    await expectError(transitionCampaign(db, c.id, "start", { env: ON }), "invalid_transition");
    await expectError(transitionCampaign(db, c.id, "pause", { env: ON }), "invalid_transition");
    await expectError(transitionCampaign(db, c.id, "ready", { env: ON }), "preflight_failed"); // adım yok
    await expectError(transitionCampaign(db, 777, "pause"), "not_found");

    const { id } = await readyCampaign();
    expect(await transitionCampaign(db, id, "ready", { env: ON })).toMatchObject({
      changed: false,
    });
    expect((await transitionCampaign(db, id, "draft", { now: T0 })).status).toBe("draft");
    await transitionCampaign(db, id, "ready", { now: T0, env: ON });
    await expectError(transitionCampaign(db, id, "start", { now: T0, env: ON }), "preflight_stale");
    expect(await start(id)).toMatchObject({
      changed: true,
      status: "running",
      scheduled: 2,
      excluded: 0,
    });
    expect(await transitionCampaign(db, id, "pause", { now: T0 })).toMatchObject({ changed: true });
    expect(await transitionCampaign(db, id, "pause", { now: T0 })).toMatchObject({
      changed: false,
    });
    expect((await transitionCampaign(db, id, "resume", { now: T0, env: ON })).status).toBe(
      "running",
    );
    expect((await transitionCampaign(db, id, "cancel", { now: T0 })).status).toBe("cancelled");
    for (const a of ["start", "pause", "resume", "ready", "draft"] as const) {
      await expectError(transitionCampaign(db, id, a, { env: ON }), "invalid_transition");
    }
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "campaign.start",
        "campaign.pause",
        "campaign.resume",
        "campaign.cancel",
      ]),
    );
  });

  it("başlatma: bayrak kapalıysa reddedilir; açıkken diziler zamanlanır ve dağıtım işi kurulur", async () => {
    const { id } = await readyCampaign({ leads: 3 });
    const pf = await runPreflight(db, id, { now: T0, env: ON });
    await expectError(
      transitionCampaign(db, id, "start", { now: T0, env: OFF, confirmToken: pf.confirmToken }),
      "scheduler_disabled",
    );
    expect((await campaignRow(id)).status).toBe("ready");

    // Başlatmadan hemen önce bir alıcı engellendi: başlatma yeniden denetler ve onu dışlar.
    const [first] = await sequences(id);
    await suppressEmail(db, { email: first!.recipientEmail!, reason: "manual", source: "manual" });
    const fresh = await runPreflight(db, id, { now: T0, env: ON });
    const r = await transitionCampaign(db, id, "start", {
      now: T0,
      env: ON,
      confirmToken: fresh.confirmToken,
    });
    expect(r).toMatchObject({ scheduled: 2, excluded: 1 });
    const c = await campaignRow(id);
    expect(c).toMatchObject({ status: "running", startConfirmedAt: T0, startedAt: T0 });
    expect((await sequences(id)).map((s) => s.status)).toEqual([
      "excluded",
      "scheduled",
      "scheduled",
    ]);
    expect((await sequences(id))[0]!.exclusionReasons).toEqual(["suppressed"]);
    expect(await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB))).toHaveLength(1);
  });

  it("uygun dizi yoksa başlatılamaz", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await tightenDemoPolicy(db, { scope: "demo", countryCode: "GB", mode: "blocked" });
    const pf = await runPreflight(db, id, { now: T0, env: ON });
    expect(pf.blockers).toEqual(["no_eligible_leads"]);
    await expectError(
      transitionCampaign(db, id, "start", { now: T0, env: ON, confirmToken: pf.confirmToken }),
      "preflight_failed",
    );
  });

  it("otomatik duraklatılan kampanya neden giderilmeden devam ettirilemez", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await start(id);
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: fake() });
    expect((await campaignRow(id)).pauseReason).toBe("auto:consent_missing");
    await expectError(
      transitionCampaign(db, id, "resume", { now: T0, env: ON }),
      "preflight_failed",
    );
    await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test" });
    await expectError(
      transitionCampaign(db, id, "resume", { now: T0, env: OFF }),
      "scheduler_disabled",
    );
    expect((await transitionCampaign(db, id, "resume", { now: T0, env: ON })).status).toBe(
      "running",
    );
    expect((await campaignRow(id)).pauseReason).toBeNull();
  });

  it("iptal: bekleyen diziler iptal edilir, gönderimdeki diziye dokunulmaz", async () => {
    const { id } = await readyCampaign({ leads: 3 });
    await start(id);
    const [a] = await sequences(id);
    await db.update(campaignLeads).set({ status: "in_flight" }).where(eq(campaignLeads.id, a!.id));
    await transitionCampaign(db, id, "cancel", { now: T0 });
    expect((await sequences(id)).map((s) => s.status)).toEqual([
      "in_flight",
      "cancelled",
      "cancelled",
    ]);
    expect((await campaignRow(id)).finishedAt).toBe(T0);
  });
});

describe("ayrılmış gönderim ile duraklatma/iptal yarışları", () => {
  /** Sağlayıcı çağrısı biz bırakana kadar sürer. */
  function gated() {
    let release!: (r: ProviderResult) => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let calls = 0;
    const provider: MailProvider = {
      id: "demo",
      send: () =>
        new Promise<ProviderResult>((resolve) => {
          calls++;
          release = resolve;
          started();
        }),
    };
    return {
      provider,
      startedP,
      release: (r: ProviderResult) => release(r),
      calls: () => calls,
    };
  }
  const accepted: ProviderResult = {
    status: "accepted",
    providerMessageId: "demo-1",
    acceptedAt: T0,
  };

  it("duraklatma kaydedildikten sonra yeni ayırma yapılmaz", async () => {
    const { id } = await readyCampaign({ leads: 3 });
    await start(id);
    await transitionCampaign(db, id, "pause", { now: T0 });
    const p = fake();
    const d = new MailDispatcher(db);
    for (let i = 0; i < 10; i++) await d.dispatchOnce({ now: () => T0 + i * 300_000, provider: p });
    expect(p.calls).toBe(0);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("duraklatmadan önce ayrılmış gönderim tamamlanır (en fazla bir ileti); sonra gönderim durur", async () => {
    const { id } = await readyCampaign({ leads: 3, steps: 2 });
    await start(id);
    const g = gated();
    const turn = new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: g.provider });
    await g.startedP; // ayırma kaydedildi, sağlayıcı çağrısı sürüyor
    expect((await transitionCampaign(db, id, "pause", { now: T0 })).changed).toBe(true);
    g.release(accepted);
    expect((await turn).send?.outcome).toBe("sent");
    const rows = await db.select().from(messages);
    expect(rows.map((m) => m.status)).toEqual(["sent"]);
    expect((await sequences(id)).map((s) => s.status)).toEqual([
      "waiting_next",
      "scheduled",
      "scheduled",
    ]);

    const p = fake();
    const d = new MailDispatcher(db);
    for (let i = 1; i < 10; i++) await d.dispatchOnce({ now: () => T0 + i * 300_000, provider: p });
    expect(p.calls).toBe(0);
    expect(g.calls()).toBe(1);
  });

  it("iptalden önce ayrılmış gönderim tamamlanır; dizi iptal olarak kapanır, takip gönderilmez", async () => {
    const { id } = await readyCampaign({ leads: 2, steps: 2 });
    await start(id);
    const g = gated();
    const turn = new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: g.provider });
    await g.startedP;
    await transitionCampaign(db, id, "cancel", { now: T0 });
    g.release(accepted);
    await turn;
    expect((await db.select().from(messages)).map((m) => m.status)).toEqual(["sent"]);
    expect((await sequences(id)).map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
    const p = fake();
    const d = new MailDispatcher(db);
    for (let i = 1; i < 20; i++) await d.dispatchOnce({ now: () => T0 + i * DAY, provider: p });
    expect(p.calls).toBe(0);
  });

  it("iptalden sonra geçici ret: dizi yeniden denemeye değil iptale geçer", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await start(id);
    const g = gated();
    const turn = new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: g.provider });
    await g.startedP;
    await transitionCampaign(db, id, "cancel", { now: T0 });
    g.release({ status: "rejected", code: "try_later", permanent: false });
    await turn;
    expect((await sequences(id))[0]).toMatchObject({ status: "cancelled", nextSendAt: null });
  });

  it("sonucu belirsiz gönderim iptalden sonra da incelemede kalır; yeniden gönderilmez", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await start(id);
    const g = gated();
    const turn = new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: g.provider });
    await g.startedP;
    await transitionCampaign(db, id, "cancel", { now: T0 });
    g.release({ status: "unknown", code: "no_response" });
    await turn;
    expect((await sequences(id))[0]!.status).toBe("in_flight");
    expect(await listSendsNeedingReview(db, { now: T0 })).toHaveLength(1);
  });

  it("başlatma ile dağıtıcı yarışında hazır kampanyadan gönderim olmaz; başlatmadan sonra tek tek gönderilir", async () => {
    const { id } = await readyCampaign({ leads: 2 });
    const p = fake();
    const d = new MailDispatcher(db);
    await d.dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    await start(id);
    await d.dispatchOnce({ now: () => T0, provider: p });
    await d.dispatchOnce({ now: () => T0 + 1000, provider: p });
    expect(p.calls).toBe(1);
  });
});

describe("demo verisi temizliği (yalnızca demo, paylaşımlı kayıtta hiç silme yok)", () => {
  async function liveCampaignWith(leadId: number) {
    const [live] = await db
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label: "Gerçek",
        address: "sales@firma-iletisim.com",
        credentialsRef: "mailbox.2.refreshToken",
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: mailboxes.id });
    const [c] = await db
      .insert(campaigns)
      .values({
        name: "Gerçek",
        status: "draft",
        mailboxId: live!.id,
        selection: {},
        sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: campaigns.id });
    await db.insert(campaignLeads).values({
      campaignId: c!.id,
      leadId,
      status: "pending",
      addedAt: T0,
      updatedAt: T0,
    });
    return { campaignId: c!.id, mailboxId: live!.id };
  }

  async function snapshot() {
    return JSON.stringify([
      await db.select().from(campaigns),
      await db.select().from(campaignLeads),
      await db.select().from(campaignSteps),
      await db.select().from(messages),
      await db.select().from(leads),
      await db.select().from(suppressions),
      await db.select().from(mailboxes),
    ]);
  }

  it("demo kampanyası, iletileri ve demo lead'leri silinir; gerçek kampanya ve lead'leri kalır", async () => {
    const { id } = await readyCampaign({ leads: 2 });
    await start(id);
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: fake() });
    expect(await db.select().from(messages)).toHaveLength(1);
    const realLead = await lead({ source: "import" });
    const live = await liveCampaignWith(realLead);

    const res = await purgeDemoData(db);
    expect(res.campaigns).toBe(1);
    expect(await db.select().from(messages)).toHaveLength(0);
    expect((await db.select().from(campaigns)).map((c) => c.id)).toEqual([live.campaignId]);
    expect((await db.select().from(campaignLeads)).map((c) => c.leadId)).toEqual([realLead]);
    expect((await db.select().from(leads)).map((l) => l.id)).toEqual([realLead]);
    expect(await db.select().from(mailboxes)).toHaveLength(2); // posta kutuları silinmez
    expect((await db.select().from(templates)).length).toBeGreaterThan(0);
  });

  it("demo lead gerçek kampanyadaysa hiçbir şey silinmez", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    const demoLead = await lead();
    await liveCampaignWith(demoLead);
    void id;
    const before = await snapshot();
    await expectError(purgeDemoCampaignData(db), "conflict");
    await expectError(purgeDemoData(db), "conflict");
    expect(await snapshot()).toBe(before);
  });

  it("demo kampanyada gerçek lead varsa hiçbir şey silinmez", async () => {
    const c = await createCampaign(db, { name: "Demo", mailboxId: DEMO_MAILBOX }, { now: T0 });
    await addLeadsToCampaign(db, c.id, [await lead({ source: "import" })], { now: T0 });
    const before = await snapshot();
    await expectError(purgeDemoData(db), "conflict");
    expect(await snapshot()).toBe(before);
  });

  it("suppression bir demo iletisine bağlıysa hiçbir şey silinmez (suppression korunur)", async () => {
    const { id } = await readyCampaign({ leads: 1 });
    await start(id);
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: fake() });
    const [m] = await db.select().from(messages);
    await suppressEmail(db, { email: m!.toAddress!, reason: "bounce_hard", source: "bounce" });
    await db.update(suppressions).set({ messageId: m!.id });
    const before = await snapshot();
    await expectError(purgeDemoData(db), "conflict");
    expect(await snapshot()).toBe(before);
  });

  it("demo kampanyası yoksa yalnızca mevcut davranış (kampanya sayısı 0)", async () => {
    expect(await purgeDemoCampaignData(db)).toEqual({ campaigns: 0, sequences: 0, messages: 0 });
  });
});

describe("kampanya modüllerinin güvenliği", () => {
  it("ağ, SMTP, Google verisi veya canlı sağlayıcı kodu yok", () => {
    const dir = path.resolve(__dirname, "..", "src", "lib", "campaigns");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = fs
        .readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(
        /from "node:(?:net|tls|http|https|dgram|dns|fs)"|nodemailer|googleapis|fetch\(|createTransport|\bsmtp\b|@\/lib\/places|gcache|placeCache/i,
      );
    }
  });
});
