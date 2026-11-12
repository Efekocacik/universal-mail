import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as limitsRoute from "@/app/api/mailboxes/[id]/limits/route";
import * as mailboxesRoute from "@/app/api/mailboxes/route";
import { transitionCampaign } from "@/lib/campaigns/lifecycle";
import type { Db } from "@/lib/db/client";
import { auditLog, campaigns, jobs, mailboxes } from "@/lib/db/schema";
import { MailboxLimitsError, updateMailboxLimits } from "@/lib/mail/mailbox-limits";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import {
  createMailSendHandler,
  MAIL_SEND_JOB,
  scheduleDispatch,
  WAKE_FLOOR_MS,
  WAKE_REQUEST_SETTING,
  wakeDispatch,
  wakeDispatchSafely,
} from "@/lib/mail/scheduler/job";
import {
  checkLimitsDraft,
  effectiveMailboxCap,
  mailboxLimitBounds,
  nextUtcDayStart,
  planLimitsChange,
  WEEK_MS,
  warmupPreview,
} from "@/lib/mail/scheduler/limits";
import * as throttle from "@/lib/mail/scheduler/throttle";
import { resolveUncertainSend } from "@/lib/mail/scheduler/resolve-review";
import { sendCampaignStep } from "@/lib/mail/send-service";
import { getSetting, setSetting } from "@/lib/settings";
import {
  addSequence,
  createCampaign,
  DEMO_MAILBOX,
  openMemoryDb,
  seedBase,
  T0,
} from "./helpers/campaign-fixture";

/**
 * Faz 4 / E — hata b (dağıtıcıyı hemen uyandırma) ve hata c (posta kutusu günlük sınırı). Veritabanı BELLEKTE; ağ yok,
 * gerçek gönderim yok. Uyandırma hiçbir şey göndermez: yalnızca tek `mail.send` işini öne çeker.
 */

const ORIGIN = "http://127.0.0.1:3000";
const HANDLE = "__umDbHandle";
const ON = { FAZ3_DEMO_SCHEDULER_ENABLED: "1" };
const MIN = 60_000;
const EXP = { dailyCap: 20, warmupStep: 5 };
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
  vi.restoreAllMocks();
});

async function mailJobs() {
  return db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB)).orderBy(jobs.id);
}

async function addMailbox(address: string, o: { dailyCap?: number; warmupStep?: number } = {}) {
  const [mb] = await db
    .insert(mailboxes)
    .values({
      provider: "gmail",
      label: "Satış",
      address,
      credentialsRef: "mailbox.x.refreshToken",
      status: "connected",
      dailyCap: o.dailyCap ?? 20,
      warmupStep: o.warmupStep ?? 5,
      createdAt: T0,
      updatedAt: T0,
    })
    .returning();
  return mb!;
}

/* ------------------------------------------------------------------------------------------------ */

describe("wakeDispatch: idempotent ve monoton uyandırma", () => {
  it("iş yoksa tek iş ekler; ikinci çağrı ikinci iş eklemez", async () => {
    expect(await wakeDispatch(db, { now: T0, enabled: true })).toBe("inserted");
    expect(await wakeDispatch(db, { now: T0, enabled: true })).toBe("noop");
    expect(await wakeDispatch(db, { now: T0 + 1, enabled: true })).toBe("noop");
    const rows = await mailJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", runAt: T0 });
  });

  it("ileride bekleyen işi yalnızca ÖNE çeker; geriye atmaz", async () => {
    await scheduleDispatch(db, { runAt: T0 + 5 * MIN, now: T0 });
    expect(await wakeDispatch(db, { now: T0 + MIN, enabled: true })).toBe("pulled");
    expect((await mailJobs())[0]!.runAt).toBe(T0 + MIN);
    // Daha sonraki uyandırma (iş zaten geçmişte) değişiklik yapmaz.
    expect(await wakeDispatch(db, { now: T0 + 2 * MIN, enabled: true })).toBe("noop");
    expect((await mailJobs())[0]!.runAt).toBe(T0 + MIN);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("çalışan iş varsa bayrak bırakır, iş eklemez", async () => {
    await db.insert(jobs).values({
      type: MAIL_SEND_JOB,
      payload: {},
      status: "running",
      priority: 0,
      maxAttempts: 1,
      runAt: T0,
      lockedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await wakeDispatch(db, { now: T0 + 10, enabled: true })).toBe("flagged");
    expect(await getSetting(db, WAKE_REQUEST_SETTING)).toBe(T0 + 10);
    expect(await mailJobs()).toHaveLength(1);
  });

  it("zamanlayıcı kapalıysa veritabanına yazmaz", async () => {
    expect(await wakeDispatch(db, { now: T0, enabled: false })).toBe("disabled");
    expect(await mailJobs()).toHaveLength(0);
  });

  it("güvenli sarmalayıcı hatayı yutar ve yalnızca hata adını günlüğe yazar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      transaction: () => Promise.reject(new TypeError("info@secret.example")),
    } as unknown as Db;
    expect(await wakeDispatchSafely(broken, { now: T0, env: ON, source: "test" })).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("dispatch.wake_failed source=test error=TypeError");
    expect(line).not.toContain("secret");
  });
});

describe("mail.send işleyicisi: tur sırasında gelen uyandırma", () => {
  async function runHandler(o: { flagAt?: number | null; turnAt: number }) {
    const [job] = await db
      .insert(jobs)
      .values({
        type: MAIL_SEND_JOB,
        payload: {},
        status: "running",
        priority: 0,
        maxAttempts: 1,
        runAt: o.turnAt,
        lockedAt: o.turnAt,
        createdAt: o.turnAt,
        updatedAt: o.turnAt,
      })
      .returning();
    if (o.flagAt !== undefined && o.flagAt !== null) {
      await setSetting(db, WAKE_REQUEST_SETTING, o.flagAt);
    }
    const h = createMailSendHandler({
      enabled: true,
      dispatcher: new MailDispatcher(db),
      provider: new FakeMailProvider({ script: [], now: () => o.turnAt }),
      now: () => o.turnAt,
    });
    await h({ job: job!, payload: {}, db, shouldStop: () => false, log: () => undefined });
    return (await mailJobs()).filter((j) => j.id !== job!.id);
  }

  it("bayrak bu turdan sonra yazıldıysa sonraki tur WAKE_FLOOR_MS içinde planlanır", async () => {
    const next = await runHandler({ turnAt: T0, flagAt: T0 });
    expect(next).toHaveLength(1);
    expect(next[0]!.runAt).toBe(T0 + WAKE_FLOOR_MS);
  });

  it("eski bayrak (önceki tur) sonraki turu öne çekmez", async () => {
    const next = await runHandler({ turnAt: T0, flagAt: T0 - 1 });
    expect(next).toHaveLength(1);
    expect(next[0]!.runAt).toBeGreaterThan(T0 + WAKE_FLOOR_MS);
  });

  it("bayrak yoksa olağan plan", async () => {
    const next = await runHandler({ turnAt: T0, flagAt: null });
    expect(next[0]!.runAt).toBeGreaterThan(T0 + WAKE_FLOOR_MS);
  });
});

describe("uyandırmayı tetikleyen işlemler", () => {
  it("kampanya devam ettirilince bekleyen dağıtım işi hemen çalışacak şekilde öne çekilir", async () => {
    const id = await createCampaign(db, { steps: 1 });
    await addSequence(db, id);
    await scheduleDispatch(db, { runAt: T0 + 30 * MIN, now: T0 });
    await transitionCampaign(db, id, "pause", { now: T0 + MIN, env: ON });
    const r = await transitionCampaign(db, id, "resume", { now: T0 + 2 * MIN, env: ON });
    expect(r).toMatchObject({ status: "running", changed: true, wake: "pulled" });
    const rows = await mailJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAt).toBe(T0 + 2 * MIN);
    // Tekrarlanan devam isteği değişiklik yapmaz ve yeniden uyandırmaz.
    const again = await transitionCampaign(db, id, "resume", { now: T0 + 3 * MIN, env: ON });
    expect(again.changed).toBe(false);
    expect(again.wake).toBeUndefined();
  });

  it("inceleme kararı 'gönderilmedi' dağıtıcıyı uyandırır; tekrarı uyandırmaz", async () => {
    const campaignId = await createCampaign(db, { steps: 3 });
    const s = await addSequence(db, campaignId);
    const r = await sendCampaignStep(
      db,
      { campaignLeadId: s.cl, stepIndex: 0 },
      {
        provider: new FakeMailProvider({ script: [{ kind: "unknown-after" }], now: () => T0 }),
        now: () => T0,
      },
    );
    const messageId = (r as { messageRowId: number }).messageRowId;
    await scheduleDispatch(db, { runAt: T0 + 30 * MIN, now: T0 });
    const res = await resolveUncertainSend(db, messageId, "mark_not_sent", {
      confirm: true,
      now: T0 + MIN,
      env: ON,
    });
    expect(res.sequenceStatus).toBe("scheduled");
    expect((await mailJobs())[0]!.runAt).toBe(T0 + MIN);
    await db.update(jobs).set({ runAt: T0 + 60 * MIN });
    const again = await resolveUncertainSend(db, messageId, "mark_not_sent", {
      confirm: true,
      now: T0 + 2 * MIN,
      env: ON,
    });
    expect(again.alreadyResolved).toBe(true);
    expect((await mailJobs())[0]!.runAt).toBe(T0 + 60 * MIN);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("limits.ts: saf yardımcılar", () => {
  it("node: içe aktarımı yoktur (istemci de kullanır); throttle aynı fonksiyonları yeniden dışa aktarır", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "src/lib/mail/scheduler/limits.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "node:|require\(/);
    expect(throttle.effectiveMailboxCap).toBe(effectiveMailboxCap);
    expect(throttle.nextUtcDayStart).toBe(nextUtcDayStart);
  });

  it("profil sınırları: kişisel Gmail 50/+5, diğerleri 80/+10", () => {
    expect(mailboxLimitBounds({ address: "satis@gmail.com" })).toEqual({
      maxDailyCap: 50,
      maxWarmupStep: 5,
      warmupBase: 10,
    });
    expect(mailboxLimitBounds({ address: "sales@firma.example" })).toEqual({
      maxDailyCap: 80,
      maxWarmupStep: 10,
      warmupBase: 20,
    });
  });

  it("ısınma önizlemesi: bugün, bir hafta sonra ve tavana kalan hafta", () => {
    const gmail = { dailyCap: 30, warmupStep: 5, warmupStartedAt: null, address: "a@gmail.com" };
    expect(warmupPreview(gmail, T0)).toEqual({
      today: 10,
      nextWeek: 15,
      weeksToCap: 4,
      target: 30,
    });
    expect(warmupPreview({ ...gmail, warmupStartedAt: T0 - 2 * WEEK_MS }, T0)).toEqual({
      today: 20,
      nextWeek: 25,
      weeksToCap: 2,
      target: 30,
    });
    expect(warmupPreview({ ...gmail, warmupStep: 0 }, T0).weeksToCap).toBeNull();
    expect(warmupPreview({ ...gmail, dailyCap: 8 }, T0)).toMatchObject({ today: 8, weeksToCap: 0 });
    // Kişisel Gmail'de tavan 80 yazılsa bile hedef 50'dir.
    expect(warmupPreview({ ...gmail, dailyCap: 80 }, T0).target).toBe(50);
  });

  it("planLimitsChange: tavan düşerken veya ısınma başlamamışken başlangıç değişmez", () => {
    const gmail = { dailyCap: 30, warmupStep: 5, address: "a@gmail.com" };
    expect(
      planLimitsChange({ ...gmail, warmupStartedAt: null }, { dailyCap: 50, warmupStep: 5 }, T0),
    ).toEqual({ warmupStartedAt: null, rebased: false, beforeCap: 10, todayCap: 10 });
    const started = T0 - 3 * WEEK_MS; // ısınma tavanı bugün 25
    expect(
      planLimitsChange({ ...gmail, warmupStartedAt: started }, { dailyCap: 20, warmupStep: 5 }, T0),
    ).toEqual({ warmupStartedAt: started, rebased: false, beforeCap: 25, todayCap: 20 });
    // Artış 0'a indirilirse rampa tabanda durur (düşüş; yeniden başlatma yok).
    expect(
      planLimitsChange({ ...gmail, warmupStartedAt: started }, { dailyCap: 30, warmupStep: 0 }, T0),
    ).toMatchObject({ rebased: false, todayCap: 10 });
    // Kutu tavanı yükselse de ısınma tavanı (25) aşılmıyorsa olduğu gibi kalır.
    expect(
      planLimitsChange(
        { ...gmail, dailyCap: 25, warmupStartedAt: started },
        { dailyCap: 50, warmupStep: 5 },
        T0,
      ),
    ).toEqual({ warmupStartedAt: started, rebased: false, beforeCap: 25, todayCap: 25 });
  });

  it("planLimitsChange: yükselişte bugün en çok bir haftalık artıştan az fazlası", () => {
    for (const [cap, step, weeks] of [
      [12, 5, 9],
      [20, 3, 7],
      [37, 5, 10],
    ] as const) {
      const cur = {
        dailyCap: cap,
        warmupStep: step,
        warmupStartedAt: T0 - weeks * WEEK_MS,
        address: "a@gmail.com",
      };
      const p = planLimitsChange(cur, { dailyCap: 50, warmupStep: 5 }, T0);
      expect(p.rebased).toBe(true);
      expect(p.beforeCap).toBe(cap);
      expect(p.todayCap).toBeGreaterThanOrEqual(cap);
      expect(p.todayCap).toBeLessThan(cap + 5);
    }
  });

  it("form doğrulaması: tam sayı ve profil sınırları", () => {
    const b = { maxDailyCap: 50, maxWarmupStep: 5 };
    expect(checkLimitsDraft({ dailyCap: " 25 ", warmupStep: "5" }, b)).toEqual({
      value: { dailyCap: 25, warmupStep: 5 },
      issues: [],
    });
    const bad = checkLimitsDraft({ dailyCap: "51", warmupStep: "2.5" }, b);
    expect(bad.value).toBeNull();
    expect(bad.issues).toEqual([
      { field: "dailyCap", code: "above_max", min: 1, max: 50 },
      { field: "warmupStep", code: "not_integer", min: 0, max: 5 },
    ]);
    expect(
      checkLimitsDraft({ dailyCap: "0", warmupStep: "-1" }, b).issues.map((i) => i.code),
    ).toEqual(["below_min", "below_min"]);
  });
});

describe("posta kutusu günlük sınırı (servis)", () => {
  it("kişisel Gmail: 50'ye kadar kabul, 51 açık hata; artış en çok 5", async () => {
    const mb = await addMailbox("satis@gmail.com");
    const r = await updateMailboxLimits(
      db,
      mb.id,
      { dailyCap: 50, expected: { dailyCap: 20, warmupStep: 5 } },
      { now: T0 + 1000, env: ON },
    );
    expect(r).toMatchObject({
      dailyCap: 50,
      warmupStep: 5,
      unchanged: false,
      todayCap: 10,
      warmupRebased: false,
    });
    const exp = { dailyCap: 50, warmupStep: 5 };
    await expect(
      updateMailboxLimits(db, mb.id, { dailyCap: 51, expected: exp }),
    ).rejects.toMatchObject({ kind: "cap_above_provider_max", detail: { max: 50 } });
    await expect(
      updateMailboxLimits(db, mb.id, { warmupStep: 6, expected: exp }),
    ).rejects.toMatchObject({ kind: "warmup_step_above_max", detail: { max: 5 } });
  });

  it("aynı değerler: yazma ve sürüm denetimi yok; başkasının değiştirdiği sınır: çakışma", async () => {
    const mb = await addMailbox("sales@firma.example");
    const same = await updateMailboxLimits(db, mb.id, {
      dailyCap: 20,
      warmupStep: 5,
      expected: { dailyCap: 1, warmupStep: 0 },
    });
    expect(same).toMatchObject({ unchanged: true, wake: null, updatedAt: T0 });
    await expect(
      updateMailboxLimits(db, mb.id, {
        dailyCap: 30,
        expected: { dailyCap: 25, warmupStep: 5 },
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(row!.dailyCap).toBe(20);
  });

  it("gelen kutusu eşitlemesi updated_at'i ilerletse de açık pencere çakışma almaz", async () => {
    const mb = await addMailbox("sales@firma.example");
    // Eşitleme imleci ilerledi: yalnızca updated_at değişir (sınırlar aynı).
    await db
      .update(mailboxes)
      .set({ updatedAt: T0 + 5 * MIN })
      .where(eq(mailboxes.id, mb.id));
    const r = await updateMailboxLimits(
      db,
      mb.id,
      { dailyCap: 30, expected: { dailyCap: 20, warmupStep: 5 } },
      { now: T0 + 6 * MIN },
    );
    expect(r).toMatchObject({ dailyCap: 30, unchanged: false });
  });

  it("ısınma rampası atlanamaz: artış sonradan açılınca tavan bugünkü değerden devam eder", async () => {
    // 6 haftadır artışı 0 olan kişisel Gmail kutusu: bugün 10.
    const mb = await addMailbox("satis@gmail.com", { dailyCap: 50, warmupStep: 0 });
    await db
      .update(mailboxes)
      .set({ warmupStartedAt: T0 - 6 * WEEK_MS })
      .where(eq(mailboxes.id, mb.id));
    const now = T0 + MIN;
    const r = await updateMailboxLimits(
      db,
      mb.id,
      { warmupStep: 5, expected: { dailyCap: 50, warmupStep: 0 } },
      { now, env: ON },
    );
    // Eski formülle bir gecede 40 olurdu; artık bugün 10, bir hafta sonra 15.
    expect(r).toMatchObject({ todayCap: 10, warmupRebased: true });
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(row!.warmupStartedAt).toBe(now);
    expect(effectiveMailboxCap(row!, now + WEEK_MS)).toBe(15);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mailbox.limits_updated"), eq(auditLog.entityId, String(mb.id))),
      );
    expect(a!.detail).toMatchObject({
      todayCap: { from: 10, to: 10 },
      warmupStartedAt: { from: T0 - 6 * WEEK_MS, to: now },
    });
  });

  it("eski kutuda tavan yükseltilince bugün en çok bir haftalık artış kadar yükselir", async () => {
    // 8 haftalık kişisel Gmail: ısınma tavanı 50, ama kutu tavanı 20.
    const mb = await addMailbox("satis@gmail.com", { dailyCap: 20, warmupStep: 5 });
    await db
      .update(mailboxes)
      .set({ warmupStartedAt: T0 - 8 * WEEK_MS })
      .where(eq(mailboxes.id, mb.id));
    const r = await updateMailboxLimits(
      db,
      mb.id,
      { dailyCap: 50, expected: { dailyCap: 20, warmupStep: 5 } },
      { now: T0, env: ON },
    );
    expect(r).toMatchObject({ todayCap: 20, warmupRebased: true });
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.id));
    expect(effectiveMailboxCap(row!, T0 + WEEK_MS)).toBe(25);
    expect(effectiveMailboxCap(row!, T0 + 6 * WEEK_MS)).toBe(50);
  });

  it("demo kutusu değiştirilemez; olmayan kutu 404; boş yama reddedilir", async () => {
    await expect(
      updateMailboxLimits(db, DEMO_MAILBOX, { dailyCap: 10, expected: EXP }),
    ).rejects.toMatchObject({ kind: "not_editable" });
    await expect(
      updateMailboxLimits(db, 999, { dailyCap: 10, expected: EXP }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(updateMailboxLimits(db, 999, { expected: EXP })).rejects.toBeInstanceOf(
      MailboxLimitsError,
    );
  });

  it("bugünkü tavan artarsa dağıtıcı uyandırılır; denetim kaydı adres içermez", async () => {
    const mb = await addMailbox("sales@firma.example", { dailyCap: 10 });
    await db
      .update(mailboxes)
      .set({ warmupStartedAt: T0 - 3 * WEEK_MS })
      .where(eq(mailboxes.id, mb.id));
    await scheduleDispatch(db, { runAt: T0 + 30 * MIN, now: T0 });
    const r = await updateMailboxLimits(
      db,
      mb.id,
      { dailyCap: 40, expected: { dailyCap: 10, warmupStep: 5 } },
      { now: T0 + MIN, env: ON },
    );
    // Rampa bugünkü tavandan (10) devam eder: ilk hafta tabanı 20 (eski formül 35 verirdi).
    expect(r).toMatchObject({ todayCap: 20, wake: "pulled", warmupRebased: true });
    expect((await mailJobs())[0]!.runAt).toBe(T0 + MIN);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "mailbox.limits_updated"), eq(auditLog.entityId, String(mb.id))),
      );
    expect(a!.detail).toEqual({
      from: { dailyCap: 10, warmupStep: 5 },
      to: { dailyCap: 40, warmupStep: 5 },
      todayCap: { from: 10, to: 20 },
      warmupStartedAt: { from: T0 - 3 * WEEK_MS, to: T0 + MIN },
    });
    expect(JSON.stringify(a)).not.toContain("firma.example");

    // Tavan düşürülürse uyandırma yok.
    const down = await updateMailboxLimits(
      db,
      mb.id,
      { dailyCap: 15, expected: { dailyCap: 40, warmupStep: 5 } },
      { now: T0 + 2 * MIN, env: ON },
    );
    expect(down).toMatchObject({ todayCap: 15, wake: null });
  });
});

describe("PATCH /api/mailboxes/[id]/limits ve GET /api/mailboxes", () => {
  function patch(id: number | string, payload: unknown) {
    return limitsRoute.PATCH(
      new Request(`${ORIGIN}/api/mailboxes/${id}/limits`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: String(id) }) },
    );
  }
  async function call(res: Promise<Response>) {
    const r = await res;
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  it("başarılı güncelleme ve hata kodları", async () => {
    const mb = await addMailbox("satis@gmail.com");
    const exp = { dailyCap: mb.dailyCap, warmupStep: mb.warmupStep };
    const ok = await call(patch(mb.id, { dailyCap: 30, expected: exp }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: mb.id, dailyCap: 30, warmupStep: 5 });

    const over = await call(
      patch(mb.id, { dailyCap: 51, expected: { dailyCap: 30, warmupStep: 5 } }),
    );
    expect(over).toMatchObject({ status: 400, body: { code: "CAP_ABOVE_PROVIDER_MAX", max: 50 } });

    const stale = await call(patch(mb.id, { dailyCap: 40, expected: exp }));
    expect(stale).toMatchObject({ status: 409, body: { code: "CONFLICT" } });

    const demo = await call(patch(DEMO_MAILBOX, { dailyCap: 5, expected: exp }));
    expect(demo).toMatchObject({ status: 409, body: { code: "NOT_EDITABLE" } });

    expect((await call(patch(999, { dailyCap: 5, expected: exp }))).status).toBe(404);
  });

  it("gövde katı doğrulanır: bilinmeyen alan, boş yama, aralık dışı", async () => {
    const mb = await addMailbox("sales@firma.example");
    for (const bad of [
      { dailyCap: 30, expected: EXP, address: "x@y.example" },
      { expected: EXP },
      { dailyCap: 81, expected: EXP },
      { warmupStep: 11, expected: EXP },
      { dailyCap: 30 },
      { dailyCap: 30, expectedUpdatedAt: mb.updatedAt },
      { dailyCap: 30, expected: { ...EXP, updatedAt: 1 } },
    ]) {
      expect((await patch(mb.id, bad)).status).toBe(400);
    }
  });

  it("liste düzenlenebilirlik ve profil sınırlarını içerir", async () => {
    await addMailbox("satis@gmail.com");
    const res = await mailboxesRoute.GET(
      new Request(`${ORIGIN}/api/mailboxes`, { headers: { origin: ORIGIN } }),
      undefined,
    );
    const body = (await res.json()) as {
      items: {
        provider: string;
        limitsEditable: boolean;
        updatedAt: number;
        limits: { profileMaxDaily: number; maxWarmupStep: number };
      }[];
    };
    const demo = body.items.find((i) => i.provider === "demo")!;
    const gmail = body.items.find((i) => i.provider === "gmail")!;
    expect(demo.limitsEditable).toBe(false);
    expect(gmail).toMatchObject({
      limitsEditable: true,
      updatedAt: T0,
      limits: { profileMaxDaily: 50, maxWarmupStep: 5 },
    });
  });
});

describe("kampanya durumu", () => {
  it("devam ettirilen kampanya running olur (uyandırma gönderim yapmaz)", async () => {
    const id = await createCampaign(db, { steps: 1, status: "paused" });
    await transitionCampaign(db, id, "resume", { now: T0, env: ON });
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
    expect(c!.status).toBe("running");
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "message.sent"))).toEqual([]);
  });
});
