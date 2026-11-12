import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import {
  auditLog,
  categorySets,
  jobs,
  notifications,
  places,
  scanSchedules,
  scanUnits,
  scans,
} from "@/lib/db/schema";
import type { PlaceRecord } from "@/lib/domain/types";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { recordUsage } from "@/lib/budget";
import { classifyGoogleError, PlacesApiError } from "@/lib/places/errors";
import { MockPlacesProvider } from "@/lib/places/mock";
import type { PlacesProvider } from "@/lib/places/provider";
import { enrichPlaces } from "@/lib/scan/enrich";
import { checkCollectionReady, checkPaidScan, ScanGateError } from "@/lib/scan/gates";
import { runScan, type RunnerDeps } from "@/lib/scan/runner";
import { onScanFailed } from "@/lib/scan/scan-notifications";
import {
  createAndStartScan,
  insertPreparedScan,
  prepareScan,
  type ScanRequest,
} from "@/lib/scan/service";
import { statusFlags } from "@/lib/scan/status-flags";
import { persistPlaces } from "@/lib/scan/store";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let db: Db;
let epoch = 0;
const box = bboxFromCenter(51.5085, -0.1257, 3.5);

async function req(keys = ["cafe"]): Promise<ScanRequest> {
  const rows = await db.select().from(categorySets);
  return {
    region: { kind: "city", name: "London", countryCode: "GB", bbox: box },
    categoryIds: rows.filter((r) => keys.includes(r.key)).map((r) => r.id),
  };
}

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    db,
    provider: new MockPlacesProvider({ getEpoch: () => epoch }),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...over,
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

beforeEach(async () => {
  epoch = 0;
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
});
afterEach(async () => {
  await t.cleanup();
});

describe("statusFlags (açılış geçişi hata düzeltmesi)", () => {
  const fut = { wasFuture: true, isClosed: false };
  it("yalnızca FUTURE_OPENING → OPERATIONAL açılış sayılır", () => {
    expect(statusFlags("OPERATIONAL", fut)).toEqual({
      wasFuture: false,
      isClosed: false,
      opened: true,
      observed: true,
    });
    expect(statusFlags("OPERATIONAL", { wasFuture: false, isClosed: false }).opened).toBe(false);
    expect(statusFlags("CLOSED_PERMANENTLY", fut)).toMatchObject({ isClosed: true, opened: false });
  });
  it("CLOSED_TEMPORARILY açılış değildir ve izlemeyi korur", () => {
    expect(statusFlags("CLOSED_TEMPORARILY", fut)).toEqual({
      wasFuture: true,
      isClosed: false,
      opened: false,
      observed: true,
    });
  });
  it("eksik durum hiçbir bayrağı değiştirmez", () => {
    expect(statusFlags(undefined, fut)).toEqual({ ...fut, opened: false, observed: false });
    expect(statusFlags(null, null)).toEqual({
      wasFuture: false,
      isClosed: false,
      opened: false,
      observed: false,
    });
  });
});

describe("persistPlaces: durum bayrakları", () => {
  it("gerçek tarama üzerinde bayraklar ve status_checked_at", async () => {
    const { scanId } = await createAndStartScan(db, await req(), 1_000);
    await persistPlaces(
      db,
      scanId,
      [
        rec("a", "FUTURE_OPENING"),
        rec("b", "FUTURE_OPENING"),
        rec("c", "FUTURE_OPENING"),
        rec("d", "FUTURE_OPENING"),
      ],
      1_000,
    );
    const res = await persistPlaces(
      db,
      scanId,
      [
        rec("a", "OPERATIONAL"),
        rec("b", "CLOSED_TEMPORARILY"),
        rec("c"),
        rec("d", "CLOSED_PERMANENTLY"),
      ],
      2_000,
    );
    expect(res.openedIds).toEqual(["a"]);
    const by = new Map((await db.select().from(places)).map((p) => [p.placeId, p]));
    expect(by.get("a")).toMatchObject({
      wasFuture: false,
      openedDetectedAt: 2_000,
      statusCheckedAt: 2_000,
    });
    expect(by.get("b")).toMatchObject({ wasFuture: true, openedDetectedAt: null });
    // Eksik durum: bayrak korunur, gözlem zamanı ilerlemez, açılış yok.
    expect(by.get("c")).toMatchObject({
      wasFuture: true,
      openedDetectedAt: null,
      statusCheckedAt: 1_000,
    });
    expect(by.get("d")).toMatchObject({ isClosed: true, wasFuture: false, openedDetectedAt: null });
  });
});

describe("createAndStartScan: işlem ve ACTIVE_SCAN", () => {
  it("aynı anahtarla etkin tarama varken ikincisi reddedilir", async () => {
    const r = await req();
    await createAndStartScan(db, r);
    await expect(createAndStartScan(db, r)).rejects.toBeInstanceOf(ScanGateError);
    await expect(createAndStartScan(db, r)).rejects.toMatchObject({ code: "ACTIVE_SCAN" });
    expect((await db.select().from(scans)).length).toBe(1);
  });

  it("birim eklenirken hata olursa kuyrukta birimsiz tarama ve iş KALMAZ", async () => {
    const p = await prepareScan(db, await req());
    const broken = { ...p, units: [{ ...p.units[0]!, term: null as unknown as string }] };
    await expect(db.transaction((tx) => insertPreparedScan(tx, broken))).rejects.toThrow();
    expect(await db.select().from(scans)).toHaveLength(0);
    expect(await db.select().from(scanUnits)).toHaveLength(0);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("tarama, birimler, iş ve denetim kaydı birlikte yazılır; köken ve öncelik", async () => {
    const { scanId } = await createAndStartScan(db, await req());
    const [s] = await db.select().from(scans).where(eq(scans.id, scanId));
    expect(s).toMatchObject({ origin: "manual", scheduleId: null, scheduleSlot: null });
    const [j] = await db.select().from(jobs);
    expect(j).toMatchObject({ type: "scan.run", priority: 10 });
    expect((await db.select().from(auditLog)).some((a) => a.action === "scan.created")).toBe(true);
  });
});

describe("runner: açılan işletmeler ve bildirimler", () => {
  it("openedPlaces ilerlemeye yazılır; scan.done ve place.opened tarama başına bir kez", async () => {
    const first = await createAndStartScan(db, await req(["cafe", "pub"]));
    expect(await runScan(deps(), first.scanId)).toBe("completed");
    // İlk (temel) tarama: bildirim yok.
    expect(await db.select().from(notifications)).toHaveLength(0);

    epoch = 3;
    const second = await createAndStartScan(db, await req(["cafe", "pub"]));
    expect(await runScan(deps(), second.scanId)).toBe("completed");
    const [s2] = await db.select().from(scans).where(eq(scans.id, second.scanId));
    const opened = (await db.select().from(places)).filter((p) => p.openedDetectedAt !== null);
    expect(s2!.progress.openedPlaces).toBe(opened.length);
    expect(opened.length).toBeGreaterThan(0);

    const rows = await db.select().from(notifications);
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["place.opened", "scan.done"]);
    const done = rows.find((r) => r.kind === "scan.done")!;
    expect(done.params).toMatchObject({ n: s2!.progress.newPlaces, region: "London" });
    expect(done.url).toBe(`/?scan=${second.scanId}&lifecycle=new`);
    // Parametrelerde Google içeriği yok (işletme adı vb.).
    expect(JSON.stringify(rows.map((r) => r.params))).not.toMatch(/Coffee|Pub|Street/);

    // Yeniden işleme (tamamlanmış tarama) bildirim çoğaltmaz.
    await runScan(deps(), second.scanId);
    expect(await db.select().from(notifications)).toHaveLength(2);
  });

  it("zamanlanmış tarama başarısız olunca scan.failed bildirimi; elle taramada yok", async () => {
    const manual = await createAndStartScan(db, await req());
    await onScanFailed(db, manual.scanId, 5);
    expect(await db.select().from(notifications)).toHaveLength(0);

    const [region] = await db.select({ id: scans.regionId }).from(scans);
    const now = 10_000;
    const [sch] = await db
      .insert(scanSchedules)
      .values({
        regionId: region!.id,
        scanKey: "k-sched",
        categorySetIds: [],
        strategy: "text",
        fieldProfile: "discovery",
        intervalDays: 7,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [s] = await db
      .insert(scans)
      .values({
        regionId: region!.id,
        scanKey: "k-sched",
        categorySetIds: [],
        queries: [],
        strategy: "text",
        fieldProfile: "discovery",
        provider: "mock",
        status: "failed",
        createdAt: now,
        origin: "schedule",
        scheduleId: sch!.id,
        scheduleSlot: now,
      })
      .returning();
    await db.update(scanSchedules).set({ lastScanId: s!.id }).where(eq(scanSchedules.id, sch!.id));
    await onScanFailed(db, s!.id, now);
    await onScanFailed(db, s!.id, now);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "scan.failed", url: "/scans" });
    const [after] = await db.select().from(scanSchedules);
    expect(after!.lastOutcome).toBe("failed");
  });
});

describe("Google NOT_FOUND ve eskimiş yer kimliği", () => {
  it("404 / NOT_FOUND ayrı bir tür; 400 hâlâ invalid", () => {
    const nf = classifyGoogleError(404, { error: { status: "NOT_FOUND", message: "Not found" } });
    expect(nf.kind).toBe("not_found");
    expect(nf.isPausable).toBe(false);
    expect(nf.isRetryable).toBe(false);
    expect(classifyGoogleError(400, { error: { status: "NOT_FOUND" } }).kind).toBe("not_found");
    expect(classifyGoogleError(400, { error: { message: "bad" } }).kind).toBe("invalid");
  });

  it("enrichPlaces NOT_FOUND'da yeri gone_at ile işaretler, lead'i silmez", async () => {
    const { scanId } = await createAndStartScan(db, await req());
    await persistPlaces(db, scanId, [rec("gone-1", "OPERATIONAL")], 1_000);
    const provider: PlacesProvider = {
      ...new MockPlacesProvider({ getEpoch: () => 0 }),
      id: "mock",
      pageSize: 20,
      maxTextResults: 60,
      maxNearbyResults: 20,
      searchText: async () => ({ places: [], sku: "text_search_pro" }),
      searchNearby: async () => ({ places: [], sku: "nearby_search_pro" }),
      getDetails: async () => {
        throw classifyGoogleError(404, { error: { status: "NOT_FOUND" } });
      },
    };
    const res = await enrichPlaces(
      {
        db,
        provider,
        getBudgetUsd: async () => 30,
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
        now: () => 5_000,
      },
      ["gone-1"],
      "refresh",
    );
    expect(res).toMatchObject({ enriched: 0, skipped: 1, gone: 1 });
    const [p] = await db.select().from(places).where(eq(places.placeId, "gone-1"));
    expect(p!.goneAt).toBe(5_000);
    // Yeniden aramada görülünce işaret kalkar.
    await persistPlaces(db, scanId, [rec("gone-1", "OPERATIONAL")], 6_000);
    const [p2] = await db.select().from(places).where(eq(places.placeId, "gone-1"));
    expect(p2!.goneAt).toBeNull();
    expect(PlacesApiError).toBeDefined();
  });
});

describe("gates: ortak kapılar ve M5 ön onay", () => {
  it("kurulum yoksa SETUP_REQUIRED", async () => {
    const r = await checkCollectionReady(db);
    expect(r).toMatchObject({ ok: false, code: "SETUP_REQUIRED" });
  });

  it("ön onay tutarı kalan bütçeyi aşan tahmini kabul eder, onaydan büyüğünü reddeder", async () => {
    const big: ScanRequest = {
      ...(await req()),
      region: {
        kind: "bbox",
        name: "Büyük",
        countryCode: "GB",
        bbox: { south: 51.4, west: -0.3, north: 51.6, east: 0.05 },
      },
    };
    await setSetting(db, "budget.monthlyUsd", 0.5);
    await recordUsage(db, "mock", "text_search_pro", 5000);
    const plain = await checkPaidScan(db, big);
    expect(plain).toMatchObject({ ok: false, code: "NEEDS_ACK" });
    expect((await checkPaidScan(db, big, { acknowledgeRisk: true })).ok).toBe(true);
    const ok = await checkPaidScan(db, big, { ackMaxUsd: 1_000 });
    expect(ok.ok).toBe(true);
    const tooHigh = await checkPaidScan(db, big, { ackMaxUsd: 0.01 });
    expect(tooHigh).toMatchObject({ ok: false, code: "NEEDS_ACK" });
    await recordUsage(db, "mock", "text_search_pro", 100); // 3,2 USD > 0,5 USD bütçe
    expect(await checkPaidScan(db, big, { ackMaxUsd: 1_000 })).toMatchObject({
      ok: false,
      code: "BUDGET_BLOCKED",
    });
    await setSetting(db, "places.provider", "google");
    expect(await checkPaidScan(db, big)).toMatchObject({ ok: false, code: "PLACES_KEY_MISSING" });
  });
});
