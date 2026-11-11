import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as resolveRoute from "@/app/api/campaigns/review/[messageId]/route";
import * as reviewRoute from "@/app/api/campaigns/review/route";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaignLeads, campaigns, leads, mailboxes, messages } from "@/lib/db/schema";
import { FakeMailProvider, type FakeStep } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  REVIEW_RESOLVED_ACTION,
  ResolveReviewError,
  resolveUncertainSend,
  type UncertainSendDecision,
} from "@/lib/mail/scheduler/resolve-review";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import { sendCampaignStep, STALE_SENDING_MS } from "@/lib/mail/send-service";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * C7: sonucu belirsiz gönderimin kullanıcı kararıyla çözülmesi. Veritabanı BELLEKTE; ağ yok, gerçek gönderim yok.
 * Karar hiçbir şey göndermez: sağlayıcı yalnızca dağıtıcı/gönderim servisi üzerinden, olağan kapılarla çağrılır.
 */

const HANDLE = "__umDbHandle";
const ORIGIN = "http://127.0.0.1:3000";
const MIN = 60_000;
const DAY = 86_400_000;
let client: Client;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
});

afterEach(() => {
  client.close();
});

function fake(script: FakeStep[] = []) {
  return new FakeMailProvider({ script, now: () => T0 });
}

async function seq(id: number) {
  const [r] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, id));
  return r!;
}

async function msg(id: number) {
  const [r] = await db.select().from(messages).where(eq(messages.id, id));
  return r!;
}

async function audits() {
  return db.select().from(auditLog).where(eq(auditLog.action, REVIEW_RESOLVED_ACTION));
}

/** Belirsiz sonuçlanmış bir adım: ileti `unknown`, dizi `in_flight`. */
async function uncertain(o: { steps?: number; step?: FakeStep } = {}) {
  const campaignId = await createCampaign(db, { steps: o.steps ?? 3 });
  const s = await addSequence(db, campaignId);
  const p = fake([o.step ?? { kind: "unknown-after" }]);
  const r = await sendCampaignStep(
    db,
    { campaignLeadId: s.cl, stepIndex: 0 },
    { provider: p, now: () => T0 },
  );
  expect(r.outcome).toBe("unknown");
  const messageId = (r as { messageRowId: number }).messageRowId;
  return { campaignId, ...s, messageId, p };
}

async function expectError(p: Promise<unknown>, kind: ResolveReviewError["kind"]) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ResolveReviewError);
  expect((e as ResolveReviewError).kind).toBe(kind);
}

/* ------------------------------------------------------------------------------------------------ */

describe("mark_sent: kabul edilen gönderimle aynı ilerleme", () => {
  it("ileti sent olur; dizi sonraki adıma geçer; lead ve ısınma güncellenir; denetim kaydı kişisel veri içermez", async () => {
    const { cl, leadId, email, messageId, p } = await uncertain();
    const now = T0 + 2 * DAY;
    const r = await resolveUncertainSend(db, messageId, "mark_sent", { note: email, now });
    expect(r).toEqual({
      messageId,
      decision: "mark_sent",
      messageStatus: "sent",
      sequenceStatus: "waiting_next",
      alreadyResolved: false,
    });
    expect(await msg(messageId)).toMatchObject({ status: "sent", sentAt: T0, errorCode: null });
    expect(await seq(cl)).toMatchObject({
      status: "waiting_next",
      nextStep: 1,
      lastSentAt: T0,
      // Takip aralığı GERÇEK gönderim anından sayılır (karar anından değil).
      nextSendAt: T0 + 5 * DAY,
      attempts: 0,
      lastError: null,
      updatedAt: now,
    });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead).toMatchObject({ status: "sent", lastContactedAt: T0 });
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, DEMO_MAILBOX));
    expect(mb!.warmupStartedAt).toBe(T0);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: "message", entityId: String(messageId), at: now });
    expect(rows[0]!.detail).toMatchObject({
      decision: "mark_sent",
      campaignLeadId: cl,
      stepIndex: 0,
      previousErrorCode: "no_response",
      sequenceStatus: "waiting_next",
      noteLength: email.length,
    });
    // Alıcı adresi ve not metni yazılmaz.
    expect(JSON.stringify(rows)).not.toContain(email);
    expect(JSON.stringify(rows)).not.toContain("@");
    // Karar hiçbir şey göndermez.
    expect(p.calls).toBe(1);
  });

  it("aynı karar tekrarlanırsa hiçbir şey değişmez; farklı karar reddedilir", async () => {
    const { cl, messageId } = await uncertain();
    await resolveUncertainSend(db, messageId, "mark_sent", { now: T0 + DAY });
    const before = await seq(cl);
    const again = await resolveUncertainSend(db, messageId, "mark_sent", { now: T0 + 3 * DAY });
    expect(again).toMatchObject({
      alreadyResolved: true,
      messageStatus: "sent",
      sequenceStatus: "waiting_next",
    });
    expect(await seq(cl)).toEqual(before);
    expect(await audits()).toHaveLength(1);
    await expectError(
      resolveUncertainSend(db, messageId, "mark_not_sent", { confirm: true, now: T0 + 3 * DAY }),
      "already_resolved",
    );
    await expectError(
      resolveUncertainSend(db, messageId, "stop_sequence", { now: T0 + 3 * DAY }),
      "already_resolved",
    );
    expect(await seq(cl)).toEqual(before);
  });

  it("son adımda dizi tamamlanır ve kampanya biter", async () => {
    const { campaignId, cl, messageId } = await uncertain({ steps: 1 });
    const d = new MailDispatcher(db);
    // Karar verilmeden kampanya bitmez (dizi `in_flight`).
    expect(
      (await d.dispatchOnce({ now: () => T0 + MIN, provider: fake() })).completedCampaigns,
    ).toEqual([]);
    await resolveUncertainSend(db, messageId, "mark_sent", { now: T0 + 2 * MIN });
    expect(await seq(cl)).toMatchObject({ status: "completed", nextStep: 1, nextSendAt: null });
    const r = await d.dispatchOnce({ now: () => T0 + 3 * MIN, provider: fake() });
    expect(r.completedCampaigns).toEqual([campaignId]);
    expect(r.send).toBeNull();
  });
});

describe("mark_not_sent: açık onayla adım yeniden UYGUN olur (otomatik gönderim yok)", () => {
  it("onaysız reddedilir ve hiçbir şey değişmez", async () => {
    const { cl, messageId } = await uncertain();
    await expectError(resolveUncertainSend(db, messageId, "mark_not_sent"), "unconfirmed");
    await expectError(
      resolveUncertainSend(db, messageId, "mark_not_sent", { confirm: false }),
      "unconfirmed",
    );
    expect((await msg(messageId)).status).toBe("unknown");
    expect((await seq(cl)).status).toBe("in_flight");
    expect(await audits()).toHaveLength(0);
  });

  it("ileti failed (resolved_not_sent); dizi scheduled; tekillik ve alan adı/gün hakkı serbest kalır; adım olağan akışla gönderilir", async () => {
    const { campaignId, cl, messageId, p } = await uncertain({
      steps: 1,
      step: { kind: "unknown-before" },
    });
    const now = T0 + 30 * MIN;
    const r = await resolveUncertainSend(db, messageId, "mark_not_sent", { confirm: true, now });
    expect(r).toMatchObject({
      messageStatus: "failed",
      sequenceStatus: "scheduled",
      alreadyResolved: false,
    });
    expect(await msg(messageId)).toMatchObject({
      status: "failed",
      errorCode: "resolved_not_sent",
      sentAt: null,
    });
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      nextStep: 0,
      nextSendAt: now,
      lastError: "resolved_not_sent",
    });
    // Karar kendisi göndermez.
    expect(p.calls).toBe(1);
    expect(p.outbox).toHaveLength(0);

    // İdempotent tekrar.
    expect(
      await resolveUncertainSend(db, messageId, "mark_not_sent", {
        confirm: true,
        now: now + MIN,
      }),
    ).toMatchObject({ alreadyResolved: true, messageStatus: "failed" });
    expect(await audits()).toHaveLength(1);

    // Dağıtıcı adımı bütün kapılarla yeniden ele alır: aynı gün, aynı alan adı, aynı tekillik anahtarı.
    const p2 = fake();
    const d = new MailDispatcher(db);
    const out = await d.dispatchOnce({ now: () => now + MIN, provider: p2 });
    expect(out.send?.outcome).toBe("sent");
    expect(p2.outbox).toHaveLength(1);
    const rows = await db
      .select({ status: messages.status, key: messages.idempotencyKey })
      .from(messages)
      .orderBy(messages.id);
    expect(rows).toEqual([
      { status: "failed", key: `cl:${cl}:s:0` },
      { status: "sent", key: `cl:${cl}:s:0` },
    ]);
    expect(await seq(cl)).toMatchObject({ status: "completed" });
    // Aynı turda kampanya da tamamlanır.
    expect(out.completedCampaigns).toEqual([campaignId]);
  });

  it("takip adımında dizi waiting_next'e döner", async () => {
    const campaignId = await createCampaign(db, { steps: 2 });
    const { cl } = await addSequence(db, campaignId);
    await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: fake(), now: () => T0 },
    );
    const t1 = T0 + 7 * DAY; // pazartesi
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 1 },
      { provider: fake([{ kind: "unknown-before" }]), now: () => t1 },
    );
    expect(r.outcome).toBe("unknown");
    const id = (r as { messageRowId: number }).messageRowId;
    await resolveUncertainSend(db, id, "mark_not_sent", { confirm: true, now: t1 + MIN });
    expect(await seq(cl)).toMatchObject({
      status: "waiting_next",
      nextStep: 1,
      nextSendAt: t1 + MIN,
    });
  });

  it("iptal edilmiş kampanyada dizi yeniden açılmaz, cancelled olur", async () => {
    const { campaignId, cl, messageId } = await uncertain();
    await db.update(campaigns).set({ status: "cancelled" }).where(eq(campaigns.id, campaignId));
    const r = await resolveUncertainSend(db, messageId, "mark_not_sent", {
      confirm: true,
      now: T0 + MIN,
    });
    expect(r.sequenceStatus).toBe("cancelled");
    expect(await seq(cl)).toMatchObject({ status: "cancelled", nextSendAt: null });
  });
});

describe("stop_sequence: en güvenli karar", () => {
  it("dizi failed olur, ileti unknown kalır; kampanya biter; liste uçunda artık görünmez", async () => {
    const { campaignId, cl, messageId, email } = await uncertain();
    const d = new MailDispatcher(db);
    expect(
      (await d.dispatchOnce({ now: () => T0 + MIN, provider: fake() })).completedCampaigns,
    ).toEqual([]);
    const r = await resolveUncertainSend(db, messageId, "stop_sequence", { now: T0 + 2 * MIN });
    expect(r).toMatchObject({ messageStatus: "unknown", sequenceStatus: "failed" });
    expect(await msg(messageId)).toMatchObject({ status: "unknown", errorCode: "no_response" });
    expect(await seq(cl)).toMatchObject({
      status: "failed",
      nextSendAt: null,
      lastError: "review_stopped",
    });
    expect(
      (await d.dispatchOnce({ now: () => T0 + 3 * MIN, provider: fake() })).completedCampaigns,
    ).toEqual([campaignId]);

    // Ham liste kaydı hâlâ belirsiz gösterir; uç çözülmüş kaydı listelemez.
    expect(await listSendsNeedingReview(db, { now: T0 + 3 * MIN })).toHaveLength(1);
    (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
    try {
      const res = await reviewRoute.GET(new Request(`${ORIGIN}/api/campaigns/review`), undefined);
      expect(await res.json()).toEqual({ items: [] });
    } finally {
      delete (globalThis as Record<string, unknown>)[HANDLE];
    }

    // İdempotent tekrar; adres diğer kampanyalarda belirsiz teslimat nedeniyle engelli kalır.
    expect(
      await resolveUncertainSend(db, messageId, "stop_sequence", { now: T0 + 4 * MIN }),
    ).toMatchObject({ alreadyResolved: true, sequenceStatus: "failed" });
    const other = await createCampaign(db, { steps: 1 });
    const s2 = await addSequence(db, other, { email });
    const again = await sendCampaignStep(
      db,
      { campaignLeadId: s2.cl, stepIndex: 0 },
      { provider: fake(), now: () => T0 + DAY },
    );
    expect(again.outcome).toBe("ineligible");
  });
});

describe("yalnızca sonucu belirsiz gönderimler karara bağlanabilir", () => {
  it("kesin sonuçlu, gelen veya olmayan ileti reddedilir", async () => {
    const campaignId = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, campaignId);
    const ok = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: fake(), now: () => T0 },
    );
    const sentId = (ok as { messageRowId: number }).messageRowId;
    const decisions: UncertainSendDecision[] = ["mark_sent", "mark_not_sent", "stop_sequence"];
    for (const decision of decisions) {
      await expectError(
        resolveUncertainSend(db, sentId, decision, { confirm: true, now: T0 + MIN }),
        "not_uncertain",
      );
    }
    await expectError(resolveUncertainSend(db, 9999, "mark_sent", { now: T0 + MIN }), "not_found");
    const [inbound] = await db
      .insert(messages)
      .values({
        direction: "in",
        purpose: "inbound",
        mailboxId: DEMO_MAILBOX,
        peerHash: hashEmail("x@peer.example"),
        peerDomain: "peer.example",
        status: "received",
        createdAt: T0,
        receivedAt: T0,
      })
      .returning({ id: messages.id });
    await expectError(
      resolveUncertainSend(db, inbound!.id, "mark_sent", { now: T0 + MIN }),
      "not_found",
    );
    await expectError(
      resolveUncertainSend(db, sentId, "resend" as never, { now: T0 + MIN }),
      "invalid_input",
    );
    expect((await seq(cl)).status).toBe("completed");
    expect(await audits()).toHaveLength(0);
  });

  it("süren (eski olmayan) sending reddedilir; eski sending önce uzlaştırılıp karara bağlanır", async () => {
    const campaignId = await createCampaign(db, { steps: 3 });
    const { cl } = await addSequence(db, campaignId);
    await client.execute(
      "CREATE TEMP TRIGGER fail_record BEFORE UPDATE ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'disk dolu'); END",
    );
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: fake(), now: () => T0 },
    );
    await client.execute("DROP TRIGGER fail_record");
    const id = (r as { messageRowId: number }).messageRowId;
    expect((await msg(id)).status).toBe("sending");

    await expectError(
      resolveUncertainSend(db, id, "mark_sent", { now: T0 + STALE_SENDING_MS - 1 }),
      "in_progress",
    );
    expect((await msg(id)).status).toBe("sending");

    const res = await resolveUncertainSend(db, id, "mark_sent", {
      now: T0 + STALE_SENDING_MS + 1,
    });
    expect(res).toMatchObject({ messageStatus: "sent", sequenceStatus: "waiting_next" });
    const [row] = await audits();
    expect(row!.detail).toMatchObject({ previousErrorCode: "stale_sending" });
  });

  it("test iletisi: dizisi yoktur, durdurma reddedilir; gönderildi kararı yalnızca iletiyi değiştirir", async () => {
    const [m] = await db
      .insert(messages)
      .values({
        direction: "out",
        purpose: "test",
        mailboxId: DEMO_MAILBOX,
        toAddress: "demo@universal-mail.invalid",
        peerHash: hashEmail("demo@universal-mail.invalid"),
        peerDomain: "universal-mail.invalid",
        status: "unknown",
        errorCode: "provider_error",
        createdAt: T0,
      })
      .returning({ id: messages.id });
    await expectError(
      resolveUncertainSend(db, m!.id, "stop_sequence", { now: T0 + MIN }),
      "no_sequence",
    );
    expect(await resolveUncertainSend(db, m!.id, "mark_sent", { now: T0 + MIN })).toMatchObject({
      messageStatus: "sent",
      sequenceStatus: null,
    });
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, DEMO_MAILBOX));
    expect(mb!.warmupStartedAt).toBeNull();
  });
});

describe("POST /api/campaigns/review/{messageId}", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[HANDLE] = Promise.resolve({ client, db });
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[HANDLE];
  });

  const post = async (id: number | string, payload: unknown) => {
    const res = await resolveRoute.POST(
      new Request(`${ORIGIN}/api/campaigns/review/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ messageId: String(id) }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("doğrulama, onay, hata kodları ve başarılı karar", async () => {
    const { cl, messageId } = await uncertain();
    expect((await post("abc", { decision: "mark_sent" })).status).toBe(400);
    expect((await post(messageId, { decision: "resend" })).status).toBe(400);
    expect((await post(messageId, { decision: "mark_sent", extra: 1 })).status).toBe(400);
    expect(await post(messageId, { decision: "mark_not_sent" })).toMatchObject({
      status: 400,
      body: { code: "UNCONFIRMED" },
    });
    expect(await post(9999, { decision: "mark_sent" })).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND" },
    });

    const ok = await post(messageId, { decision: "mark_not_sent", confirm: true, note: "yok" });
    expect(ok).toMatchObject({
      status: 200,
      body: { messageId, decision: "mark_not_sent", messageStatus: "failed" },
    });
    expect((await seq(cl)).status).toBe("scheduled");
    expect(await post(messageId, { decision: "stop_sequence" })).toMatchObject({
      status: 409,
      body: { code: "ALREADY_RESOLVED" },
    });
    // Yanıt kişisel veri veya yığın izi içermez.
    expect(JSON.stringify(ok.body)).not.toMatch(/@|stack/i);
  });

  it("kullanım onayı yoksa karar uygulanmaz", async () => {
    const { messageId } = await uncertain();
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    const r = await post(messageId, { decision: "stop_sequence" });
    expect(r).toMatchObject({ status: 403, body: { code: "SETUP_REQUIRED" } });
    expect((await msg(messageId)).status).toBe("unknown");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, REVIEW_RESOLVED_ACTION)));
    expect(row).toBeUndefined();
  });
});
