import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoStopError } from "@/lib/campaigns/auto-stop";
import { hashEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { auditLog, campaigns, messages, settings, suppressions } from "@/lib/db/schema";
import { processInbound } from "@/lib/mail/inbound/process";
import {
  computeMailboxStats,
  evaluateMailbox,
  getMailboxHealth,
  getMailboxLimits,
  MailboxHealthError,
  reenableMailbox,
  tightenMailboxLimits,
  type MailboxLimits,
} from "@/lib/mail/mailbox-health";
import { SCHEDULER_FLAG } from "@/lib/mail/scheduler/job";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";
import { addMailbox, NOW, rawDsn, seedSent, SIMULATED_DSN_PASS } from "./helpers/inbound-fixture";

/**
 * Posta kutusu düzeyi sağlık (SRS 5.6.1; Aşama 14): sınır değerleri, küçük örneklem freni, pay/payda birimi, durdurma,
 * gönderim kapısı, yeniden etkinleştirme ve yalnızca sıkılaştırma. Kampanya düzeyindeki durdurma (Aşama 13) ayrıdır.
 */

let client: Client;
let db: Db;
let campaignId: number;
beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  campaignId = await createCampaign(db, { status: "running" });
});
afterEach(() => client.close());

const DEF: MailboxLimits = { bounceBp: 300, minRecipients: 50, guardBounces: 3 };
const ev = (recipients: number, bounced: number, l = DEF) =>
  evaluateMailbox({ recipients, bounced }, l);

describe("karar işlevi: 'aşarsa' = kesin büyüktür", () => {
  it("tam %3,00 durdurmaz; üzeri durdurur", () => {
    expect(ev(100, 3).state).toBe("ok"); // 3,00 %
    expect(ev(100, 4)).toMatchObject({ state: "exceeded", reason: "rate" });
    expect(ev(200, 6).state).toBe("ok"); // 3,00 %
    expect(ev(200, 7).state).toBe("exceeded");
    expect(ev(1000, 30).state).toBe("ok");
    expect(ev(1000, 31).state).toBe("exceeded");
  });

  it("yeterli örneklemde (50) oran üzerinden; 50 sınırı dahil", () => {
    expect(ev(50, 2)).toMatchObject({ state: "exceeded", reason: "rate", sufficient: true }); // %4
    expect(ev(50, 1)).toMatchObject({ state: "ok", sufficient: true }); // %2
  });

  it("küçük örneklem (<50) yalnızca 'yetersiz veri' değildir: ≥3 doğrulanmış bounce freni tetikler", () => {
    expect(ev(49, 2)).toMatchObject({ state: "insufficient", reason: null, sufficient: false });
    expect(ev(49, 3)).toMatchObject({ state: "exceeded", reason: "small_sample_guard" });
    expect(ev(10, 3)).toMatchObject({ state: "exceeded", reason: "small_sample_guard" });
    expect(ev(10, 1)).toMatchObject({ state: "insufficient" });
    expect(ev(0, 0)).toMatchObject({ state: "insufficient" });
  });

  it("SRS eşiği 50 sınırı yüzünden etkisizleşmez: aynı oran her örneklem büyüklüğünde bir önlem tetikler", () => {
    // %6 bounce: 3/50 (yeterli, oran), 3/49 (küçük örneklem freni), 6/100 (oran).
    for (const [n, b] of [
      [49, 3],
      [50, 3],
      [100, 6],
      [1000, 60],
    ] as const) {
      expect(ev(n, b).state).toBe("exceeded");
    }
  });

  it("sıkılaştırılmış eşikler daha erken durdurur", () => {
    expect(ev(20, 2, { ...DEF, minRecipients: 20 })).toMatchObject({
      state: "exceeded",
      reason: "rate",
    });
    expect(ev(30, 2, { ...DEF, guardBounces: 2 })).toMatchObject({
      state: "exceeded",
      reason: "small_sample_guard",
    });
    expect(ev(100, 3, { ...DEF, bounceBp: 200 }).state).toBe("exceeded"); // %3 > %2
  });
});

describe("pay ve payda: alıcı birimi, 30 gün, gönderim tarihine atıf", () => {
  it("takip, çok kampanya ve çok bounce iletisi alıcıyı bir kez sayar", async () => {
    const other = await createCampaign(db, { status: "running" });
    const a = await seedSent(db, campaignId);
    await seedSent(db, campaignId, { clId: a.cl, leadId: a.leadId, email: a.email, step: 1 });
    await seedSent(db, campaignId, { clId: a.cl, leadId: a.leadId, email: a.email, step: 2 });
    await seedSent(db, other, { email: a.email }).catch(() => undefined); // başka kampanyada aynı alıcı
    const b = await seedSent(db, campaignId);
    await db
      .update(messages)
      .set({ deliveryStatus: "bounced_hard" })
      .where(eq(messages.peerHash, hashEmail(a.email)));
    expect(await computeMailboxStats(db, DEMO_MAILBOX, T0 + 20 * 86_400_000)).toEqual({
      recipients: 2,
      bounced: 1,
    });
    void b;
  });

  it("test iletisi, başarısız/belirsiz ileti ve başka posta kutusu dışlanır", async () => {
    const m2 = await addMailbox(db, { provider: "demo", address: "baska@universal-mail.invalid" });
    await seedSent(db, campaignId);
    await seedSent(db, campaignId, { purpose: "test" });
    await seedSent(db, campaignId, { status: "failed" });
    await seedSent(db, campaignId, { status: "unknown" });
    await seedSent(db, campaignId, { mailboxId: m2 });
    expect(await computeMailboxStats(db, DEMO_MAILBOX, NOW)).toEqual({ recipients: 1, bounced: 0 });
    expect(await computeMailboxStats(db, m2, NOW)).toEqual({ recipients: 1, bounced: 0 });
  });

  it("30 günden eski ileti pencerede değil; bounce gönderim tarihine atfedilir (geç gelen DSN oranı düşürmez)", async () => {
    const old = await seedSent(db, campaignId, { sentAt: T0 });
    await db
      .update(messages)
      .set({ deliveryStatus: "bounced_hard" })
      .where(eq(messages.id, old.outboundId));
    const recent = await seedSent(db, campaignId, { sentAt: T0 + 40 * 86_400_000 });
    const now = T0 + 41 * 86_400_000;
    expect(await computeMailboxStats(db, DEMO_MAILBOX, now)).toEqual({ recipients: 1, bounced: 0 }); // eski dışarıda
    expect(await computeMailboxStats(db, DEMO_MAILBOX, T0 + 5 * 86_400_000)).toEqual({
      recipients: 1,
      bounced: 1,
    });
    void recent;
  });

  it("yumuşak bounce ve işaretlenmemiş iletiler paya girmez", async () => {
    const a = await seedSent(db, campaignId);
    await seedSent(db, campaignId);
    await db
      .update(messages)
      .set({ deliveryStatus: "bounced_soft" })
      .where(eq(messages.id, a.outboundId));
    expect(await computeMailboxStats(db, DEMO_MAILBOX, NOW)).toEqual({ recipients: 2, bounced: 0 });
  });
});

describe("durdurma, kapı ve yeniden etkinleştirme", () => {
  async function bounce(s: { rfc: string; email: string }, n: number, att = SIMULATED_DSN_PASS) {
    return processInbound(
      db,
      {
        mailboxId: DEMO_MAILBOX,
        raw: rawDsn({ outboundMessageId: s.rfc, recipient: s.email, nonce: `b${n}` }),
        receivedAt: NOW,
        attestation: att,
      },
      { now: NOW },
    );
  }
  const halts = async () =>
    (await db.select().from(settings).where(eq(settings.key, "mail.mailboxHalts")))[0]?.value as
      Record<string, unknown> | undefined;

  async function tenRecipients() {
    const all = [];
    for (let i = 0; i < 10; i++) all.push(await seedSent(db, campaignId));
    return all;
  }

  it("10 alıcıda 2 doğrulanmış bounce durdurmaz; 3. bounce küçük örneklem freniyle kutuyu durdurur", async () => {
    const all = await tenRecipients();
    await bounce(all[0]!, 1);
    await bounce(all[1]!, 2);
    expect(await halts()).toBeUndefined();
    const r = await bounce(all[2]!, 3);
    expect(r).toMatchObject({ effects: { campaignPaused: true } });
    expect(Object.keys((await halts()) ?? {})).toEqual([String(DEMO_MAILBOX)]);
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c).toMatchObject({ status: "paused", pauseReason: "mailbox_rate_exceeded" });
    const a = (await db.select().from(auditLog)).filter((x) => x.action === "mailbox.halted");
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toMatchObject({
      reason: "small_sample_guard",
      recipients: 10,
      bounced: 3,
      pausedCampaigns: 1,
    });
  });

  it("tasdiksiz (sahte) bounce'lar kutuyu durdurmaz", async () => {
    const all = await tenRecipients();
    for (let i = 0; i < 6; i++) await bounce(all[i]!, i, null as never);
    expect(await halts()).toBeUndefined();
    expect((await getMailboxHealth(db, DEMO_MAILBOX, NOW)).evaluation.state).toBe("insufficient");
  });

  it("durdurulmuş kutudan gönderim kapısı reddeder; durdurulmamış kutuda aynı adım gönderilir", async () => {
    const env = { [SCHEDULER_FLAG]: "1" };
    void env;
    const provider = new FakeMailProvider();
    const fresh = await addSequence(db, campaignId, { nextSendAt: null });
    const ok = await sendCampaignStep(
      db,
      { campaignLeadId: fresh.cl, stepIndex: 0 },
      { now: () => T0, provider },
    );
    expect(ok.outcome).toBe("sent"); // kontrol: kapı açıkken gönderilir

    const all = await tenRecipients();
    for (let i = 0; i < 3; i++) await bounce(all[i]!, 10 + i);
    expect(Object.keys((await halts()) ?? {})).toHaveLength(1);

    const next = await addSequence(db, campaignId, { nextSendAt: null });
    await db.update(campaigns).set({ status: "running" }).where(eq(campaigns.id, campaignId));
    const blocked = await sendCampaignStep(
      db,
      { campaignLeadId: next.cl, stepIndex: 0 },
      { now: () => T0, provider },
    );
    expect(blocked).toMatchObject({ outcome: "not_sendable", code: "mailbox_halted" });
    expect(provider.outbox).toHaveLength(1);
  });

  it("yeniden etkinleştirme: onay + gerekçe ister; oran hâlâ eşik üstündeyse reddeder; pencere kayınca izin verir", async () => {
    const all = await tenRecipients();
    for (let i = 0; i < 3; i++) await bounce(all[i]!, 20 + i);
    await expect(
      reenableMailbox(
        db,
        DEMO_MAILBOX,
        { confirm: false, justification: "yeterince uzun gerekçe" },
        NOW,
      ),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    await expect(
      reenableMailbox(db, DEMO_MAILBOX, { confirm: true, justification: "kısa" }, NOW),
    ).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(
      reenableMailbox(
        db,
        DEMO_MAILBOX,
        { confirm: true, justification: "yeterince uzun gerekçe" },
        NOW,
      ),
    ).rejects.toMatchObject({ kind: "still_exceeded" });
    expect(Object.keys((await halts()) ?? {})).toHaveLength(1);

    const later = T0 + 45 * 86_400_000; // iletiler pencereden çıktı
    await reenableMailbox(
      db,
      DEMO_MAILBOX,
      { confirm: true, justification: "pencere kaydı, inceledim" },
      later,
    );
    expect(await halts()).toEqual({});
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
    expect(c!.status).toBe("paused"); // kampanya kendiliğinden devam etmez
    const a = (await db.select().from(auditLog)).filter((x) => x.action === "mailbox.reenabled");
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.detail)).not.toContain("pencere");
    await expect(
      reenableMailbox(
        db,
        DEMO_MAILBOX,
        { confirm: true, justification: "yeterince uzun gerekçe" },
        later,
      ),
    ).rejects.toBeInstanceOf(MailboxHealthError);
  });
});

describe("şikâyet: ölçülemiyor, doğrulanmış gibi davranılmaz", () => {
  it("elle girilen şikâyetler sayılır ama orana katılmaz; durum 'ölçülemiyor'", async () => {
    for (let i = 0; i < 60; i++) await seedSent(db, campaignId);
    const before = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(before.complaint).toEqual({
      status: "not_measurable",
      thresholdBp: 10,
      manualRecords: 0,
      arf: { coverage: "partial", windowDays: 30, verifiedRecipients: 0, pendingReview: 0 },
    });
    for (let i = 0; i < 5; i++) {
      await db.insert(suppressions).values({
        scope: "email",
        emailHash: hashEmail(`sikayet${i}@x.example`),
        hashAlg: "sha256-v1",
        emailMasked: `s***@x.example`,
        domain: "x.example",
        reason: "complaint",
        source: "manual",
        addedAt: NOW,
      });
    }
    const after = await getMailboxHealth(db, DEMO_MAILBOX, NOW);
    expect(after.complaint).toMatchObject({ status: "not_measurable", manualRecords: 5 });
    expect(after.evaluation).toEqual(before.evaluation); // oran etkilenmez
    expect(after.halted).toBeNull();
  });
});

describe("yalnızca sıkılaştırma", () => {
  const t = (
    i: Partial<{ scope: string; bounceBp: number; minRecipients: number; guardBounces: number }>,
  ) => tightenMailboxLimits(db, { scope: "demo", ...i });
  const kind = async (p: Promise<unknown>) =>
    ((await p.catch((e: unknown) => e)) as AutoStopError).kind;

  it("varsayılan 3% / 50 / 3; sıkılaştırma kabul, gevşetme ve alt sınır reddi, geri gevşetme yok", async () => {
    expect(await getMailboxLimits(db)).toEqual(DEF);
    expect(await t({ bounceBp: 200, minRecipients: 30, guardBounces: 2 })).toEqual({
      bounceBp: 200,
      minRecipients: 30,
      guardBounces: 2,
    });
    expect(await kind(t({ bounceBp: 300 }))).toBe("loosening_forbidden");
    expect(await kind(t({ minRecipients: 50 }))).toBe("loosening_forbidden");
    expect(await kind(t({ guardBounces: 3 }))).toBe("loosening_forbidden");
    expect(await kind(t({ bounceBp: 99 }))).toBe("below_floor");
    expect(await kind(t({ minRecipients: 19 }))).toBe("below_floor");
    expect(await kind(t({ guardBounces: 1 }))).toBe("below_floor");
    expect(await t({ bounceBp: 200 })).toMatchObject({ bounceBp: 200 }); // eşit: sorunsuz
  });

  it("canlı kapsam, boş ve geçersiz girdi reddedilir; elle bozulmuş ayar varsayılana sıkıştırılır", async () => {
    expect(await kind(t({ scope: "live", bounceBp: 200 }))).toBe("live_locked");
    expect(await kind(t({}))).toBe("invalid_input");
    expect(await kind(t({ bounceBp: 2.5 }))).toBe("invalid_input");
    await db.insert(settings).values({
      key: "mail.mailboxLimits",
      value: { bounceBp: 9000, minRecipients: 9999, guardBounces: 99 },
      updatedAt: 1,
    });
    expect(await getMailboxLimits(db)).toEqual(DEF);
    await db
      .update(settings)
      .set({ value: { bounceBp: 1, minRecipients: 1, guardBounces: 0 } })
      .where(eq(settings.key, "mail.mailboxLimits"));
    expect(await getMailboxLimits(db)).toEqual({
      bounceBp: 100,
      minRecipients: 20,
      guardBounces: 2,
    });
  });
});
