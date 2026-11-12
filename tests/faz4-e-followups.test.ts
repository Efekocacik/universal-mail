import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateDuration, runPreflight } from "@/lib/campaigns/preflight";
import { addLeadsToCampaign } from "@/lib/campaigns/enrollment";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import { createCampaign as createCampaignSvc, setCampaignSteps } from "@/lib/campaigns/service";
import { evaluateSend, INBOUND_REVIEW_RECHECK_MS } from "@/lib/compliance/eligibility";
import type { Db } from "@/lib/db/client";
import {
  campaignLeads,
  campaignSteps,
  leadEmails,
  leads,
  messages,
  settings,
  templates,
} from "@/lib/db/schema";
import { BUILTIN_TEMPLATES } from "@/lib/mail/builtin-templates";
import { checkContent } from "@/lib/mail/content-check";
import { gmailSendBody } from "@/lib/mail/gmail/provider";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { seedBuiltinTemplates, TEMPLATE_SEED_VERSION } from "@/lib/mail/seed";
import { followupThread, sendCampaignStep } from "@/lib/mail/send-service";
import {
  createTemplate,
  listTemplates,
  stripReplyPrefixes,
  threadReplySubject,
} from "@/lib/mail/template-service";
import { getSetting } from "@/lib/settings";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * Faz 4 / E — takip iyileştirmeleri: 9a incelemede bekleyen yanıt varken takip bekler, 9b TR/EN takip şablonları
 * (seed v2), 9c başlatma özetinde bütün adımlar ve süre tahmini, 9d takibin aynı konuşmada gitmesi. Veritabanı
 * BELLEKTE; yalnızca demo sağlayıcı (`.invalid`), ağ yok.
 */

const DAY = 86_400_000;
const ON = { FAZ3_DEMO_SCHEDULER_ENABLED: "1" };
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});

afterEach(() => {
  client.close();
});

async function builtinFollowup(language: "en" | "tr", n: 1 | 2) {
  const prefix = language === "en" ? `Follow-up ${n}` : `Takip ${n}`;
  const rows = await db
    .select()
    .from(templates)
    .where(and(eq(templates.language, language), eq(templates.kind, "followup")));
  return rows.find((r) => r.name.startsWith(prefix))!;
}

/** İki adımlı kampanya; ilk adım gönderilmiş, dizi ikinci adımı bekliyor. */
async function afterFirstStep(o: { followupTemplateId?: number } = {}) {
  const campaignId = await createCampaign(db, { steps: 2 });
  const tpl = o.followupTemplateId ?? (await builtinFollowup("en", 1)).id;
  await db
    .update(campaignSteps)
    .set({ templateId: tpl })
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepIndex, 1)));
  const s = await addSequence(db, campaignId);
  const p = new FakeMailProvider({ now: () => T0 });
  const r = await sendCampaignStep(
    db,
    { campaignLeadId: s.cl, stepIndex: 0 },
    { provider: p, now: () => T0 },
  );
  expect(r.outcome).toBe("sent");
  const [row] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, s.cl));
  expect(row).toMatchObject({ status: "waiting_next", nextStep: 1 });
  return { campaignId, ...s, row: row!, p };
}

async function inbound(
  cl: {
    campaignId: number;
    leadId: number;
    recipientHash: string | null;
    recipientDomain: string | null;
  },
  o: { status?: "received" | "ignored"; at?: number; peerHash?: string; inReplyTo?: string } = {},
) {
  const at = o.at ?? T0 + DAY;
  await db.insert(messages).values({
    direction: "in",
    purpose: "inbound",
    mailboxId: DEMO_MAILBOX,
    peerHash: o.peerHash ?? cl.recipientHash!,
    peerDomain: cl.recipientDomain!,
    inReplyTo: o.inReplyTo ?? null,
    status: o.status ?? "received",
    createdAt: at,
    receivedAt: at,
  });
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

/* ------------------------------------------------------------------------------------------------ */

describe("9a: incelemede bekleyen yanıt varken takip bekler", () => {
  it("alıcıdan gelen ve incelemede bekleyen ileti takibi durdurur; 6 saat sonra yeniden bakılır", async () => {
    const { cl, row } = await afterFirstStep();
    const now = T0 + 7 * DAY;
    expect((await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now })).eligible).toBe(
      true,
    );
    await inbound(row);
    const r = await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now });
    expect(codes(r)).toEqual(["inbound_review_pending"]);
    expect(r.reasons[0]).toMatchObject({ until: now + INBOUND_REVIEW_RECHECK_MS });
  });

  it("dağıtıcı diziyi sonlandırmaz, 6 saat erteler ve nedeni kaydeder", async () => {
    const { cl, row, p } = await afterFirstStep();
    await db
      .update(campaignLeads)
      .set({ nextSendAt: T0 + 5 * DAY })
      .where(eq(campaignLeads.id, cl));
    await inbound(row);
    const now = T0 + 7 * DAY;
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => now, provider: p });
    expect(r.send).toBeNull();
    expect(r.deferred).toBe(1);
    const [after] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, cl));
    expect(after).toMatchObject({
      status: "waiting_next",
      nextStep: 1,
      lastError: "inbound_review_pending",
      nextSendAt: now + INBOUND_REVIEW_RECHECK_MS,
    });
    expect(p.calls).toBe(1);
  });

  it("karar verilince (yok say) engel kalkar", async () => {
    const { cl, row } = await afterFirstStep();
    await inbound(row, { status: "ignored" });
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 7 * DAY }))
        .eligible,
    ).toBe(true);
  });

  it("farklı adresten gelen ama iletimize yanıt olan ileti de sayılır", async () => {
    const { cl, row } = await afterFirstStep();
    const [own] = await db
      .select({ rfc: messages.rfcMessageId })
      .from(messages)
      .where(and(eq(messages.campaignLeadId, cl), eq(messages.direction, "out")));
    await inbound(row, { peerHash: "f".repeat(64), inReplyTo: own!.rfc! });
    expect(
      codes(await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 7 * DAY })),
    ).toEqual(["inbound_review_pending"]);
  });

  it("ilk e-postadan ÖNCE gelen ileti ve ilk adım etkilenmez", async () => {
    const { cl, row } = await afterFirstStep();
    await inbound(row, { at: T0 - DAY });
    expect(
      (await evaluateSend(db, { campaignLeadId: cl, stepIndex: 1 }, { now: T0 + 7 * DAY }))
        .eligible,
    ).toBe(true);
    const other = await addSequence(db, row.campaignId);
    const [o] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, other.cl));
    await inbound(o!, { at: T0 + DAY });
    expect(
      codes(
        await evaluateSend(db, { campaignLeadId: other.cl, stepIndex: 0 }, { now: T0 + 2 * DAY }),
      ),
    ).not.toContain("inbound_review_pending");
  });
});

describe("9b: TR/EN takip şablonları (seed v2)", () => {
  it("temiz kurulum: 2 ilk + 4 takip; ikinci çalıştırma eklemez", async () => {
    expect(TEMPLATE_SEED_VERSION).toBe(2);
    const all = await db.select().from(templates).where(eq(templates.builtIn, true));
    expect(all).toHaveLength(BUILTIN_TEMPLATES.length);
    expect(all.filter((t) => t.kind === "followup")).toHaveLength(4);
    expect(await seedBuiltinTemplates(db, T0 + 1)).toBe(0);
  });

  it("v1 veritabanı: yalnızca eksik takip şablonları eklenir; düzenlenmiş şablonlara dokunulmaz", async () => {
    await db.delete(templates).where(eq(templates.kind, "followup"));
    await db.update(templates).set({ subject: "Kendi konum" }).where(eq(templates.builtIn, true));
    await db
      .update(settings)
      .set({ value: { templates: 1, demoMailbox: 1 } })
      .where(eq(settings.key, "seed.faz3"));
    expect((await getSetting(db, "seed.faz3")).templates).toBe(1);
    expect(await seedBuiltinTemplates(db, T0 + 1)).toBe(4);
    expect(await seedBuiltinTemplates(db, T0 + 2)).toBe(0);
    const initial = await db.select().from(templates).where(eq(templates.kind, "initial"));
    expect(initial.every((t) => t.subject === "Kendi konum")).toBe(true);
    expect((await getSetting(db, "seed.faz3")).templates).toBe(2);
  });

  it("takip şablonları içerik denetiminden geçer ve konuları 'Re:' ile başlamaz", () => {
    for (const t of BUILTIN_TEMPLATES.filter((x) => x.kind === "followup")) {
      expect(t.since).toBe(2);
      expect(checkContent({ subject: t.subject, body: t.bodyText }).errors).toEqual([]);
      expect(stripReplyPrefixes(t.subject)).toBe(t.subject.trim());
    }
  });
});

describe("9d: takip aynı konuşmada gider", () => {
  it("konu öneki temizlenir; yanıt konusu 200 karakterle sınırlıdır", () => {
    expect(stripReplyPrefixes("Re: RE: Ynt: Merhaba")).toBe("Merhaba");
    expect(stripReplyPrefixes("AW[2]: Hallo")).toBe("Hallo");
    expect(threadReplySubject("Re: Teklif")).toBe("Re: Teklif");
    expect(threadReplySubject("x".repeat(300))).toHaveLength(200);
  });

  it("followupThread: önceki Message-ID'ler, son konuşma kimliği ve ilk konu", () => {
    const prev = [
      { rfc: "<a@x>", stepIndex: 0, threadId: "t1", subject: " İlk konu " },
      { rfc: "<b@x>", stepIndex: 1, threadId: null, subject: "Re: İlk konu" },
      { rfc: null, stepIndex: 1, threadId: "zz", subject: null },
    ];
    expect(followupThread(prev, 0)).toEqual({ references: [], threadId: null, subject: null });
    expect(followupThread(prev, 2)).toEqual({
      references: ["<a@x>", "<b@x>"],
      threadId: "t1",
      subject: "İlk konu",
    });
    expect(followupThread(prev.slice(1), 2).subject).toBeNull();
  });

  it("Gmail gövdesi: geçerli threadId eklenir, geçersizi atılır", () => {
    const raw = "Subject: x\r\n\r\nhi";
    expect(gmailSendBody({ raw })).toEqual({
      raw: Buffer.from(raw, "latin1").toString("base64url"),
    });
    expect(gmailSendBody({ raw, threadId: "18c2f0a1b2c3d4e5" }).threadId).toBe("18c2f0a1b2c3d4e5");
    expect(gmailSendBody({ raw, threadId: "../../x" })).not.toHaveProperty("threadId");
  });

  it("takip iletisi ilk konunun 'Re:' biçimiyle ve References/In-Reply-To ile gider", async () => {
    const { cl, p } = await afterFirstStep();
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { provider: p, now: () => T0 + 7 * DAY },
    );
    expect(r.outcome).toBe("sent");
    const out = await db
      .select()
      .from(messages)
      .where(and(eq(messages.campaignLeadId, cl), eq(messages.direction, "out")))
      .orderBy(messages.id);
    expect(out).toHaveLength(2);
    expect(out[1]!.subjectLogged).toBe(`Re: ${out[0]!.subjectLogged}`);
    const raw = p.outbox[1]!.raw;
    expect(raw).toContain(`In-Reply-To: ${out[0]!.rfcMessageId}`);
    expect(raw).toMatch(/References: /);
  });

  it("ayar kapalıysa takip kendi konusuyla gider", async () => {
    // Hazır şablonlar düzenlenemez: kullanıcı kendi takip şablonunda ayarı kapatır.
    const own = await createTemplate(
      db,
      {
        name: "Kendi takibim",
        language: "en",
        kind: "followup",
        subject: "Quick note on our offer",
        bodyHtml: "<p>Hello again from our team.</p>",
        followupReuseSubject: false,
      },
      T0,
    );
    const [row] = await db.select().from(templates).where(eq(templates.id, own.id));
    expect(row!.followupReuseSubject).toBe(false);
    expect((await listTemplates(db)).find((t) => t.id === own.id)).toMatchObject({
      followupReuseSubject: false,
    });
    const { cl, p } = await afterFirstStep({ followupTemplateId: own.id });
    await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { provider: p, now: () => T0 + 7 * DAY },
    );
    const [, second] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.campaignLeadId, cl), eq(messages.direction, "out")))
      .orderBy(messages.id);
    expect(second!.subjectLogged).toBe("Quick note on our offer");
  });
});

describe("9c: başlatma özeti bütün adımları ve süre tahminini içerir", () => {
  it("estimateDuration: ilk e-postalar, takip aralıkları ve toplam hacim", () => {
    expect(
      estimateDuration({
        eligible: 45,
        perDay: 20,
        followupDelays: [3, 7],
        minFollowupGapDays: 5,
        earliestSendAt: T0,
      }),
    ).toEqual({
      perDay: 20,
      days: 3,
      earliestSendAt: T0,
      stepCount: 3,
      totalMessages: 135,
      lastFollowupAfterDays: 12,
      totalDays: 15,
    });
    // Hacim baskın: 200 alıcı × 2 adım / 10 günde = 40 gün.
    expect(
      estimateDuration({
        eligible: 200,
        perDay: 10,
        followupDelays: [5],
        minFollowupGapDays: 5,
        earliestSendAt: null,
      }).totalDays,
    ).toBe(40);
    expect(
      estimateDuration({
        eligible: 0,
        perDay: 0,
        followupDelays: [],
        minFollowupGapDays: 5,
        earliestSendAt: null,
      }),
    ).toMatchObject({ days: 0, totalDays: 0, stepCount: 1, totalMessages: 0 });
  });

  it("önizleme her adımı içerir; takip konusu ilk konunun yanıt biçimidir", async () => {
    const [initial] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.language, "en"), eq(templates.kind, "initial")));
    const f1 = await builtinFollowup("en", 1);
    const f2 = await builtinFollowup("en", 2);
    const c = await createCampaignSvc(
      db,
      { name: "Önizleme", mailboxId: DEMO_MAILBOX },
      { now: T0 },
    );
    await setCampaignSteps(
      db,
      c.id,
      [
        { stepIndex: 0, language: "en", templateId: initial!.id, delayDays: 0 },
        { stepIndex: 1, language: "en", templateId: f1.id, delayDays: 5 },
        { stepIndex: 2, language: "en", templateId: f2.id, delayDays: 7 },
      ],
      { expectedUpdatedAt: c.updatedAt, now: T0 },
    );
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
      email: "info@onizleme.example",
      domain: "onizleme.example",
      kind: "generic",
      sourceType: "mailto",
      verifyStatus: "verified",
      isPrimary: true,
      foundAt: T0,
      updatedAt: T0,
    });
    await addLeadsToCampaign(db, c.id, [l!.id], { now: T0 });
    await transitionCampaign(db, c.id, "ready", { now: T0, env: ON });
    const pf = await runPreflight(db, c.id, { now: T0, env: ON });
    const preview = pf.previews[0]!;
    expect(preview.steps!.map((s) => [s.stepIndex, s.delayDays])).toEqual([
      [0, 0],
      [1, 5],
      [2, 7],
    ]);
    expect(preview.steps![1]!.subject).toBe(threadReplySubject(preview.steps![0]!.subject));
    expect(preview.steps![2]!.errors).toEqual([]);
    expect(pf.estimate).toMatchObject({ stepCount: 3, lastFollowupAfterDays: 12 });
  });
});
