import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schedulesRoute from "@/app/api/schedules/route";
import * as scheduleRoute from "@/app/api/schedules/[id]/route";
import * as runNowRoute from "@/app/api/schedules/[id]/run-now/route";
import * as statusRoute from "@/app/api/status/route";
import { recordUsage } from "@/lib/budget";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, jobs, notifications, scanSchedules, scans } from "@/lib/db/schema";
import { PlacesApiError } from "@/lib/places/errors";
import { renderNotification } from "@/lib/notifications/render";
import { MockPlacesProvider } from "@/lib/places/mock";
import type { SkuId } from "@/lib/domain/types";
import { marginalCostUsd, SKU_PRICING } from "@/lib/places/pricing";
import type { PlacesProvider } from "@/lib/places/provider";
import { readCostCap, runScan, type RunnerDeps } from "@/lib/scan/runner";
import {
  approvedCostCap,
  computeDue,
  DAY_MS,
  nextRunAfter,
  retryDelayMs,
  runDueSchedules,
  runSchedule,
  scheduleSummary,
  scheduleTick,
  SCHEDULE_TICK_JOB,
} from "@/lib/scan/schedule";
import { createScheduleFromScan, getSchedule } from "@/lib/scan/schedule-service";
import { createAndStartScan, pauseScan, resumeScan } from "@/lib/scan/service";
import { setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

async function completeSetup() {
  await setSetting(db, "places.provider", "mock");
  await setSetting(db, "targets.countries", ["GB", "NL"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek Ambalaj A.Ş.",
    address: "OSB 1. Cad. No:5 Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: T0, name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
}

async function cafeIds() {
  return (await db.select().from(categorySets)).filter((c) => c.key === "cafe").map((c) => c.id);
}

/** Tamamlanmış bir el ile tarama (zamanlamanın kaynağı). */
async function finishedScan(at = T0): Promise<number> {
  const { scanId } = await createAndStartScan(
    db,
    {
      region: {
        kind: "city",
        name: "London",
        countryCode: "GB",
        bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
      },
      categoryIds: await cafeIds(),
    },
    at,
  );
  await db.update(scans).set({ status: "completed", finishedAt: at }).where(eq(scans.id, scanId));
  await db.delete(jobs);
  return scanId;
}

async function makeSchedule(intervalDays: 7 | 14 | 30 = 7, at = T0) {
  const scanId = await finishedScan(at);
  const c = await createScheduleFromScan(db, { fromScanId: scanId, intervalDays }, at);
  return { scanId, ...c };
}

/** Zamanlamanın son taramasını bitmiş say (ACTIVE_SCAN olmadan sonraki çalışma için). */
async function finishScheduledScans() {
  await db
    .update(scans)
    .set({ status: "completed", finishedAt: T0 })
    .where(eq(scans.origin, "schedule"));
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
  await completeSetup();
});
afterEach(async () => {
  await t.cleanup();
});

describe("computeDue / nextRunAfter (saf)", () => {
  const s = { enabled: true, nextRunAt: T0, intervalDays: 7 as const };
  it("zamanı gelmeden çalışmaz; devre dışı hiç çalışmaz", () => {
    expect(computeDue(s, T0 - 1)).toEqual({ due: false, slot: T0, missedRuns: 0 });
    expect(computeDue({ ...s, enabled: false }, T0 + 30 * DAY_MS).due).toBe(false);
  });
  it("kaçırılan aralıklar sayılır, tek çalışmada birleşir", () => {
    expect(computeDue(s, T0)).toEqual({ due: true, slot: T0, missedRuns: 0 });
    expect(computeDue(s, T0 + 7 * DAY_MS - 1).missedRuns).toBe(0);
    expect(computeDue(s, T0 + 3 * 7 * DAY_MS + 5).missedRuns).toBe(3);
  });
  it("sonraki çalışma şimdi + aralık; yeniden deneme gecikmeleri", () => {
    expect(nextRunAfter(T0, 14)).toBe(T0 + 14 * DAY_MS);
    expect(retryDelayMs("ACTIVE_SCAN")).toBe(3_600_000);
    expect(retryDelayMs("BUDGET_BLOCKED")).toBe(DAY_MS);
  });
});

describe("runDueSchedules: çalıştırma, birleştirme, yarış", () => {
  it("zamanı gelince tek zamanlanmış tarama; köken, an, öncelik; M2 demo zamanı ilerler", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    expect(nextRunAt).toBe(T0 + 7 * DAY_MS);
    expect(await runDueSchedules(db, { now: nextRunAt - 1 })).toEqual([]);

    const now = nextRunAt + 1000;
    const [r] = await runDueSchedules(db, { now });
    expect(r).toMatchObject({ scheduleId: id, outcome: "started", missedRuns: 0 });
    const scan = (await db.select().from(scans).where(eq(scans.origin, "schedule")))[0]!;
    expect(scan).toMatchObject({ scheduleId: id, scheduleSlot: nextRunAt, status: "queued" });
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "scan.run"));
    expect(job).toMatchObject({ priority: 5 });
    const s = await getSchedule(db, id);
    expect(s).toMatchObject({
      nextRunAt: now + 7 * DAY_MS,
      lastRunAt: now,
      lastOutcome: "started",
      lastScanId: scan.id,
    });
    expect(await getSetting(db, "mock.epoch")).toBe(1);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["schedule.started", "demo.epoch"]));
  });

  it("uygulama 3 aralık kapalı kaldıysa tek tarama yapılır, missed_runs = 3", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const now = nextRunAt + 3 * 7 * DAY_MS + 3_600_000;
    const out = await runDueSchedules(db, { now });
    expect(out).toEqual([expect.objectContaining({ outcome: "started", missedRuns: 3 })]);
    expect(await db.select().from(scans).where(eq(scans.origin, "schedule"))).toHaveLength(1);
    expect((await getSchedule(db, id)).missedRuns).toBe(3);
    // Aynı tick tekrar: zamanı gelmemiş.
    expect(await runDueSchedules(db, { now: now + 60_000 })).toEqual([]);
  });

  it("aynı an (slot) için ikinci tarama tekil indeksle reddedilir; işlem geri alınır", async () => {
    // Eşzamanlı iki süreç (Next + worker) gerçekte ayrı bağlantılardır; burada CAS'ı geçmiş bir yarışı benzetiriz.
    const { id, nextRunAt } = await makeSchedule(7);
    const stale = await getSchedule(db, id);
    expect((await runSchedule(db, stale, nextRunAt + 1)).outcome).toBe("started");
    await finishScheduledScans();
    await db.update(scanSchedules).set({ nextRunAt }).where(eq(scanSchedules.id, id));
    expect((await runSchedule(db, stale, nextRunAt + 2)).outcome).toBe("lost");
    expect(await db.select().from(scans).where(eq(scans.origin, "schedule"))).toHaveLength(1);
    // İşlem geri alındı: CAS güncellemesi de uygulanmadı.
    expect((await getSchedule(db, id)).nextRunAt).toBe(nextRunAt);
  });

  it("varsayılan ön onay liste fiyatıdır: ücretsiz kota ay içinde bitse de çalışma atlanmaz", async () => {
    const { nextRunAt, ackMaxUsd } = await makeSchedule(7);
    expect(ackMaxUsd).toBeGreaterThan(0);
    await recordUsage(db, "mock", "text_search_pro", 5000);
    const [r] = await runDueSchedules(db, { now: nextRunAt + 1 });
    expect(r?.outcome).toBe("started");
  });

  it("aynı an için ikinci çalıştırma (eski satırla) kaybeder", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const stale = await getSchedule(db, id);
    const first = await runSchedule(db, stale, nextRunAt + 1);
    expect(first.outcome).toBe("started");
    await finishScheduledScans();
    expect((await runSchedule(db, stale, nextRunAt + 2)).outcome).toBe("lost");
  });

  it("demo zamanı yalnızca demo sağlayıcıda ilerler (Google'da asla)", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await setSetting(db, "places.provider", "google");
    await setSecret("google.placesKey", "AIza-test-key-not-real-000000000000");
    await db.update(scanSchedules).set({ ackMaxUsd: 1000 }).where(eq(scanSchedules.id, id));
    const [r] = await runDueSchedules(db, { now: nextRunAt + 1 });
    expect(r?.outcome).toBe("started");
    expect(await getSetting(db, "mock.epoch")).toBe(0);
  });
});

describe("runDueSchedules: atlama kodları ve bildirim tekilleştirme", () => {
  async function skipped(code: string) {
    const ns = await db.select().from(notifications);
    return ns.filter((n) => n.kind === "schedule.skipped" && n.dedupeKey.includes(`:${code}:`));
  }

  it("PREVIOUS_RUN_ACTIVE: zamanlamanın kendi taraması sürerken sessizce bir saat sonra yeniden denenir", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await runDueSchedules(db, { now: nextRunAt });
    const s = await getSchedule(db, id);
    const now = s.nextRunAt + 10;
    const [r] = await runDueSchedules(db, { now });
    expect(r).toMatchObject({
      outcome: "skipped",
      code: "PREVIOUS_RUN_ACTIVE",
      retryAt: now + 3_600_000,
    });
    expect(await getSchedule(db, id)).toMatchObject({
      lastOutcome: "skipped",
      lastSkipCode: "PREVIOUS_RUN_ACTIVE",
    });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("ACTIVE_SCAN: aynı anahtarla BAŞKA (elle) bir tarama sürerken atlanır ve bildirilir", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await finishedScan(); // aynı bölge + kategori
    await db.update(scans).set({ status: "running" }).where(eq(scans.origin, "manual"));
    const now = nextRunAt + 10;
    const [r] = await runDueSchedules(db, { now });
    expect(r).toMatchObject({ outcome: "skipped", code: "ACTIVE_SCAN", retryAt: now + 3_600_000 });
    expect(await getSchedule(db, id)).toMatchObject({ lastSkipCode: "ACTIVE_SCAN" });
    expect(await skipped("ACTIVE_SCAN")).toHaveLength(1);
  });

  it("BUDGET_BLOCKED: gün başına tek bildirim; ertesi gün yeni bildirim", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await setSetting(db, "budget.monthlyUsd", 0.5);
    await recordUsage(db, "mock", "text_search_pro", 5100);
    const now = nextRunAt + 1;
    const [r] = await runDueSchedules(db, { now });
    expect(r).toMatchObject({ outcome: "skipped", code: "BUDGET_BLOCKED", retryAt: now + DAY_MS });
    // Aynı gün yeniden zorla: bildirim çoğalmaz.
    await db.update(scanSchedules).set({ nextRunAt: now }).where(eq(scanSchedules.id, id));
    await runDueSchedules(db, { now: now + 60_000 });
    expect(await skipped("BUDGET_BLOCKED")).toHaveLength(1);
    await runDueSchedules(db, { now: now + DAY_MS + 60_000 });
    expect(await skipped("BUDGET_BLOCKED")).toHaveLength(2);
    expect(await db.select().from(scans).where(eq(scans.origin, "schedule"))).toHaveLength(0);
    const n = (await skipped("BUDGET_BLOCKED"))[0]!;
    expect(n).toMatchObject({ url: "/scans", entity: "schedule", entityId: String(id) });
  });

  it("M5 NEEDS_ACK: tahmin önceden onaylanan üst sınırı aşarsa arka planda atlanır", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await recordUsage(db, "mock", "text_search_pro", 5000); // ücretsiz kota bitti
    await db.update(scanSchedules).set({ ackMaxUsd: 0, ackAt: T0 }).where(eq(scanSchedules.id, id));
    const [r] = await runDueSchedules(db, { now: nextRunAt + 1 });
    expect(r).toMatchObject({ outcome: "skipped", code: "NEEDS_ACK" });
    expect(await skipped("NEEDS_ACK")).toHaveLength(1);
    // Etkileşimli "Şimdi çalıştır": kullanıcı oradadır, kural "Yeniden tara" ile aynıdır (kalan bütçe yeterliyse başlar).
    const s = await getSchedule(db, id);
    const ok = await runSchedule(db, s, nextRunAt + 3, { interactive: true });
    expect(ok.outcome).toBe("started");
  });

  it.each([
    [
      "CATEGORY_SET_MISSING",
      async (id: number) => {
        await db
          .update(scanSchedules)
          .set({ categorySetIds: [987654] })
          .where(eq(scanSchedules.id, id));
      },
    ],
    [
      "COUNTRY_NOT_TARGETED",
      async () => {
        await setSetting(db, "targets.countries", ["NL"]);
      },
    ],
    [
      "SETUP_REQUIRED",
      async () => {
        await setSetting(db, "consent", null);
      },
    ],
  ])("%s: tarama oluşmaz, atlama yazılır ve bildirilir", async (code, breakIt) => {
    const { id, nextRunAt } = await makeSchedule(7);
    await breakIt(id);
    const [r] = await runDueSchedules(db, { now: nextRunAt + 1 });
    expect(r).toMatchObject({ outcome: "skipped", code });
    expect((await getSchedule(db, id)).lastSkipCode).toBe(code);
    expect(await db.select().from(scans).where(eq(scans.origin, "schedule"))).toHaveLength(0);
    if (code !== "SETUP_REQUIRED") expect(await skipped(code)).toHaveLength(1);
  });
});

describe("tamamlanınca: sonuç ve bildirim", () => {
  it("zamanlanmış tarama bitince last_outcome = completed", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const [r] = await runDueSchedules(db, { now: nextRunAt + 1 });
    if (r?.outcome !== "started") throw new Error("başlamadı");
    const status = await runScan(
      {
        db,
        provider: new MockPlacesProvider({ getEpoch: () => 1 }),
        getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
        minIntervalMs: 0,
      },
      r.scanId,
    );
    expect(status).toBe("completed");
    expect((await getSchedule(db, id)).lastOutcome).toBe("completed");
  });
});

describe("scheduleTick: tekil tick işi", () => {
  it("kuyrukta tick varken ikinci eklenmez; pullForward zamanı öne çeker; exceptJobId", async () => {
    const a = await scheduleTick(db, { runAt: T0 + 300_000, now: T0 });
    expect(a).not.toBeNull();
    expect(await scheduleTick(db, { runAt: T0 + 600_000, now: T0 })).toBeNull();
    await scheduleTick(db, { runAt: T0, now: T0, pullForward: true });
    const rows = await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAt).toBe(T0);
    // Çalışan tick kendini hariç tutarak bir sonrakini planlar.
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, a!));
    const b = await scheduleTick(db, { runAt: T0 + 300_000, now: T0, exceptJobId: a! });
    expect(b).not.toBeNull();
    expect(await db.select().from(jobs).where(eq(jobs.type, SCHEDULE_TICK_JOB))).toHaveLength(2);
  });

  it("biten tick yeni tick'i engellemez (sabit tekilleştirme anahtarı yok)", async () => {
    const a = await scheduleTick(db, { runAt: T0, now: T0 });
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, a!));
    expect(await scheduleTick(db, { runAt: T0 + 1, now: T0 })).not.toBeNull();
  });
});

describe("HTTP: /api/schedules", () => {
  it("oluştur: 201, doğrulama 400, yok 404, ikinci 409 SCHEDULE_EXISTS, süren taramadan", async () => {
    const scanId = await finishedScan(Date.now() - 2 * DAY_MS);
    const bad = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: scanId, intervalDays: 10 }),
      undefined,
    );
    expect(bad.status).toBe(400);
    const extra = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: scanId, foo: 1 }),
      undefined,
    );
    expect(extra.status).toBe(400);
    const missing = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: 999 }),
      undefined,
    );
    expect(missing.status).toBe(404);
    expect((await json(missing)).code).toBe("SCAN_NOT_FOUND");

    const created = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: scanId, intervalDays: 7, maxCostUsd: 2.5 }),
      undefined,
    );
    expect(created.status).toBe(201);
    const c = await json(created);
    expect(c).toMatchObject({ ackMaxUsd: 2.5 });
    expect(c.nextRunAt).toBeGreaterThan(Date.now());

    const dup = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: scanId }),
      undefined,
    );
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ code: "SCHEDULE_EXISTS", scheduleId: c.id });

    const { scanId: queued } = await createAndStartScan(db, {
      region: {
        kind: "city",
        name: "Amsterdam",
        countryCode: "NL",
        bbox: { south: 52.35, west: 4.86, north: 52.39, east: 4.93 },
      },
      categoryIds: await cafeIds(),
    });
    // Süren tarama da tekrarlanabilir (oluşturucudaki onay kutusu): ilk çalışma tarama anı + aralık.
    const fromQueued = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: queued, intervalDays: 30 }),
      undefined,
    );
    expect(fromQueued.status).toBe(201);
    const q = await getSchedule(db, (await json(fromQueued)).id);
    expect(q).toMatchObject({ lastScanId: queued, lastOutcome: null });
    expect(q.nextRunAt).toBe(q.lastRunAt! + 30 * DAY_MS);

    const list = await json(await schedulesRoute.GET(req("GET", "/api/schedules"), undefined));
    expect(list.schedules).toHaveLength(2);
    expect(list.schedules[1]).toMatchObject({
      id: c.id,
      regionName: "London",
      intervalDays: 7,
      categories: expect.arrayContaining([expect.any(String)]),
    });
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["schedule.created", "schedule.authorized"]));
  });

  it("kurulum yoksa 403 SETUP_REQUIRED", async () => {
    const scanId = await finishedScan();
    await setSetting(db, "consent", null);
    const r = await schedulesRoute.POST(
      req("POST", "/api/schedules", { fromScanId: scanId }),
      undefined,
    );
    expect(r.status).toBe(403);
  });

  it("düzenle: aralık sonraki çalışmayı yeniden hesaplar; üst sınır ön onayı yeniler; boş gövde 400", async () => {
    const { id } = await makeSchedule(30, Date.now() - DAY_MS);
    const before = await getSchedule(db, id);
    const r = await scheduleRoute.PATCH(
      req("PATCH", `/api/schedules/${id}`, { intervalDays: 7, maxCostUsd: 1.234 }),
      params(id),
    );
    expect(r.status).toBe(200);
    const s = (await json(r)).schedule;
    expect(s.intervalDays).toBe(7);
    expect(s.nextRunAt).toBe(before.lastRunAt! + 7 * DAY_MS);
    expect(s.ackMaxUsd).toBe(1.23);
    const empty = await scheduleRoute.PATCH(req("PATCH", `/api/schedules/${id}`, {}), params(id));
    expect(empty.status).toBe(400);
    const off = await json(
      await scheduleRoute.PATCH(
        req("PATCH", `/api/schedules/${id}`, { enabled: false }),
        params(id),
      ),
    );
    expect(off.schedule.enabled).toBe(false);
    expect(
      (
        await scheduleRoute.PATCH(
          req("PATCH", "/api/schedules/999", { enabled: true }),
          params(999),
        )
      ).status,
    ).toBe(404);
  });

  it("şimdi çalıştır: 201, ikinci kez 409 ACTIVE_SCAN, bilinmeyen alan 400, yok 404", async () => {
    const { id } = await makeSchedule(7);
    const r = await runNowRoute.POST(req("POST", `/api/schedules/${id}/run-now`), params(id));
    expect(r.status).toBe(201);
    const { scanId } = await json(r);
    const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(scan).toMatchObject({ origin: "schedule", scheduleId: id });
    const again = await runNowRoute.POST(
      req("POST", `/api/schedules/${id}/run-now`, { acknowledgeRisk: true }),
      params(id),
    );
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("ACTIVE_SCAN");
    const bad = await runNowRoute.POST(
      req("POST", `/api/schedules/${id}/run-now`, { force: true }),
      params(id),
    );
    expect(bad.status).toBe(400);
    expect(
      (await runNowRoute.POST(req("POST", "/api/schedules/999/run-now"), params(999))).status,
    ).toBe(404);
  });

  it("sil: 204, zamanlama bildirimleri silinir, geçmiş taramalar kalır", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    await setSetting(db, "budget.monthlyUsd", 0.5);
    await recordUsage(db, "mock", "text_search_pro", 5100);
    await runDueSchedules(db, { now: nextRunAt + 1 });
    await setSetting(db, "budget.monthlyUsd", 1000);
    const s = await getSchedule(db, id);
    await runDueSchedules(db, { now: s.nextRunAt + 1 });
    expect(await db.select().from(notifications)).toHaveLength(1);
    const r = await scheduleRoute.DELETE(req("DELETE", `/api/schedules/${id}`), params(id));
    expect(r.status).toBe(204);
    expect(await db.select().from(scanSchedules)).toHaveLength(0);
    expect(await db.select().from(notifications)).toHaveLength(0);
    const kept = await db.select().from(scans).where(eq(scans.origin, "schedule"));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.scheduleId).toBeNull();
    expect(
      (await scheduleRoute.DELETE(req("DELETE", `/api/schedules/${id}`), params(id))).status,
    ).toBe(404);
  });

  it("durum: zamanlama özeti", async () => {
    const { nextRunAt } = await makeSchedule(7);
    expect(await scheduleSummary(db, nextRunAt - 1)).toEqual({ total: 1, due: 0, nextRunAt });
    expect((await scheduleSummary(db, nextRunAt)).due).toBe(1);
    const st = await json(await statusRoute.GET(req("GET", "/api/status"), undefined));
    expect(st.schedules).toMatchObject({ total: 1 });
  });
});

describe("kendi kendine duran zamanlanmış tarama zamanlamayı kilitlemez (inceleme P1)", () => {
  /** İlk `failCalls` çağrıda ağ hatası veren demo sağlayıcı. */
  function flaky(failCalls: number): PlacesProvider {
    const inner = new MockPlacesProvider({ getEpoch: () => 1 });
    let n = 0;
    return Object.assign(Object.create(inner) as PlacesProvider, {
      searchText: async (r: Parameters<PlacesProvider["searchText"]>[0]) => {
        if (n++ < failCalls) throw new PlacesApiError("network", "Ağ hatası (test)");
        return inner.searchText(r);
      },
    });
  }
  const runnerDeps = (provider: PlacesProvider, now: number): RunnerDeps => ({
    db,
    provider,
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    sleep: async () => undefined,
    minIntervalMs: 0,
    now: () => now,
  });
  const notifs = async (kind: string) =>
    (await db.select().from(notifications)).filter((n) => n.kind === kind);

  it("ağ hatasıyla duran tarama: durum yansır, tek bildirim, bir saat sonra kaldığı yerden sürer (ACTIVE_SCAN döngüsü yok)", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const t1 = nextRunAt + 5;
    const [first] = await runDueSchedules(db, { now: t1 });
    expect(first?.outcome).toBe("started");
    const scanId = (first as { scanId: number }).scanId;
    expect(await runScan(runnerDeps(flaky(1), t1), scanId)).toBe("paused");
    const [paused] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(paused).toMatchObject({ status: "paused", pauseCode: "PROVIDER_NETWORK" });
    expect(await getSchedule(db, id)).toMatchObject({
      lastOutcome: "skipped",
      lastSkipCode: "SCAN_RETRYING",
      nextRunAt: t1 + 3_600_000,
    });
    const p = await notifs("scan.paused");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ url: "/scans", entity: "scan", entityId: String(scanId) });
    expect(p[0]!.params).toMatchObject({ code: "SCAN_RETRYING", region: "London" });

    // Bir saat sonra: yeni tarama açılmaz, aynı tarama sürdürülür.
    const t2 = t1 + 3_600_000;
    const [r] = await runDueSchedules(db, { now: t2 });
    expect(r).toMatchObject({ outcome: "resumed", scanId });
    const [resumed] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(resumed).toMatchObject({ status: "queued", pauseCode: null });
    const runJobs = (await db.select().from(jobs)).filter(
      (j) => j.type === "scan.run" && j.status === "queued",
    );
    expect(runJobs.map((j) => (j.payload as { scanId: number }).scanId)).toContain(scanId);
    expect(await getSchedule(db, id)).toMatchObject({
      lastOutcome: "started",
      lastSkipCode: null,
      nextRunAt: t2 + 7 * DAY_MS,
    });
    // Aynı an için ikinci tick hiçbir şey yapmaz (CAS); iş çoğalmaz.
    expect(await runDueSchedules(db, { now: t2 + 1 })).toEqual([]);
    expect(await notifs("schedule.skipped")).toHaveLength(0);

    expect(await runScan(runnerDeps(flaky(0), t2), scanId)).toBe("completed");
    expect(await getSchedule(db, id)).toMatchObject({ lastOutcome: "completed" });
    expect(await db.select().from(scans).where(eq(scans.origin, "schedule"))).toHaveLength(1);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("schedule.resumed");
  });

  it("bütçe durdurdu: bütçe engelliyken SCAN_BUDGET_STOPPED ile atlanır; bütçe artınca kaldığı yerden sürer", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const t1 = nextRunAt + 5;
    const [first] = await runDueSchedules(db, { now: t1 });
    const scanId = (first as { scanId: number }).scanId;
    await setSetting(db, "budget.monthlyUsd", 0.5);
    await recordUsage(db, "mock", "text_search_pro", 5100);
    expect(await runScan(runnerDeps(flaky(0), t1), scanId)).toBe("budget_stopped");
    expect(await getSchedule(db, id)).toMatchObject({
      lastOutcome: "skipped",
      lastSkipCode: "SCAN_BUDGET_STOPPED",
      nextRunAt: t1 + DAY_MS,
    });
    expect((await notifs("scan.paused"))[0]!.params).toMatchObject({
      code: "SCAN_BUDGET_STOPPED",
    });

    const t2 = t1 + DAY_MS;
    const [blocked] = await runDueSchedules(db, { now: t2 });
    expect(blocked).toMatchObject({
      outcome: "skipped",
      code: "SCAN_BUDGET_STOPPED",
      retryAt: t2 + DAY_MS,
    });
    expect(await notifs("schedule.skipped")).toHaveLength(1);

    await setSetting(db, "budget.monthlyUsd", 1000);
    const [r] = await runDueSchedules(db, { now: t2 + DAY_MS });
    expect(r).toMatchObject({ outcome: "resumed", scanId });
  });

  it("H: kendiliğinden sürdürmeler onaylı toplam maliyeti aşamaz; elle sürdürme tavanı kaldırır", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const t1 = nextRunAt + 5;
    const [first] = await runDueSchedules(db, { now: t1 });
    const scanId = (first as { scanId: number }).scanId;
    const [created] = await db.select().from(scans).where(eq(scans.id, scanId));
    const est = created!.estimate as { sku: SkuId; costUsd: { high: number }; costCapUsd: number };
    const sched = await getSchedule(db, id);
    // Tavan tarama oluşturulurken yazılır: onaylı tutar ile yüksek tahminin büyüğü.
    expect(est.costCapUsd).toBe(approvedCostCap(sched.ackMaxUsd, est.costUsd.high));
    expect(est.costCapUsd).toBeGreaterThanOrEqual(est.costUsd.high);

    // Ücretsiz kota bu ay bitmiş: her çağrı ücretli. Tahminin üstüne çıkan bir taramayı taklit etmek için tavanı
    // yaklaşık iki çağrılık tutara indiriyoruz; tarama ise her ikinci çağrıda geçici ağ hatası alıp kendiliğinden sürer.
    const free = SKU_PRICING[est.sku].freeMonthly;
    await recordUsage(db, "mock", est.sku, free, t1); // ücretsiz kota içinde: maliyet 0, bütçe etkilenmez
    const perCall = marginalCostUsd(est.sku, free, 1);
    expect(perCall).toBeGreaterThan(0);
    const cap = Math.round(perCall * 2.5 * 10_000) / 10_000;
    await db
      .update(scans)
      .set({ estimate: { ...est, costCapUsd: cap } })
      .where(eq(scans.id, scanId));
    const inner = new MockPlacesProvider({ getEpoch: () => 1 });
    let n = 0;
    const everyOtherFails = Object.assign(Object.create(inner) as PlacesProvider, {
      searchText: async (r: Parameters<PlacesProvider["searchText"]>[0]) => {
        if (n++ % 2 === 1) throw new PlacesApiError("network", "Ağ hatası (test)");
        return inner.searchText(r);
      },
    });

    let now = t1;
    let outcome = await runScan(runnerDeps(everyOtherFails, now), scanId);
    for (let i = 0; i < 30 && outcome === "paused"; i++) {
      const [row] = await db.select().from(scans).where(eq(scans.id, scanId));
      if (row!.pauseCode !== "PROVIDER_NETWORK") break;
      now += 3_600_000;
      const [r] = await runDueSchedules(db, { now });
      expect(r).toMatchObject({ outcome: "resumed", scanId });
      outcome = await runScan(runnerDeps(everyOtherFails, now), scanId);
    }
    const [stopped] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(stopped).toMatchObject({ status: "paused", pauseCode: "COST_CAP" });
    // Birikimli maliyet tavanı aşmaz (kendiliğinden sürdürmelerin hepsi dahil) ve tavana bir çağrı yakındır.
    expect(stopped!.costUsd).toBeLessThanOrEqual(cap + 1e-9);
    expect(stopped!.costUsd).toBeGreaterThan(cap - perCall - 1e-9);
    expect(stopped!.pauseReason).toContain(cap.toFixed(2));
    // Tavan kendiliğinden sürdürülmez: zamanlama kullanıcıya sorar.
    expect(await getSchedule(db, id)).toMatchObject({ lastSkipCode: "SCAN_PAUSED" });
    const [again] = await runDueSchedules(db, { now: now + DAY_MS });
    expect(again).toMatchObject({ outcome: "skipped", code: "SCAN_PAUSED" });
    expect((await db.select().from(scans).where(eq(scans.id, scanId)))[0]!.status).toBe("paused");

    // Kullanıcının elle "Devam et"i açık onaydır: tavan bu tarama için kalkar ve tarama biter.
    expect(await resumeScan(db, scanId)).toEqual({ ok: true });
    const [lifted] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect((lifted!.estimate as { costCapUsd: unknown }).costCapUsd).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain(
      "scan.cost_cap_lifted",
    );
    expect(await runScan(runnerDeps(flaky(0), now + DAY_MS), scanId)).toBe("completed");
  });

  it("H: tavan yalnızca zamanlanmış taramada geçerlidir; elle başlatılan taramada yoktur", async () => {
    const manual = await finishedScan();
    const [m] = await db.select().from(scans).where(eq(scans.id, manual));
    expect((m!.estimate as { costCapUsd?: unknown }).costCapUsd).toBeUndefined();
    expect(readCostCap(m!)).toBeNull();
    expect(readCostCap({ origin: "schedule", estimate: { costCapUsd: 2.5 } })).toBe(2.5);
    expect(readCostCap({ origin: "schedule", estimate: { costCapUsd: null } })).toBeNull();
    expect(readCostCap({ origin: "manual", estimate: { costCapUsd: 2.5 } })).toBeNull();
    expect(approvedCostCap(null, 1.234)).toBe(1.24);
    expect(approvedCostCap(5, 1.2)).toBe(5);
  });

  it("kullanıcı duraklattıysa kendiliğinden sürmez: SCAN_PAUSED, günde bir hatırlatma", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const [first] = await runDueSchedules(db, { now: nextRunAt });
    const scanId = (first as { scanId: number }).scanId;
    expect(await pauseScan(db, scanId)).toEqual({ ok: true });
    const s = await getSchedule(db, id);
    const now = s.nextRunAt + 1;
    const [r] = await runDueSchedules(db, { now });
    expect(r).toMatchObject({ outcome: "skipped", code: "SCAN_PAUSED", retryAt: now + DAY_MS });
    const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(scan?.status).toBe("paused");
    const n = await notifs("schedule.skipped");
    expect(n).toHaveLength(1);
    expect(n[0]!.params).toMatchObject({ code: "SCAN_PAUSED" });
  });

  it("geçici hatayla duran ama kurulum eksikse sürdürülmez, kapı koduyla atlanır", async () => {
    const { id, nextRunAt } = await makeSchedule(7);
    const [first] = await runDueSchedules(db, { now: nextRunAt });
    const scanId = (first as { scanId: number }).scanId;
    await db
      .update(scans)
      .set({ status: "paused", pauseCode: "PROVIDER_RATE" })
      .where(eq(scans.id, scanId));
    await setSetting(db, "consent", null);
    const s = await getSchedule(db, id);
    const [r] = await runDueSchedules(db, { now: s.nextRunAt + 1 });
    expect(r).toMatchObject({ outcome: "skipped", code: "SETUP_REQUIRED" });
    const [scan] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(scan?.status).toBe("paused");
  });

  it("elle başlatılan taramanın durması zamanlamaya ve bildirimlere dokunmaz", async () => {
    const scanId = await finishedScan();
    await db.update(scans).set({ status: "queued" }).where(eq(scans.id, scanId));
    expect(await runScan(runnerDeps(flaky(1), T0), scanId)).toBe("paused");
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

describe("duraklayan zamanlanmış tarama bildirim metinleri", () => {
  const r = (
    kind: "scan.paused" | "schedule.skipped",
    params: Record<string, string | number>,
  ) => ({
    tr: renderNotification({ kind, params }, "tr"),
    en: renderNotification({ kind, params }, "en"),
  });
  it("neden koduna göre sade metin; bölge başlıkta; kodsuz eski metin korunur", () => {
    const retry = r("scan.paused", { n: 1, code: "SCAN_RETRYING", region: "London" });
    expect(retry.tr.title).toBe("London taraması duraklatıldı");
    expect(retry.tr.body).toContain("bir saat");
    expect(retry.en.body).toContain("within an hour");
    expect(r("scan.paused", { code: "SCAN_BUDGET_STOPPED" }).tr).toMatchObject({
      title: "Tarama duraklatıldı",
      body: expect.stringContaining("bütçe"),
    });
    expect(r("scan.paused", { code: "SCAN_PAUSED" }).en.body).toContain("safety limit");
    expect(r("scan.paused", { n: 2 }).tr.body).toContain("2 tarama");
    expect(r("schedule.skipped", { code: "SCAN_PAUSED" }).tr.body).toContain("sürdürün");
    expect(r("schedule.skipped", { code: "SCAN_BUDGET_STOPPED" }).en.body).toContain("budget");
  });
});
