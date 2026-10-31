import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq, inArray, min } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suppressEmail } from "@/lib/compliance/suppression";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, jobs, mailboxes, messages } from "@/lib/db/schema";
import { claimNextJob } from "@/lib/jobs/queue";
import { clearJobHandlers, NonRetryableJobError, registerJobHandler } from "@/lib/jobs/registry";
import { FakeMailProvider, type FakeStep } from "@/lib/mail/provider/fake-provider";
import type { MailProvider, ProviderResult } from "@/lib/mail/provider/provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  createMailSendHandler,
  isDemoSchedulerEnabled,
  MAIL_SEND_JOB,
  requeueStaleMailJobs,
  scheduleDispatch,
  SCHEDULER_FLAG,
  startMailScheduler,
  STALE_MAIL_JOB_LOCK_MS,
} from "@/lib/mail/scheduler/job";
import { listSendsNeedingReview } from "@/lib/mail/scheduler/review";
import { utcDay } from "@/lib/compliance/frequency";
import { timeZonesForCountry, isInWindow, effectiveWindow } from "@/lib/mail/scheduler/window";
import {
  MAX_PROVIDER_TIMEOUT_MS,
  reconcileStaleSending,
  sendCampaignStep,
  STALE_SENDING_MS,
} from "@/lib/mail/send-service";
import { setSetting } from "@/lib/settings";
import { Worker } from "@/worker/loop";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
  WEEKDAYS,
} from "./helpers/campaign-fixture";

/**
 * Aşama 9: dağıtıcı, zamanlama kuralları ve `mail.send` iş entegrasyonu. Veritabanı BELLEKTE; ağ yok, gerçek
 * gönderim yok, `.data` kullanılmaz. Saat dışarıdan verilir (gerçek bekleme yok).
 */

let client: Client;
let db: Db;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(async () => {
  ({ client, db } = await openMemoryDb());
  await seedBase(db);
  clearJobHandlers();
});

afterEach(() => {
  client.close();
});

function fake(script: FakeStep[] = []) {
  return new FakeMailProvider({ script, now: () => T0 });
}

async function allMessages() {
  return db.select().from(messages).orderBy(messages.id);
}

async function seq(id: number) {
  const [r] = await db.select().from(campaignLeads).where(eq(campaignLeads.id, id));
  return r!;
}

/** Dağıtıcıyı simüle edilmiş saatle `until` anına kadar çalıştırır. */
async function simulate(
  d: MailDispatcher,
  provider: MailProvider,
  from: number,
  until: number,
  maxTicks = 20_000,
) {
  let t = from;
  const sends: { at: number; outcome: string }[] = [];
  for (let i = 0; i < maxTicks && t < until; i++) {
    const now = t;
    const r = await d.dispatchOnce({ now: () => now, provider });
    if (r.send) sends.push({ at: now, outcome: r.send.outcome });
    // Boşta: planlanmış en yakın diziye atla (uyanma zaten 5 dakikayla sınırlı).
    const [n] = await db
      .select({ at: min(campaignLeads.nextSendAt) })
      .from(campaignLeads)
      .where(inArray(campaignLeads.status, ["scheduled", "waiting_next"]));
    t = Math.max(r.nextWakeAt, !r.send && n?.at != null && n.at > r.nextWakeAt ? n.at : 0);
  }
  return { sends, end: t };
}

/* ------------------------------------------------------------------------------------------------ */

describe("dağıtıcı: zamanlama ve sınırlar", () => {
  it("çağrı başına en fazla bir gönderim; aynı kutudan gönderimler arası 90–240 s", async () => {
    const c = await createCampaign(db, { steps: 1 });
    for (let i = 0; i < 4; i++) await addSequence(db, c);
    const p = fake();
    const d = new MailDispatcher(db);

    const first = await d.dispatchOnce({ now: () => T0, provider: p });
    expect(first.send?.outcome).toBe("sent");
    const second = await d.dispatchOnce({ now: () => T0 + 1000, provider: p });
    expect(second.send).toBeNull();
    expect(second.nextWakeAt).toBeGreaterThanOrEqual(T0 + 90_000);
    expect(second.nextWakeAt).toBeLessThanOrEqual(T0 + 240_000);
    expect(p.calls).toBe(1);

    const { sends } = await simulate(d, p, T0 + 1000, T0 + HOUR);
    expect(sends).toHaveLength(3);
    const times = [T0, ...sends.map((s) => s.at)];
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90_000);
      expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(240_000 + 5_000);
    }
    expect(p.calls).toBe(4);
  });

  it("ısınma: kutu tavanı 50 olsa da ilk gün en fazla 20; ertesi UTC günü devam eder", async () => {
    await db.update(mailboxes).set({ dailyCap: 50 }).where(eq(mailboxes.id, DEMO_MAILBOX));
    const c = await createCampaign(db, { steps: 1, dailyCap: 80 });
    for (let i = 0; i < 25; i++) await addSequence(db, c);
    const p = fake();
    const d = new MailDispatcher(db);
    const { sends } = await simulate(d, p, T0, Date.UTC(2026, 10, 3, 0, 0));
    expect(sends).toHaveLength(20);
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, DEMO_MAILBOX));
    expect(mb!.warmupStartedAt).toBe(T0); // ilk başarılı gönderimle başlar

    const next = await simulate(d, p, Date.UTC(2026, 10, 3, 0, 0), Date.UTC(2026, 10, 4, 0, 0));
    expect(next.sends).toHaveLength(5);
    // Hepsi alıcının yerel penceresinde.
    const w = effectiveWindow(WEEKDAYS)!;
    for (const s of [...sends, ...next.sends]) {
      expect(isInWindow(s.at, w, timeZonesForCountry("GB")!)).toBe(true);
    }
  });

  it("kampanya günlük tavanı ayrıca uygulanır", async () => {
    const c = await createCampaign(db, { steps: 1, dailyCap: 2 });
    for (let i = 0; i < 4; i++) await addSequence(db, c);
    const p = fake();
    const { sends } = await simulate(new MailDispatcher(db), p, T0, Date.UTC(2026, 10, 3));
    expect(sends).toHaveLength(2);
  });

  it("pencere dışında gönderim yok; dizi alıcının yerel açılışına ertelenir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    const saturday = Date.UTC(2026, 10, 7, 12);
    const p = fake();
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => saturday, provider: p });
    expect(r.send).toBeNull();
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      nextSendAt: Date.UTC(2026, 10, 9, 9),
      lastError: "outside_window",
    });
    expect(await allMessages()).toHaveLength(0);
  });

  it("saat dilimi bilinmeyen ülke dışlanmaz, ertelenir ve gönderilmez", async () => {
    // Test: demo politikasına tabloda saat dilimi olmayan izinli bir ülke eklenir.
    await client.execute(
      `INSERT INTO country_policies (scope, country_code, mode, locked, seed_version, updated_at)
       VALUES ('demo', 'JP', 'allowed', 0, 1, ${T0})`,
    );
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c, { country: "JP" });
    const p = fake();
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      nextSendAt: T0 + DAY,
      lastError: "timezone_unknown",
    });
  });

  it("takip adımı en erken 5 gün sonra ve yine pencere içinde gönderilir", async () => {
    const c = await createCampaign(db, { steps: 2 });
    const { cl } = await addSequence(db, c);
    const p = fake();
    const d = new MailDispatcher(db);
    await d.dispatchOnce({ now: () => T0, provider: p });
    expect(await seq(cl)).toMatchObject({ status: "waiting_next", nextSendAt: T0 + 5 * DAY });

    // T0 + 5 gün cumartesi: pazartesi 09:00'a ertelenir.
    await d.dispatchOnce({ now: () => T0 + 5 * DAY, provider: p });
    expect(p.calls).toBe(1);
    expect((await seq(cl)).nextSendAt).toBe(Date.UTC(2026, 10, 9, 9));
    const r = await d.dispatchOnce({ now: () => Date.UTC(2026, 10, 9, 9), provider: p });
    expect(r.send?.outcome).toBe("sent");
    expect(await seq(cl)).toMatchObject({ status: "completed", nextStep: 2 });
  });

  it("30 günlük simülasyon: her adım tam bir kez; dizi başına en fazla 3 ileti; kampanya tamamlanır", async () => {
    const c = await createCampaign(db, { steps: 3 });
    const a = await addSequence(db, c);
    const b = await addSequence(db, c);
    const p = fake();
    await simulate(new MailDispatcher(db), p, T0, T0 + 30 * DAY);
    const rows = await allMessages();
    expect(rows).toHaveLength(6);
    expect(p.calls).toBe(6);
    expect(new Set(rows.map((m) => m.idempotencyKey)).size).toBe(6);
    for (const s of [a, b]) {
      const own = rows.filter((m) => m.campaignLeadId === s.cl);
      expect(own.map((m) => m.stepIndex)).toEqual([0, 1, 2]);
      expect(own.every((m) => m.status === "sent")).toBe(true);
      for (let i = 1; i < own.length; i++) {
        expect(own[i]!.sentAt! - own[i - 1]!.sentAt!).toBeGreaterThanOrEqual(5 * DAY);
      }
      expect((await seq(s.cl)).status).toBe("completed");
    }
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, c));
    expect(camp).toMatchObject({ status: "completed" });
    // Alan adı başına günde en fazla bir ileti.
    const perDomainDay = new Set(rows.map((m) => `${m.peerDomain}|${m.sendDay}`));
    expect(perDomainDay.size).toBe(rows.length);
  });

  it("aynı alan adına aynı gün ikinci ileti gönderilmez; dizi dışlanmaz, ertelenir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const x = await addSequence(db, c, { email: "info@ortak.example" });
    const y = await addSequence(db, c, { email: "sales@ortak.example" });
    const p = fake();
    const { sends } = await simulate(new MailDispatcher(db), p, T0, Date.UTC(2026, 10, 3));
    expect(sends).toHaveLength(1);
    const statuses = [(await seq(x.cl)).status, (await seq(y.cl)).status].sort();
    expect(statuses).toEqual(["completed", "scheduled"]);
  });
});

describe("dağıtıcı: yeniden deneme ve belirsiz sonuç", () => {
  it("geçici ret: adım başına en fazla 3 deneme, 15 dk ve 2 saat beklemeyle; sonra dizi failed", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    const transient: FakeStep = { kind: "reject", code: "try_later", permanent: false };
    const p = fake([transient, transient, transient, transient]);
    const d = new MailDispatcher(db);

    expect((await d.dispatchOnce({ now: () => T0, provider: p })).send?.outcome).toBe("failed");
    expect(await seq(cl)).toMatchObject({
      status: "scheduled",
      attempts: 1,
      nextSendAt: T0 + 15 * MIN,
    });
    // Bekleme dolmadan çağrı yok.
    await d.dispatchOnce({ now: () => T0 + 14 * MIN, provider: p });
    expect(p.calls).toBe(1);

    await d.dispatchOnce({ now: () => T0 + 15 * MIN, provider: p });
    expect(await seq(cl)).toMatchObject({ attempts: 2, nextSendAt: T0 + 15 * MIN + 2 * HOUR });
    await d.dispatchOnce({ now: () => T0 + 15 * MIN + 2 * HOUR, provider: p });
    expect(await seq(cl)).toMatchObject({ status: "failed", attempts: 3, nextSendAt: null });

    await simulate(d, p, T0 + 3 * HOUR, T0 + 3 * DAY);
    expect(p.calls).toBe(3);
    expect((await allMessages()).map((m) => m.status)).toEqual(["failed", "failed", "failed"]);
  });

  it("kalıcı ret yeniden denenmez", async () => {
    const c = await createCampaign(db, { steps: 2 });
    const { cl } = await addSequence(db, c);
    const p = fake([{ kind: "reject", code: "no_such_user", permanent: true }]);
    const d = new MailDispatcher(db);
    await d.dispatchOnce({ now: () => T0, provider: p });
    expect(await seq(cl)).toMatchObject({ status: "failed", attempts: 1, nextSendAt: null });
    await simulate(d, p, T0 + MIN, T0 + 3 * DAY);
    expect(p.calls).toBe(1);
  });

  it("sağlayıcının bildirdiği bekleme süresine uyulur", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    const p = fake([
      { kind: "reject", code: "rate_limited", permanent: false, retryAfterMs: HOUR },
    ]);
    await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect((await seq(cl)).nextSendAt).toBe(T0 + HOUR);
  });

  it.each<[string, FakeStep]>([
    ["unknown (ileti gitti)", { kind: "unknown-after" }],
    ["unknown (ileti gitmedi)", { kind: "unknown-before" }],
    ["istisna", { kind: "throw-after" }],
  ])(
    "%s: hiçbir zaman otomatik yeniden gönderilmez; inceleme listesinde görünür",
    async (_, step) => {
      const c = await createCampaign(db, { steps: 3 });
      const { cl, email } = await addSequence(db, c);
      const p = fake([step]);
      const d = new MailDispatcher(db);
      expect((await d.dispatchOnce({ now: () => T0, provider: p })).send?.outcome).toBe("unknown");
      await simulate(d, p, T0 + MIN, T0 + 6 * DAY); // takip adımı 5. günde zamanı gelmiş olurdu
      expect(p.calls).toBe(1);
      expect(await seq(cl)).toMatchObject({ status: "in_flight" });
      const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, c));
      expect(camp!.status).toBe("running"); // inceleme bekleyen dizi varken tamamlanmaz

      const review = await listSendsNeedingReview(db, { now: T0 + 6 * DAY });
      expect(review).toHaveLength(1);
      expect(review[0]).toMatchObject({ campaignLeadId: cl, status: "unknown", stepIndex: 0 });
      expect(JSON.stringify(review)).not.toContain(email);
      expect(review[0]!.recipientMasked).toMatch(/^i\*\*\*@/);
      // Salt okunur: listeleme hiçbir şeyi değiştirmez.
      expect((await allMessages())[0]!.status).toBe("unknown");
    },
  );

  it("zaman aşımı üst sınırı uzlaştırma eşiğinin altında (aktif gönderim stale sayılamaz)", () => {
    expect(MAX_PROVIDER_TIMEOUT_MS).toBeLessThan(STALE_SENDING_MS);
  });

  it("devam eden gönderim uzlaştırmada unknown yapılmaz; sonucu normal kaydedilir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    let release!: (r: ProviderResult) => void;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const slow: MailProvider = {
      id: "demo",
      send: () =>
        new Promise<ProviderResult>((resolve) => {
          release = resolve;
          started();
        }),
    };
    const pending = sendCampaignStep(
      db,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: slow, now: () => T0, timeoutMs: 10_000 },
    );
    await startedP;
    expect((await allMessages())[0]!.status).toBe("sending");
    // Periyodik uzlaştırma 9 dakika sonra çalışsa bile dokunmaz (eşik 10 dakika).
    expect(await reconcileStaleSending(db, { now: T0 + 9 * MIN })).toBe(0);
    release({ status: "accepted", providerMessageId: "demo-x", acceptedAt: T0 });
    expect((await pending).outcome).toBe("sent");
    expect((await allMessages())[0]!.status).toBe("sent");
    expect((await seq(cl)).status).toBe("completed");
  });

  it("kabul edildi ama kayıt yazılamadı: yalnızca kayıt yeniden denenir, ileti tekrar gönderilmez", async () => {
    const c = await createCampaign(db, { steps: 2 });
    const { cl } = await addSequence(db, c);
    const p = fake();
    const d = new MailDispatcher(db);
    const logs: string[] = [];
    await client.execute(
      "CREATE TEMP TRIGGER fail_record BEFORE UPDATE ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'disk dolu'); END",
    );
    const r = await d.dispatchOnce({ now: () => T0, provider: p, log: (m) => logs.push(m) });
    expect(r.send).toMatchObject({ outcome: "sent", recordError: true });
    expect(r.pendingRecords).toBe(1);
    expect((await allMessages())[0]!.status).toBe("sending");

    // Kayıt hâlâ yazılamıyor: gönderim yok, bekleyen kayıt korunur.
    await d.dispatchOnce({ now: () => T0 + 5 * MIN, provider: p });
    expect(d.pendingCount).toBe(1);
    await client.execute("DROP TRIGGER fail_record");
    await d.dispatchOnce({ now: () => T0 + 6 * MIN, provider: p, log: (m) => logs.push(m) });
    expect(d.pendingCount).toBe(0);
    expect((await allMessages())[0]).toMatchObject({ status: "sent" });
    expect((await seq(cl)).status).toBe("waiting_next");
    expect(p.calls).toBe(1);
    // Günlüklerde alıcı, ham ileti veya firma bilgisi yok.
    const text = logs.join("\n");
    expect(text).not.toMatch(/@|MIME|Örnek|1234567890/);
  });

  it("kayıt hiç yazılamazsa uzlaştırma unknown yapar; bellekteki sonuç bırakılır; yeniden gönderim yok", async () => {
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c);
    const p = fake();
    const d = new MailDispatcher(db);
    await client.execute(
      "CREATE TEMP TRIGGER fail_record BEFORE UPDATE ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'disk dolu'); END",
    );
    await d.dispatchOnce({ now: () => T0, provider: p });
    expect(await reconcileStaleSending(db, { now: T0 + STALE_SENDING_MS + 1 })).toBe(1);
    await client.execute("DROP TRIGGER fail_record");
    await d.dispatchOnce({ now: () => T0 + STALE_SENDING_MS + 2, provider: p });
    expect(d.pendingCount).toBe(0);
    expect((await allMessages())[0]).toMatchObject({
      status: "unknown",
      errorCode: "stale_sending",
    });
    await simulate(d, p, T0 + STALE_SENDING_MS + MIN, T0 + 5 * DAY);
    expect(p.calls).toBe(1);
  });
});

describe("dağıtıcı: uygunluk ve güvenlik", () => {
  it("suppression gönderimden hemen önce denetlenir: dizi sonlandırılır, sağlayıcı çağrılmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl, email } = await addSequence(db, c);
    await suppressEmail(db, { email, reason: "unsubscribe", source: "link" });
    const p = fake();
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(r.excluded).toBe(1);
    expect(p.calls).toBe(0);
    expect(await seq(cl)).toMatchObject({ status: "removed", exclusionReasons: ["suppressed"] });
  });

  it("onay yoksa kampanya duraklatılır; lead'lere dokunulmaz", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    await client.execute("DELETE FROM settings WHERE key = 'consent'");
    const p = fake();
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(r.pausedCampaigns).toEqual([c]);
    expect(p.calls).toBe(0);
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, c));
    expect(camp).toMatchObject({ status: "paused", pauseReason: "auto:consent_missing" });
    expect(await seq(cl)).toMatchObject({ status: "scheduled", nextSendAt: null });
  });

  it("geçersiz (varsayılandan geniş) pencere kampanyayı duraklatır", async () => {
    const c = await createCampaign(db, {
      steps: 1,
      sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: "00:00", end: "23:59" },
    });
    await addSequence(db, c);
    const p = fake();
    const r = await new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p });
    expect(r.pausedCampaigns).toEqual([c]);
    expect(p.calls).toBe(0);
  });

  it("duraklatılmış kampanya ve canlı posta kutulu kampanya hiç seçilmez", async () => {
    const paused = await createCampaign(db, { steps: 1, status: "paused" });
    const pl = await addSequence(db, paused);
    const [mb] = await db
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
    const live = await createCampaign(db, { steps: 1, mailboxId: mb!.id });
    const ll = await addSequence(db, live);
    const p = fake();
    await simulate(new MailDispatcher(db), p, T0, T0 + 2 * DAY);
    expect(p.calls).toBe(0);
    expect(await allMessages()).toHaveLength(0);
    expect((await seq(pl.cl)).status).toBe("scheduled");
    expect((await seq(ll.cl)).status).toBe("scheduled");
    const [lc] = await db.select().from(campaigns).where(eq(campaigns.id, live));
    expect(lc!.status).toBe("running"); // canlı kampanyaya dokunulmaz
  });

  it("ayırma işlemi başarısız olursa sağlayıcı çağrılmaz ve dizi değişmez", async () => {
    const c = await createCampaign(db, { steps: 1 });
    const { cl } = await addSequence(db, c);
    await client.execute(
      "CREATE TEMP TRIGGER fail_reserve BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'çökme'); END",
    );
    const p = fake();
    await expect(
      new MailDispatcher(db).dispatchOnce({ now: () => T0, provider: p }),
    ).rejects.toThrow();
    expect(p.calls).toBe(0);
    expect(await allMessages()).toHaveLength(0);
    expect(await seq(cl)).toMatchObject({ status: "scheduled" });
  });

  it("iki dağıtıcı aynı anda çalışsa da tek gönderim olur", async () => {
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c);
    await addSequence(db, c);
    const p = fake([{ kind: "accept", delayMs: 20 }]);
    const [a, b] = [new MailDispatcher(db), new MailDispatcher(db)];
    await Promise.all([
      a.dispatchOnce({ now: () => T0, provider: p }),
      b.dispatchOnce({ now: () => T0, provider: p }),
      a.dispatchOnce({ now: () => T0, provider: p }),
    ]);
    expect(p.calls).toBe(1);
    expect(await allMessages()).toHaveLength(1);
  });
});

describe("mail.send işi ve worker entegrasyonu", () => {
  it("bayrak varsayılan olarak kapalı; yalnızca açıkça 1/true ile açılır", () => {
    expect(isDemoSchedulerEnabled({})).toBe(false);
    for (const v of ["0", "false", "yes", "TRUE", " 1", ""]) {
      expect(isDemoSchedulerEnabled({ [SCHEDULER_FLAG]: v }), v).toBe(false);
    }
    expect(isDemoSchedulerEnabled({ [SCHEDULER_FLAG]: "1" })).toBe(true);
    expect(isDemoSchedulerEnabled({ [SCHEDULER_FLAG]: "true" })).toBe(true);
  });

  async function staleSendingRow() {
    const c = await createCampaign(db, { steps: 1 });
    const s = await addSequence(db, c);
    await client.execute(
      "CREATE TEMP TRIGGER fail_record BEFORE UPDATE ON messages WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'x'); END",
    );
    await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      { provider: fake(), now: () => T0 },
    );
    await client.execute("DROP TRIGGER fail_record");
    return s;
  }

  it("bayrak kapalıyken başlangıç veritabanına hiç yazmaz (uzlaştırma ve iş yok)", async () => {
    await staleSendingRow();
    const before = JSON.stringify(await allMessages());
    const s = await startMailScheduler(db, { env: {}, now: () => T0 + DAY, timers: false });
    expect(s).toMatchObject({ enabled: false, reconciled: 0 });
    expect(JSON.stringify(await allMessages())).toBe(before);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("bayrak kapalıyken işleyici gönderim yapmaz ve kalıcı hata verir", async () => {
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c);
    const p = fake();
    const h = createMailSendHandler({
      enabled: false,
      dispatcher: new MailDispatcher(db),
      provider: p,
    });
    await expect(
      h({
        job: { id: 1 } as never,
        payload: {},
        db,
        shouldStop: () => false,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(p.calls).toBe(0);
    expect(await allMessages()).toHaveLength(0);
  });

  it("bayrak açıkken başlangıçta eski sending uzlaştırılır, tazeye dokunulmaz; tek dağıtım işi planlanır", async () => {
    await staleSendingRow();
    const env = { [SCHEDULER_FLAG]: "1" };
    const fresh = await startMailScheduler(db, {
      env,
      now: () => T0 + STALE_SENDING_MS - 1,
      timers: false,
    });
    expect(fresh.reconciled).toBe(0);
    expect((await allMessages())[0]!.status).toBe("sending");

    const s = await startMailScheduler(db, {
      env,
      now: () => T0 + STALE_SENDING_MS + 1,
      timers: false,
    });
    expect(s).toMatchObject({ enabled: true, reconciled: 1 });
    expect((await allMessages())[0]!.status).toBe("unknown");
    const queued = await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB));
    expect(queued).toHaveLength(1);
  });

  it("worker işi alır, bir ileti gönderir ve kendini tek iş olarak yeniden planlar", async () => {
    const c = await createCampaign(db, { steps: 1 });
    await addSequence(db, c);
    await addSequence(db, c);
    const p = fake();
    const now = () => T0;
    registerJobHandler(
      MAIL_SEND_JOB,
      createMailSendHandler({
        enabled: true,
        dispatcher: new MailDispatcher(db),
        provider: p,
        now,
      }),
    );
    expect(await scheduleDispatch(db, { runAt: 0, now: 0 })).not.toBeNull();
    expect(await scheduleDispatch(db, { runAt: 0, now: 0 })).toBeNull(); // ikinci dağıtıcı yok
    const w = new Worker({ db, workerId: "w-test", log: () => undefined });
    expect(await w.tick()).toBe(true);
    expect(p.calls).toBe(1);
    const all = await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB)).orderBy(jobs.id);
    expect(all.map((j) => j.status)).toEqual(["done", "queued"]);
    expect(all[1]!.runAt).toBeGreaterThanOrEqual(T0 + 90_000);
  });

  it("yeniden başlayan worker başka aktif worker'ın işini sahiplenmez; kalp atışı kesilmişse geri alır", async () => {
    await scheduleDispatch(db, { runAt: 0, now: 0 });
    const claimed = await claimNextJob(db, "w-aktif", Date.now());
    expect(claimed?.type).toBe(MAIL_SEND_JOB);
    await db.insert(jobs).values({
      type: "enrich.email",
      payload: {},
      status: "running",
      runAt: 0,
      lockedBy: "w-eski",
      lockedAt: Date.now(),
      createdAt: 0,
      updatedAt: 0,
    });

    await new Worker({ db, workerId: "w-yeni", log: () => undefined }).recover();
    const rows = await db.select().from(jobs).orderBy(jobs.id);
    expect(rows[0]).toMatchObject({ status: "running", lockedBy: "w-aktif" });
    expect(rows[1]).toMatchObject({ status: "queued" }); // diğer işlerde eski davranış

    expect(await requeueStaleMailJobs(db, { now: Date.now() })).toBe(0);
    expect(await requeueStaleMailJobs(db, { now: Date.now() + STALE_MAIL_JOB_LOCK_MS + 1 })).toBe(
      1,
    );
    const [j] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, MAIL_SEND_JOB)));
    expect(j).toMatchObject({ status: "queued", lockedBy: null });
  });

  it("çökme sonrası: yeni süreç ayrılmış adımı göndermez; uzlaştırma ve inceleme akışı", async () => {
    // Süreç kayıt yazılmadan öldü: `sending` + `in_flight` kaldı, bellekteki sonuç kayboldu.
    const s = await staleSendingRow();
    const after = T0 + STALE_SENDING_MS + MIN;
    await startMailScheduler(db, {
      env: { [SCHEDULER_FLAG]: "1" },
      now: () => after,
      timers: false,
    });
    const p = fake();
    await simulate(new MailDispatcher(db), p, after, after + 3 * DAY);
    expect(p.calls).toBe(0);
    expect(await seq(s.cl)).toMatchObject({ status: "in_flight" });
    expect(await listSendsNeedingReview(db, { now: after })).toHaveLength(1);
    expect((await allMessages()).filter((m) => m.sendDay === utcDay(T0))).toHaveLength(1);
  });

  it("işleyici dağıtıcı hatasında bile hata fırlatmaz ve yeniden planlar", async () => {
    await setSetting(db, "consent", { version: "t", acceptedAt: T0, name: "Test" });
    const broken = { dispatchOnce: async () => Promise.reject(new Error("db")) } as never;
    const logs: string[] = [];
    const h = createMailSendHandler({ enabled: true, dispatcher: broken, now: () => T0 });
    await h({
      job: { id: 999 } as never,
      payload: {},
      db,
      shouldStop: () => false,
      log: (m) => logs.push(m),
    });
    expect(logs.join()).toContain("dağıtıcı hatası");
    expect(await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB))).toHaveLength(1);
  });
});

describe("zamanlayıcı modüllerinin güvenliği", () => {
  it("ağ, canlı sağlayıcı, Google verisi veya gerçek veritabanı yolu kullanılmaz", () => {
    const dir = path.resolve(__dirname, "..", "src", "lib", "mail", "scheduler");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = fs
        .readFileSync(path.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(
        /from "node:(?:net|tls|http|https|dgram|dns|fs)"|nodemailer|googleapis|fetch\(|createTransport|\bsmtp\b|@\/lib\/places|gcache|getDb\(|dbPath\(/i,
      );
    }
  });
});

describe("meşgul sonucunda bağlantı yenileme (onBusy)", () => {
  const ctx = (logs: string[]) => ({
    job: { id: 77 } as never,
    payload: {},
    db,
    shouldStop: () => false,
    log: (m: string) => logs.push(m),
  });

  it("yalnızca meşgul turdan SONRA çağrılır; gönderim olan veya boş turda çağrılmaz", async () => {
    const calls: string[] = [];
    let busy = true;
    const dispatcher = {
      dispatchOnce: async () => {
        calls.push("dispatch");
        return { busy, nextWakeAt: T0 + 10_000 };
      },
    } as never;
    const h = createMailSendHandler({
      enabled: true,
      dispatcher,
      now: () => T0,
      onBusy: async () => {
        calls.push("reset");
        return true;
      },
    });
    await h(ctx([]));
    busy = false;
    await h(ctx([]));
    expect(calls).toEqual(["dispatch", "reset", "dispatch"]);
  });

  it("yenileme ertelenirse veya başarısız olursa işleyici hata fırlatmaz ve yeniden planlar", async () => {
    const dispatcher = { dispatchOnce: async () => ({ busy: true, nextWakeAt: T0 }) } as never;
    for (const onBusy of [async () => false, async () => Promise.reject(new Error("x"))]) {
      const logs: string[] = [];
      await createMailSendHandler({ enabled: true, dispatcher, now: () => T0, onBusy })(ctx(logs));
      expect(logs.join()).toMatch(/ertelendi|yenilenemedi/);
    }
    expect(await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB))).toHaveLength(1);
  });
});
