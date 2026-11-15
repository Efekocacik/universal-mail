import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as introRoute from "@/app/api/leads/[id]/intro/[introId]/route";
import * as importsRoute from "@/app/api/imports/route";
import * as leadsRoute from "@/app/api/leads/route";
import * as companiesRoute from "@/app/api/registry/companies/route";
import * as runsRoute from "@/app/api/registry/runs/route";
import { generateLeadIntro } from "@/lib/ai/service";
import { hashEmail } from "@/lib/compliance/suppression";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import {
  campaignLeads,
  campaignSteps,
  campaignStepTemplates,
  campaigns,
  leadEmails,
  leads,
  messages,
  templates,
} from "@/lib/db/schema";
import { createEmailDeps } from "@/lib/email/deps";
import { findEmailsForLeads } from "@/lib/email/service";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { previewTemplateDraft } from "@/lib/mail/template-service";
import { promoteToLead } from "@/lib/registry/service";
import { setSetting } from "@/lib/settings";
import { completeSetup, drainRegistryJobs, ORIGIN, req } from "./fixtures/registry/helpers";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * KABUL (Faz 5, paketler arası dikişler): içe aktarılan (I) ve sicilden eklenen (R) lead'ler Keşif listesinde görünür;
 * içe aktarmanın kendi web sitesi üzerinden e-posta bulunur (I + A, harici servis açıkken de); kişisel giriş yalnızca onaydan sonra
 * `{{kisisel_giris}}` olarak işlenir (A); dil şablonlu kafe varyantı ve A/B konusuyla demo gönderim yapılır (T).
 * Sicil eşleşme oranı kabulü `tests/registry-acceptance.test.ts`'tedir. Tümü demo kipinde: ağ yok, anahtar yok, adlar
 * ve alan adları YAPAYDIR.
 */

/** Pazartesi 2 Kasım 2026, 10:00 UTC (Londra mesai saati). */
const NOW = Date.UTC(2026, 10, 2, 10, 0, 0);
let t: TestDb;
let db: Db;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
  await completeSetup(db, "mock");
});
afterEach(async () => {
  vi.useRealTimers();
  await t.cleanup();
});

type Json = Record<string, any>;
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Json });

const CSV =
  "Name,Country,City,Website\n" +
  "Kafe Ada,GB,Leeds,https://kafe-ada.example\n" +
  "Kafe Bora,GB,Leeds,kafe-bora.example\n";

async function importCsv(): Promise<number[]> {
  const fd = new FormData();
  fd.set("file", new Blob([CSV]), "fuar.csv");
  fd.set(
    "meta",
    JSON.stringify({
      mapping: {
        name: 0,
        country: 1,
        city: 2,
        website: 3,
        email: null,
        category: null,
        notes: null,
      },
      defaultCountry: "GB",
      categoryKey: "cafe",
      sourceNote: "Fuar katılımcı listesi",
      usageAck: true,
    }),
  );
  const res = await read(
    await importsRoute.POST(
      new Request(`${ORIGIN}/api/imports`, {
        method: "POST",
        headers: { Origin: ORIGIN, Host: "127.0.0.1:3000" },
        body: fd,
      }),
      undefined,
    ),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const rows = await db.select({ id: leads.id }).from(leads).where(eq(leads.source, "import"));
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

async function listLeads(query: string) {
  return (await read(await leadsRoute.GET(new Request(`${ORIGIN}/api/leads?${query}`), undefined)))
    .body;
}

describe("Faz 5 kabul: içe aktarma + sicil → Keşif → e-posta → onaylı giriş → varyantlı kampanya", () => {
  it("tüm dikişler demo kipinde uçtan uca çalışır", async () => {
    // 1) İçe aktarma (I): kendi web siteleriyle iki kafe
    const imported = await importCsv();
    expect(imported).toHaveLength(2);
    const importList = await listLeads("source=import&hasWebsite=true");
    expect(importList.total).toBe(2);

    // 2) Sicil (R): demo Companies House çalışması → eşleşmeyen kayıt lead olur, Keşif'te görünür
    const run = await read(
      await runsRoute.POST(
        req("POST", "/api/registry/runs", { source: "companies_house", locality: "London" }),
        undefined,
      ),
    );
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(await drainRegistryJobs(db)).toEqual(["registry.fetch", "registry.match"]);
    const unmatched = (
      await read(
        await companiesRoute.GET(
          new Request(`${ORIGIN}/api/registry/companies?match=unmatched,pending&limit=5`),
          undefined,
        ),
      )
    ).body.items as { id: number; leadId: number | null }[];
    expect(unmatched.length).toBeGreaterThan(0);
    const { leadId: registryLead } = await promoteToLead(db, unmatched[0]!.id);
    const regList = await listLeads("source=registry");
    expect(regList.total).toBe(1);
    expect(regList.rows[0].leadId).toBe(registryLead);

    // 3) E-posta (I + A): içe aktarmanın KENDİ web sitesi taranır (Google önbelleği gerekmez); harici servis (demo
    //    Snov) yalnızca yerelde bulunamazsa devreye girer. Her iki lead de kendi alan adında adres alır.
    await setSetting(db, "enrichment.external", { enabled: true, provider: "snov" });
    const deps = await createEmailDeps(db, { useExternal: true });
    const found = await findEmailsForLeads(deps, imported, {
      scheduleRetry: async () => undefined,
    });
    expect(found.needsGoogle).toBe(0);
    const domains = ["kafe-ada.example", "kafe-bora.example"];
    for (const [i, leadId] of imported.entries()) {
      const rows = await db.select().from(leadEmails).where(eq(leadEmails.leadId, leadId));
      expect(rows.map((e) => e.domain)).toContain(domains[i]);
    }
    const emails = await db.select().from(leadEmails).where(eq(leadEmails.leadId, imported[0]!));

    // 4) Kişisel giriş (A): taslak varken ön izleme "onay bekliyor"; onaydan sonra metin işlenir
    await setSetting(db, "ai.intro", {
      enabled: true,
      model: "claude-opus-5-5",
      costAckAt: NOW,
      costAckModel: "claude-opus-5-5",
    });
    const leadA = imported[0]!;
    const draft = await generateLeadIntro(db, leadA, "en");
    expect(draft.status).toBe("draft");
    const body = "<p>Hello,</p><p>{{kisisel_giris}}</p><p>We supply cups.</p>";
    const tplDraft = {
      name: "P",
      language: "en",
      kind: "initial" as const,
      subject: "Hi",
      bodyHtml: body,
    };
    const pending = await previewTemplateDraft(db, tplDraft, leadA);
    expect(pending.ok && pending.composed.introPending).toBe(true);
    expect(pending.ok && pending.composed.html).toContain("[onay bekliyor: kisisel_giris]");
    const approved = await read(
      await introRoute.PATCH(
        req("PATCH", `/api/leads/${leadA}/intro/${draft.id}`, { action: "approve" }),
        { params: Promise.resolve({ id: String(leadA), introId: String(draft.id) }) },
      ),
    );
    expect(approved.status).toBe(200);
    const shown = await previewTemplateDraft(db, tplDraft, leadA);
    expect(shown.ok && shown.composed.introPending).toBe(false);
    expect(shown.ok && shown.composed.html).toContain(draft.text);

    // 5) Kampanya (T): genel EN adımı + kafe varyantı (B konulu, giriş değişkenli); demo gönderim
    const [general] = await db
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.language, "en"), eq(templates.kind, "initial")))
      .limit(1);
    const [cafeTpl] = await db
      .insert(templates)
      .values({
        name: "Cafe intro",
        language: "en",
        kind: "initial",
        categoryKey: "cafe",
        subject: "Cups for your cafe",
        subjectB: "A quick hello from a cup supplier",
        bodyHtml: body,
        bodyText: "Hello,\n\n{{kisisel_giris}}\n\nWe supply cups.",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: templates.id });
    const [c] = await db
      .insert(campaigns)
      .values({
        name: "Faz 5 kabul",
        status: "running",
        mailboxId: 1,
        selection: {},
        sendWindow: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
        dailyCap: 20,
        startConfirmedAt: NOW,
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: campaigns.id });
    await db.insert(campaignSteps).values({
      campaignId: c!.id,
      stepIndex: 0,
      language: "en",
      templateId: general!.id,
      delayDays: 0,
    });
    await db.insert(campaignStepTemplates).values({
      campaignId: c!.id,
      stepIndex: 0,
      language: "en",
      categoryKey: "cafe",
      templateId: cafeTpl!.id,
    });
    const email = emails.find((e) => e.domain === "kafe-ada.example")!;
    await db
      .update(leadEmails)
      .set({ verifyStatus: "verified" })
      .where(eq(leadEmails.id, email.id));
    const [cl] = await db
      .insert(campaignLeads)
      .values({
        campaignId: c!.id,
        leadId: leadA,
        emailId: email.id,
        recipientEmail: email.email,
        recipientHash: hashEmail(email.email),
        recipientDomain: email.domain,
        countryCode: "GB",
        language: "en",
        status: "scheduled",
        nextSendAt: NOW,
        addedAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: campaignLeads.id });

    const provider = new FakeMailProvider({ now: () => NOW });
    // Güvenlik kuralı: demo posta kutusu yalnızca demo işletmelere gönderir; içe aktarılan gerçek liste demo
    // kampanyada kullanılamaz (canlı posta kutusu gerekir).
    const blocked = await sendCampaignStep(
      db,
      { campaignLeadId: cl!.id, stepIndex: 0 },
      { provider, now: () => NOW },
    );
    expect(blocked).toMatchObject({ outcome: "ineligible", reasons: [{ code: "lead_not_demo" }] });
    expect(provider.outbox).toHaveLength(0);
    // Aynı veriler demo işletmesi olsaydı: kafe varyantı + A/B konusu + onaylı giriş iletide.
    await db.update(leads).set({ source: "demo" }).where(eq(leads.id, leadA));
    const sent = await sendCampaignStep(
      db,
      { campaignLeadId: cl!.id, stepIndex: 0 },
      { provider, now: () => NOW },
    );
    expect(sent.outcome, JSON.stringify(sent)).toBe("sent");
    const [msg] = await db.select().from(messages).where(eq(messages.campaignLeadId, cl!.id));
    expect(msg!.templateId).toBe(cafeTpl!.id);
    expect(msg!.subjectVariant).toBe(cl!.id % 2 === 0 ? "a" : "b");
    // Düz metin bölümü quoted-printable: yumuşak satır sonları ve =XX kaçışları çözülür.
    const plain = provider.outbox[0]!.raw.replace(/=\r?\n/g, "").replace(
      /(?:=[0-9A-F]{2})+/g,
      (m) => Buffer.from(m.replaceAll("=", ""), "hex").toString("utf8"),
    );
    expect(plain).toContain(draft.text);
  });
});
