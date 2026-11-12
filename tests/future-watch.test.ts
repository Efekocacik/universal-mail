import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { apiUsage, auditLog, categorySets, notifications, places } from "@/lib/db/schema";
import type { PlaceRecord } from "@/lib/domain/types";
import { PlacesApiError } from "@/lib/places/errors";
import type { DetailsResult, PlacesProvider } from "@/lib/places/provider";
import { backgroundPrecheck } from "@/lib/scan/background";
import { dueFutureWatch, runFutureWatch, type FutureWatchDeps } from "@/lib/scan/future-watch";
import { uniqueViolationOn } from "@/lib/scan/db-errors";
import { createAndStartScan } from "@/lib/scan/service";
import { persistPlaces } from "@/lib/scan/store";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
let t: TestDb;
let db: Db;

type Answer = string | null | PlacesApiError;
function stub(answers: Record<string, Answer>): PlacesProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "mock",
    pageSize: 20,
    maxTextResults: 60,
    maxNearbyResults: 20,
    calls,
    searchText: async () => ({ places: [], sku: "text_search_pro" }),
    searchNearby: async () => ({ places: [], sku: "nearby_search_pro" }),
    async getDetails(id: string, fields: readonly string[]): Promise<DetailsResult> {
      calls.push(`${id}:${fields.join(",")}`);
      const a = answers[id];
      if (a instanceof PlacesApiError) throw a;
      if (a === null || a === undefined) return { place: null, sku: "place_details_pro", id: null };
      // Google gibi: konum istenmediği için tam kayıt yok, yalnızca kimlik ve durum.
      return { place: null, sku: "place_details_pro", id, businessStatus: a };
    },
  };
}

const rec = (placeId: string, businessStatus?: string): PlaceRecord => ({
  placeId,
  source: "demo",
  name: "x",
  lat: 51.5,
  lng: -0.12,
  types: ["cafe"],
  businessStatus,
});

async function seedFuture(ids: string[], at = T0) {
  const cat = (await db.select().from(categorySets)).find((c) => c.key === "cafe")!;
  const { scanId } = await createAndStartScan(
    db,
    {
      region: {
        kind: "city",
        name: "London",
        countryCode: "GB",
        bbox: { south: 51.49, west: -0.15, north: 51.53, east: -0.09 },
      },
      categoryIds: [cat.id],
    },
    at,
  );
  await persistPlaces(
    db,
    scanId,
    ids.map((id) => rec(id, "FUTURE_OPENING")),
    at,
  );
}

function deps(provider: PlacesProvider, now: number, over: Partial<FutureWatchDeps> = {}) {
  return {
    db,
    provider,
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    now: () => now,
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...over,
  } satisfies FutureWatchDeps;
}

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
});
afterEach(async () => {
  await t.cleanup();
});

describe("dueFutureWatch", () => {
  it("yalnızca everyDays'ten eski, kapanmamış, kaybolmamış yakında açılacaklar", async () => {
    await seedFuture(["a", "b", "c"]);
    await db.update(places).set({ goneAt: T0 }).where(eq(places.placeId, "c"));
    expect(await dueFutureWatch(db, { now: T0 + 6 * DAY, everyDays: 7, limit: 10 })).toEqual([]);
    expect(
      (await dueFutureWatch(db, { now: T0 + 8 * DAY, everyDays: 7, limit: 10 })).sort(),
    ).toEqual(["a", "b"]);
    expect(await dueFutureWatch(db, { now: T0 + 8 * DAY, everyDays: 7, limit: 1 })).toHaveLength(1);
  });
});

describe("runFutureWatch", () => {
  it("açılan, hâlâ yakında, kaybolan; yalnız id,businessStatus istenir; tek toplu bildirim", async () => {
    await seedFuture(["open1", "open2", "wait", "gone", "nf"]);
    const p = stub({
      open1: "OPERATIONAL",
      open2: "OPERATIONAL",
      wait: "FUTURE_OPENING",
      gone: null,
      nf: new PlacesApiError("not_found", "yok", { status: 404 }),
    });
    const now = T0 + 8 * DAY;
    const r = await runFutureWatch(deps(p, now), { everyDays: 7, maxPerRun: 50 });
    expect(r).toEqual({ checked: 5, opened: 2, stillFuture: 1, gone: 2 });
    expect(p.calls.every((c) => c.endsWith(":id,businessStatus"))).toBe(true);

    const by = new Map((await db.select().from(places)).map((x) => [x.placeId, x]));
    expect(by.get("open1")).toMatchObject({
      wasFuture: false,
      openedDetectedAt: now,
      statusCheckedAt: now,
    });
    expect(by.get("wait")).toMatchObject({ wasFuture: true, statusCheckedAt: now });
    expect(by.get("gone")!.goneAt).toBe(now);
    expect(by.get("nf")!.goneAt).toBe(now);

    const ns = await db.select().from(notifications);
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({
      kind: "place.opened",
      dedupeKey: "place.opened:watch:2026-11-09",
    });
    expect(ns[0]!.url).toBe(`/?lifecycle=opened&detectedSince=${now - DAY}`);
    expect(
      (await db.select().from(auditLog)).some((a) => a.action === "places.future_watched"),
    ).toBe(true);
    const usage = await db.select().from(apiUsage);
    expect(usage.reduce((n, u) => n + u.calls, 0)).toBe(4); // NOT_FOUND faturalanmaz

    // İdempotent: aynı gün yeniden çalıştırma denetlenecek yer bulmaz, bildirim çoğalmaz.
    const again = await runFutureWatch(deps(p, now + 60_000), { everyDays: 7, maxPerRun: 50 });
    expect(again.checked).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("bütçe dolunca erken durur; kota hatası turu bitirir", async () => {
    await seedFuture(["a", "b"]);
    await setSetting(db, "budget.monthlyUsd", 0.01);
    await recordUsage(db, "mock", "place_details_pro", 6000, T0);
    const p = stub({ a: "OPERATIONAL", b: "OPERATIONAL" });
    const r = await runFutureWatch(deps(p, T0 + 8 * DAY), { everyDays: 7, maxPerRun: 10 });
    expect(r).toMatchObject({ checked: 0, stoppedReason: "BUDGET_BLOCKED" });
    expect(p.calls).toHaveLength(0);

    await setSetting(db, "budget.monthlyUsd", 1000);
    const q = stub({ a: new PlacesApiError("quota", "kota", { status: 429 }), b: "OPERATIONAL" });
    const r2 = await runFutureWatch(deps(q, T0 + 8 * DAY), { everyDays: 7, maxPerRun: 10 });
    expect(r2).toMatchObject({ checked: 0, stoppedReason: "quota" });
    expect(q.calls).toHaveLength(1);
  });

  it("durdurma isteğine uyar; beklenmeyen hata fırlatılır", async () => {
    await seedFuture(["a"]);
    const r = await runFutureWatch(
      deps(stub({ a: "OPERATIONAL" }), T0 + 8 * DAY, { shouldStop: () => true }),
      {
        everyDays: 7,
        maxPerRun: 10,
      },
    );
    expect(r.stoppedReason).toBe("stopped");
    const bad = stub({});
    bad.getDetails = async () => {
      throw new TypeError("bozuk");
    };
    await expect(
      runFutureWatch(deps(bad, T0 + 8 * DAY), { everyDays: 7, maxPerRun: 10 }),
    ).rejects.toThrow("bozuk");
  });
});

describe("backgroundPrecheck", () => {
  it("onay yoksa CONSENT_REQUIRED; Google anahtarı yoksa PLACES_KEY_MISSING; gün başına tek bildirim", async () => {
    const r = await backgroundPrecheck(db, "watch_future", { now: T0 });
    expect(r).toEqual({ ok: false, code: "CONSENT_REQUIRED" });
    await backgroundPrecheck(db, "watch_future", { now: T0 + 1000 });
    expect(await db.select().from(notifications)).toHaveLength(1);

    await setSetting(db, "consent", { version: "x", acceptedAt: T0, name: "Ayşe" });
    await setSetting(db, "places.provider", "google");
    expect(await backgroundPrecheck(db, "refresh_ids", { now: T0 })).toEqual({
      ok: false,
      code: "PLACES_KEY_MISSING",
    });
    await setSetting(db, "places.provider", "mock");
    expect(await backgroundPrecheck(db, "refresh_ids", { now: T0 })).toEqual({ ok: true });
    await setSetting(db, "budget.monthlyUsd", 0.01);
    await recordUsage(db, "mock", "text_search_pro", 6000, T0);
    expect(await backgroundPrecheck(db, "refresh_ids", { now: T0 })).toMatchObject({
      code: "BUDGET_BLOCKED",
    });
    const keys = (await db.select().from(notifications)).map((n) => n.dedupeKey).sort();
    expect(keys).toEqual([
      "background.skipped:refresh_ids:BUDGET_BLOCKED:2026-11-01",
      "background.skipped:refresh_ids:PLACES_KEY_MISSING:2026-11-01",
      "background.skipped:watch_future:CONSENT_REQUIRED:2026-11-01",
    ]);
  });
});

describe("uniqueViolationOn", () => {
  it("cause zincirinde arar", () => {
    const inner = new Error("UNIQUE constraint failed: scans.schedule_id, scans.schedule_slot");
    const outer = new Error("Failed query: insert …", { cause: { message: "x", cause: inner } });
    expect(uniqueViolationOn(outer, /scans\.schedule_id/)).toBe(true);
    expect(uniqueViolationOn(outer, /scan_schedules\.scan_key/)).toBe(false);
    expect(uniqueViolationOn(null, /x/)).toBe(false);
  });
});
