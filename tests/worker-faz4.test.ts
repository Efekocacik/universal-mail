import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { categorySets, jobs, notifications, places, scanSchedules, scans } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { clearJobHandlers, getJobHandler, type JobContext } from "@/lib/jobs/registry";
import { MAIL_SEND_JOB } from "@/lib/mail/scheduler/job";
import { APP_STOPPED, INTERRUPTED } from "@/lib/scan/runner";
import { SCHEDULE_TICK_JOB, scheduleTick, TICK_INTERVAL_MS } from "@/lib/scan/schedule";
import { createScheduleFromScan } from "@/lib/scan/schedule-service";
import { createAndStartScan } from "@/lib/scan/service";
import { persistPlaces } from "@/lib/scan/store";
import { setSetting } from "@/lib/settings";
import { registerScanBackgroundHandlers } from "@/worker/background";
import {
  FINISHED_JOB_RETENTION_MS,
  HOUSEKEEPING_INTERVAL_MS,
  HOUSEKEEPING_MAX_RETRIES,
  HOUSEKEEPING_RETRY_MS,
  runHousekeeping,
  startHousekeepingLoop,
  type HousekeepingResult,
} from "@/worker/housekeeping";
import { Worker } from "@/worker/loop";
import {
  createWakeGate,
  createWorkerMessageHandler,
  handleWake,
  isWakeMessage,
  WAKE_DEBOUNCE_MS,
} from "@/worker/wake";
import { createTestDb, type TestDb } from "./helpers/db";

const DAY = 86_400_000;
let t: TestDb;
let db: Db;

async function setup() {
  await setSetting(db, "places.provider", "mock");
  await setSetting(db, "targets.countries", ["GB"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek A.Ş.",
    address: "Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: 1, name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

async function newScan(name = "London", at = Date.now()) {
  const cat = (await db.select().from(categorySets)).find((c) => c.key === "cafe")!;
  const { scanId } = await createAndStartScan(
    db,
    {
      region: {
        kind: "city",
        name,
        countryCode: "GB",
        bbox:
          name === "London"
            ? { south: 51.49, west: -0.15, north: 51.53, east: -0.09 }
            : { south: 53.47, west: -2.25, north: 53.49, east: -2.22 },
      },
      categoryIds: [cat.id],
    },
    at,
  );
  return scanId;
}

const ctx = (job: { id: number; type: string }, payload: unknown = {}): JobContext =>
  ({
    job: job as JobContext["job"],
    payload,
    db,
    shouldStop: () => false,
    log: () => undefined,
  }) as JobContext;

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  clearJobHandlers();
});
afterEach(async () => {
  clearJobHandlers();
  await t.cleanup();
});

describe("tick işi", () => {
  it("zamanı gelen zamanlamayı çalıştırır ve bir sonraki tick'i 5 dk sonraya kurar", async () => {
    await setup();
    const now = Date.now();
    const scanId = await newScan("London", now - 20 * DAY);
    await db
      .update(scans)
      .set({ status: "completed", finishedAt: now - 20 * DAY })
      .where(eq(scans.id, scanId));
    await db.delete(jobs);
    await createScheduleFromScan(db, { fromScanId: scanId, intervalDays: 7 }, now - 20 * DAY);
    registerScanBackgroundHandlers({ now: () => now });
    const tickId = (await scheduleTick(db, { runAt: now, now }))!;
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, tickId));
    await getJobHandler(SCHEDULE_TICK_JOB)!(ctx({ id: tickId, type: SCHEDULE_TICK_JOB }));
    const scheduled = await db.select().from(scans).where(eq(scans.origin, "schedule"));
    expect(scheduled).toHaveLength(1);
    const ticks = await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB));
    const next = ticks.find((j) => j.id !== tickId)!;
    expect(next).toMatchObject({ status: "queued", runAt: now + TICK_INTERVAL_MS });
  });

  it("tur hata verse bile zincir kopmaz", async () => {
    const now = Date.now();
    registerScanBackgroundHandlers({ now: () => now });
    const tickId = (await scheduleTick(db, { runAt: now, now }))!;
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, tickId));
    // Kurulum yok: zamanlama yok, tur boş döner; yine de sonraki tick kurulur.
    await getJobHandler(SCHEDULE_TICK_JOB)!(ctx({ id: tickId, type: SCHEDULE_TICK_JOB }));
    expect(
      (await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB))).filter(
        (j) => j.status === "queued",
      ),
    ).toHaveLength(1);
  });

  it("açılış izleme ve yer kimliği işleri: kapalı/engelli ise ağ çağrısı yok, bildirim tek", async () => {
    registerScanBackgroundHandlers();
    await setSetting(db, "novelty.futureWatch", { enabled: false, everyDays: 7, maxPerRun: 10 });
    await getJobHandler("places.watch_future")!(ctx({ id: 1, type: "places.watch_future" }));
    expect(await db.select().from(notifications)).toHaveLength(0);
    await setSetting(db, "novelty.futureWatch", { enabled: true, everyDays: 7, maxPerRun: 10 });
    await getJobHandler("places.watch_future")!(ctx({ id: 2, type: "places.watch_future" }));
    await getJobHandler("places.refresh_ids")!(ctx({ id: 3, type: "places.refresh_ids" }, {}));
    const kinds = (await db.select().from(notifications)).map((n) =>
      n.dedupeKey.split(":").slice(0, 3).join(":"),
    );
    expect(kinds.sort()).toEqual([
      "background.skipped:refresh_ids:CONSENT_REQUIRED",
      "background.skipped:watch_future:CONSENT_REQUIRED",
    ]);
  });

  it("açılış izleme ve kimlik yenileme demo sağlayıcıyla çalışır; RDAP işi skor yeniler", async () => {
    await setup();
    registerScanBackgroundHandlers();
    const scanId = await newScan();
    await persistPlaces(
      db,
      scanId,
      [
        {
          placeId: "not-demo",
          source: "demo",
          name: "x",
          lat: 51.5,
          lng: -0.12,
          types: ["cafe"],
          businessStatus: "FUTURE_OPENING",
        },
      ],
      Date.now() - 400 * DAY,
    );
    await getJobHandler("places.watch_future")!(ctx({ id: 1, type: "places.watch_future" }));
    await getJobHandler("places.refresh_ids")!(
      ctx({ id: 2, type: "places.refresh_ids" }, { limit: 5 }),
    );
    const [p] = await db.select().from(places);
    expect(p!.goneAt).not.toBeNull(); // demo sağlayıcı bu kimliği tanımıyor → kayboldu
    await getJobHandler("novelty.rdap")!(ctx({ id: 3, type: "novelty.rdap" }));
  });
});

describe("uyandırma", () => {
  it("kuyruktaki tick öne çekilir; gönderim işi yalnızca zamanlayıcı açıksa öne çekilir", async () => {
    const now = Date.now();
    await scheduleTick(db, { runAt: now + 300_000, now });
    const mailId = (await enqueueJob(db, MAIL_SEND_JOB, {}, { runAt: now + 600_000 }))!;
    expect(await handleWake(db, { now, mailEnabled: false })).toEqual({
      tickInserted: false,
      mail: "disabled",
    });
    const [tick] = await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB));
    expect(tick!.runAt).toBe(now);
    expect((await db.select().from(jobs).where(eq(jobs.id, mailId)))[0]!.runAt).toBe(now + 600_000);
    expect((await handleWake(db, { now, mailEnabled: true })).mail).toBe("pulled");
    expect((await db.select().from(jobs).where(eq(jobs.id, mailId)))[0]!.runAt).toBe(now);
    // İkinci uyandırma ikinci iş eklemez (idempotent).
    expect((await handleWake(db, { now, mailEnabled: true })).mail).toBe("noop");
    expect(await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB))).toHaveLength(1);
  });

  it("kuyrukta gönderim işi yoksa uyandırma tek iş ekler (E: wakeDispatch)", async () => {
    const now = Date.now();
    expect((await handleWake(db, { now, mailEnabled: true })).mail).toBe("inserted");
    expect((await handleWake(db, { now, mailEnabled: true })).mail).toBe("noop");
    const mail = await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.runAt).toBe(now);
  });

  it("tick yoksa eklenir; ileti doğrulama ve sıçrama kapısı", async () => {
    const now = Date.now();
    expect((await handleWake(db, { now, mailEnabled: false })).tickInserted).toBe(true);
    expect(isWakeMessage({ type: "wake" })).toBe(true);
    expect(isWakeMessage("wake")).toBe(false);
    expect(isWakeMessage(null)).toBe(false);
    let clock = 1_000_000;
    const gate = createWakeGate(() => clock);
    expect(gate()).toBe(true);
    clock += WAKE_DEBOUNCE_MS - 1;
    expect(gate()).toBe(false);
    clock += 2;
    expect(gate()).toBe(true);
  });
});

describe("işçi IPC sözleşmesi (Electron ana süreci → işçi)", () => {
  it("'shutdown' kapatır; {type:'wake'} kapıdan geçerse gerçek uyandırmayı çalıştırır; diğerleri yok sayılır", async () => {
    let clock = 5_000_000;
    const shutdown = vi.fn();
    const errors: unknown[] = [];
    const wakes: Awaited<ReturnType<typeof handleWake>>[] = [];
    const onMessage = createWorkerMessageHandler({
      shutdown,
      gate: createWakeGate(() => clock),
      wake: async () => {
        const r = await handleWake(db, { now: clock, mailEnabled: true });
        wakes.push(r);
        return r;
      },
      onError: (e) => errors.push(e),
    });
    // Ana sürecin gönderdiği biçim (electron/main.ts createWakeSignal → w.send({type:"wake"})).
    onMessage({ type: "wake" });
    onMessage({ type: "wake" }); // aynı dakikada ikinci uyandırma kapıda düşer
    onMessage({ type: "notify" }); // ters yönün iletisi işçide anlamsızdır
    onMessage("wake");
    onMessage(null);
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(wakes[0]).toEqual({ tickInserted: true, mail: "inserted" });
    expect(await db.select().from(jobs).where(eq(jobs.type, MAIL_SEND_JOB))).toHaveLength(1);
    expect(shutdown).not.toHaveBeenCalled();
    onMessage("shutdown");
    expect(shutdown).toHaveBeenCalledTimes(1);

    // Uyandırma hatası süreci çökertmez; günlüğe düşer.
    clock += WAKE_DEBOUNCE_MS;
    const failing = createWorkerMessageHandler({
      shutdown,
      gate: () => true,
      wake: () => Promise.reject(new Error("TRANSACTION_ACTIVE")),
      onError: (e) => errors.push(e),
    });
    failing({ type: "wake" });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });
});

describe("bakım turu (M3)", () => {
  it("eski bitmiş işleri siler, gün anahtarlı işleri günde bir ekler, tick zincirini kurar", async () => {
    const now = Date.now();
    const old = (await enqueueJob(db, "x.old", {}))!;
    const recent = (await enqueueJob(db, "x.recent", {}))!;
    await db
      .update(jobs)
      .set({ status: "done", finishedAt: now - FINISHED_JOB_RETENTION_MS - 1 })
      .where(eq(jobs.id, old));
    await db
      .update(jobs)
      .set({ status: "done", finishedAt: now - DAY })
      .where(eq(jobs.id, recent));
    const r = await runHousekeeping(db, { now, log: () => undefined });
    expect(r.errors).toEqual([]);
    expect(r.enqueued.sort()).toEqual([
      "novelty.rdap",
      "places.refresh_ids",
      "places.watch_future",
    ]);
    const types = (await db.select().from(jobs)).map((j) => j.type);
    expect(types).not.toContain("x.old");
    expect(types).toContain("x.recent");
    expect(types).toContain(SCHEDULE_TICK_JOB);
    // Aynı gün ikinci tur: yeni iş eklenmez.
    const again = await runHousekeeping(db, { now: now + 3_600_000 });
    expect(again.enqueued).toEqual([]);
    expect((await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB))).length).toBe(1);
  });

  it("türetilmiş bayrak süresi ayarlıysa uygulanır; bir adım hatası diğerlerini durdurmaz", async () => {
    const now = Date.now();
    await setSetting(db, "google.derivedFlagsDays", 30);
    const scanId = await newScan("London", now - 100 * DAY);
    await persistPlaces(
      db,
      scanId,
      [
        {
          placeId: "f",
          source: "demo",
          name: "x",
          lat: 51.5,
          lng: -0.12,
          types: ["cafe"],
          businessStatus: "FUTURE_OPENING",
        },
      ],
      now - 100 * DAY,
    );
    const r = await runHousekeeping(db, { now });
    expect(r.derivedFlags).toBeGreaterThan(0);
    expect(r.coordinates).toBe(1);
  });
});

/** Taramayı bir zamanlamanın duraklamış çalışması yapar (zamanlama gerçek kayıttır). */
async function pausedScheduledRun(
  name: string,
  pauseCode: string,
  opts: { enabled?: boolean } = {},
): Promise<{ scanId: number; scheduleId: number }> {
  const scanId = await newScan(name);
  await db
    .update(scans)
    .set({ status: "completed", finishedAt: Date.now() })
    .where(eq(scans.id, scanId));
  const { id: scheduleId } = await createScheduleFromScan(db, {
    fromScanId: scanId,
    intervalDays: 7,
  });
  if (opts.enabled === false)
    await db.update(scanSchedules).set({ enabled: false }).where(eq(scanSchedules.id, scheduleId));
  await db
    .update(scans)
    .set({ status: "paused", pauseCode, origin: "schedule", scheduleId, scheduleSlot: 1 })
    .where(eq(scans.id, scanId));
  return { scanId, scheduleId };
}

describe("recover (M9 ve zamanlanmış taramalar)", () => {
  it("kesilen elle tarama duraklar ve tek scan.paused bildirimi; zamanlanmış tarama sürer", async () => {
    await setup();
    const manual1 = await newScan("London");
    await db.update(scans).set({ status: "running" }).where(eq(scans.id, manual1));
    const { scanId: sched } = await pausedScheduledRun("Manchester", APP_STOPPED);
    const w = new Worker({ db, workerId: "w", log: () => undefined });
    const r = await w.recover();
    expect(r).toEqual({ interrupted: 1, resumedScheduled: 1, pausedManual: 1, heldScheduled: 0 });
    const by = new Map((await db.select().from(scans)).map((s) => [s.id, s]));
    expect(by.get(manual1)).toMatchObject({ status: "paused", pauseCode: INTERRUPTED });
    expect(by.get(sched)).toMatchObject({ status: "queued", pauseCode: null });
    const ns = await db.select().from(notifications);
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ kind: "scan.paused", url: "/scans" });
    // İkinci açılış aynı gün: kesilen tarama yok, bildirim çoğalmaz.
    await w.recover();
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("bütçe dolmuşsa zamanlanmış tarama kendiliğinden sürmez", async () => {
    await setup();
    const { scanId: sched } = await pausedScheduledRun("Manchester", INTERRUPTED);
    await setSetting(db, "budget.monthlyUsd", 0.01);
    await recordUsage(db, "mock", "text_search_pro", 6000);
    const r = await new Worker({ db, workerId: "w", log: () => undefined }).recover();
    expect(r.resumedScheduled).toBe(0);
    expect((await db.select().from(scans).where(eq(scans.id, sched)))[0]!.status).toBe("paused");
  });

  it("inceleme P2: zamanlaması kapatılmış veya silinmiş tarama kendiliğinden sürmez; kullanıcıya bildirilir", async () => {
    await setup();
    const off = await pausedScheduledRun("London", APP_STOPPED, { enabled: false });
    const gone = await pausedScheduledRun("Manchester", INTERRUPTED);
    await db.delete(scanSchedules).where(eq(scanSchedules.id, gone.scheduleId));
    await db.delete(jobs); // oluşturma anının işleri; yalnızca recover'ın ekledikleri sayılır
    const r = await new Worker({ db, workerId: "w", log: () => undefined }).recover();
    expect(r).toMatchObject({ resumedScheduled: 0, heldScheduled: 2, pausedManual: 0 });
    const rows = await db.select().from(scans);
    for (const id of [off.scanId, gone.scanId])
      expect(rows.find((s) => s.id === id)).toMatchObject({ status: "paused" });
    const runJobs = (await db.select().from(jobs)).filter((j) => j.type === "scan.run");
    expect(runJobs).toHaveLength(0);
    const ns = await db.select().from(notifications);
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ kind: "scan.paused" });
    expect(ns[0]!.params).toMatchObject({ n: 2 });
  });

  it("inceleme P2: Google anahtarı yoksa etkin zamanlamanın taraması da sürmez (tick'in kapıları)", async () => {
    await setup();
    const { scanId } = await pausedScheduledRun("London", APP_STOPPED);
    await setSetting(db, "places.provider", "google");
    const r = await new Worker({ db, workerId: "w", log: () => undefined }).recover();
    expect(r).toMatchObject({ resumedScheduled: 0, heldScheduled: 0 });
    expect((await db.select().from(scans).where(eq(scans.id, scanId)))[0]!.status).toBe("paused");
  });
});

describe("bakım turu döngüsü", () => {
  const ok = (errors: string[] = []): HousekeepingResult => ({
    coordinates: 0,
    cacheRows: 0,
    derivedFlags: 0,
    noveltyUpdated: 0,
    notificationsPruned: 0,
    enqueued: [],
    errors,
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("açılıştaki geçici hata (TRANSACTION_ACTIVE) kısa süre sonra yeniden denenir; 6 saat beklenmez", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("tx"), { code: "TRANSACTION_ACTIVE" });
    const run = vi.fn<() => Promise<HousekeepingResult>>().mockRejectedValueOnce(busy);
    run.mockResolvedValue(ok());
    const errors: unknown[] = [];
    const loop = startHousekeepingLoop({ run, onError: (e) => errors.push(e) });
    await loop.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([busy]);
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_RETRY_MS);
    await loop.idle();
    expect(run).toHaveBeenCalledTimes(2);
    // Başarılı turdan sonra yeniden deneme yok; sonraki tur düzenli aralıkta.
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_RETRY_MS * 5);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_INTERVAL_MS);
    await loop.idle();
    expect(run).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it("kalıcı hatalı adım düzenli turlar arasında en çok N kez yeniden denenir; durdurunca tur çalışmaz", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ok(["novelty"]));
    const loop = startHousekeepingLoop({ run, onError: () => undefined });
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_RETRY_MS * (HOUSEKEEPING_MAX_RETRIES + 3));
    await loop.idle();
    expect(run).toHaveBeenCalledTimes(1 + HOUSEKEEPING_MAX_RETRIES);
    loop.stop();
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(1 + HOUSEKEEPING_MAX_RETRIES);
  });

  it("turlar üst üste binmez: sürmekte olan tur varken düzenli tetik atlanır", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<HousekeepingResult>((r) => {
          release = () => r(ok());
        }),
    );
    const loop = startHousekeepingLoop({ run, onError: () => undefined });
    await vi.advanceTimersByTimeAsync(HOUSEKEEPING_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await loop.idle();
    loop.stop();
  });
});
