import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, jobs, leads, notifications, places, scans } from "@/lib/db/schema";
import { MockPlacesProvider } from "@/lib/places/mock";
import { runFutureWatch } from "@/lib/scan/future-watch";
import { loadNoveltyConfig } from "@/lib/scan/novelty-sync";
import { runScan, type RunnerDeps } from "@/lib/scan/runner";
import { onScanCompleted } from "@/lib/scan/scan-notifications";
import { DAY_MS, runDueSchedules, TICK_INTERVAL_MS } from "@/lib/scan/schedule";
import { createScheduleFromScan, getSchedule } from "@/lib/scan/schedule-service";
import { createAndStartScan } from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { runHousekeeping } from "@/worker/housekeeping";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * M1 kabul testi: saat enjeksiyonuyla 8 günlük işçi tick'leri (5 dk) benzetilir.
 *  - Zamanlanmış çalışmalar zamanında olur; tick'ler (≈2.000) fazladan tarama doğurmaz.
 *  - Uygulama kapalıyken kaçırılan pencereler TEK çalışmada birleşir (missed_runs).
 *  - Demo zamanı (M2) her çalışmada ilerler: yeni ve açılan işletmeler birikir.
 *  - Bildirimler tekildir (tarama başına bir; tekrar tetikleme çoğaltmaz).
 */
const START = Date.UTC(2026, 10, 2, 8, 0, 0);
let t: TestDb;
let db: Db;

const provider = () => new MockPlacesProvider({ getEpoch: () => getSetting(db, "mock.epoch") });

function deps(now: number): RunnerDeps {
  return {
    db,
    provider: provider(),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => loadNoveltyConfig(db),
    now: () => now,
    sleep: async () => undefined,
    minIntervalMs: 0,
    log: () => undefined,
  };
}

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
  await setSetting(db, "targets.countries", ["GB"]);
  await setSetting(db, "company.profile", {
    legalName: "Örnek A.Ş.",
    address: "Ankara",
    taxId: "1234567890",
    phone: "+90 312 000 00 00",
    contactName: "Ayşe Demir",
  });
  await setSetting(db, "consent", { version: "x", acceptedAt: START, name: "Ayşe Demir" });
  await setSetting(db, "setup.completed", true);
});
afterEach(async () => {
  await t.cleanup();
});

describe("M1: 8 günlük zamanlanmış tarama benzetimi", () => {
  it("zamanında çalışır, kaçırılanı birleştirir, yenileri biriktirir, bildirimleri tekilleştirir", async () => {
    // Temel tarama 21 gün önce; haftalık zamanlama o gün kuruldu. Uygulama iki hafta kapalı kaldı.
    const created = START - 21 * DAY_MS;
    const ids = (await db.select().from(categorySets))
      .filter((c) => ["cafe", "pub", "restaurant"].includes(c.key))
      .map((c) => c.id);
    const { scanId: baseScan } = await createAndStartScan(
      db,
      {
        region: {
          kind: "city",
          name: "London",
          countryCode: "GB",
          bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
        },
        categoryIds: ids,
      },
      created,
    );
    expect(await runScan(deps(created), baseScan)).toBe("completed");
    const baseLeads = (await db.select().from(leads)).length;
    const sched = await createScheduleFromScan(
      db,
      { fromScanId: baseScan, intervalDays: 7 },
      created,
    );
    expect(sched.nextRunAt).toBe(created + 7 * DAY_MS);

    const started: { scanId: number; at: number; missedRuns: number }[] = [];
    let lastDay = "";
    const closed = (now: number) => now >= START + 6 * DAY_MS && now < START + 8 * DAY_MS;
    let ticks = 0;
    for (let now = START; now <= START + 8 * DAY_MS; now += TICK_INTERVAL_MS) {
      if (closed(now)) continue; // uygulama kapalı (6. ve 7. gün)
      ticks++;
      const day = new Date(now).toISOString().slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        const hk = await runHousekeeping(db, { now });
        expect(hk.errors).toEqual([]);
        await runFutureWatch(
          {
            db,
            provider: provider(),
            getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
            getNoveltyConfig: () => loadNoveltyConfig(db),
            now: () => now,
            sleep: async () => undefined,
          },
          { everyDays: 7, maxPerRun: 100 },
        );
      }
      for (const r of await runDueSchedules(db, { now })) {
        expect(r.outcome).toBe("started");
        if (r.outcome !== "started") continue;
        started.push({ scanId: r.scanId, at: now, missedRuns: r.missedRuns });
        expect(await runScan(deps(now), r.scanId)).toBe("completed");
      }
    }
    expect(ticks).toBeGreaterThan(1500);

    // 1) İki zamanlanmış çalışma: açılışta (kaçırılan 2 pencere birleşik) ve 7. gün penceresi (8. gün açılışta).
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ at: START, missedRuns: 2 });
    expect(started[1]!.at).toBe(START + 8 * DAY_MS);
    const rows = await db.select().from(scans).where(eq(scans.origin, "schedule"));
    expect(rows.map((s) => s.scheduleSlot)).toEqual([created + 7 * DAY_MS, START + 7 * DAY_MS]);
    expect(rows.every((s) => s.status === "completed")).toBe(true);
    const s = await getSchedule(db, sched.id);
    expect(s).toMatchObject({ lastOutcome: "completed", nextRunAt: START + 15 * DAY_MS });

    // 2) M2: demo zamanı her çalışmada bir ilerledi; yeni ve açılan işletmeler birikti.
    expect(await getSetting(db, "mock.epoch")).toBe(2);
    const newPerScan = rows.map((r) => r.progress.newPlaces ?? 0);
    expect(newPerScan.every((n) => n > 0)).toBe(true);
    expect((await db.select().from(leads)).length).toBeGreaterThan(baseLeads);
    const opened = (await db.select().from(places)).filter((p) => p.openedDetectedAt !== null);
    expect(opened.length).toBeGreaterThan(0);

    // 3) Bildirimler: tarama başına tek scan.done; yeniden tetikleme çoğaltmaz.
    const before = await db.select().from(notifications);
    const done = before.filter((n) => n.kind === "scan.done");
    expect(done.map((n) => n.dedupeKey).sort()).toEqual(
      rows.map((r) => `scan.done:${r.id}`).sort(),
    );
    for (const r of rows)
      await onScanCompleted(
        db,
        { scanId: r.id, newDetected: 5, openedPlaces: 1, compared: true },
        START + 9 * DAY_MS,
      );
    expect(await db.select().from(notifications)).toHaveLength(before.length);
    expect(new Set(before.map((n) => n.dedupeKey)).size).toBe(before.length);

    // 4) Gün anahtarlı arka plan işleri açık geçen her gün bir kez kuruldu (M3 ile tekilleştirme çakışmaz).
    const watchJobs = await db.select().from(jobs).where(eq(jobs.type, "places.watch_future"));
    expect(watchJobs.length).toBe(8); // 2–8 Kasım (8 Kasım sabahı açık) ve 10 Kasım; 9 Kasım tamamen kapalı
    const startedAudits = (await db.select().from(auditLog)).filter(
      (a) => a.action === "schedule.started",
    );
    expect(startedAudits).toHaveLength(2);
  });
});
