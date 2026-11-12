import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as googleDataRoute from "@/app/api/google-data/route";
import * as refreshRoute from "@/app/api/google-data/refresh-ids/route";
import { getDb, type Db } from "@/lib/db/client";
import { placeCache } from "@/lib/db/cache-schema";
import { initDatabase } from "@/lib/db/init";
import {
  auditLog,
  categorySets,
  jobs,
  leads,
  places,
  placeSnapshots,
  scans,
} from "@/lib/db/schema";
import type { PlaceRecord } from "@/lib/domain/types";
import { PlacesApiError } from "@/lib/places/errors";
import { FIELD_TIERS } from "@/lib/places/fields";
import { MockPlacesProvider } from "@/lib/places/mock";
import type { DetailsResult, PlacesProvider } from "@/lib/places/provider";
import { purgeExpiredGoogleData } from "@/lib/places/cache";
import {
  DERIVED_FIELDS,
  effectiveCacheDays,
  GOOGLE_RETENTION_POLICY,
  MAX_COORD_DAYS,
  policyRows,
  purgeDerivedFlags,
} from "@/lib/places/retention";
import {
  dueIdRefresh,
  MERGED_TAG,
  remapPlaceId,
  runPlaceIdRefresh,
} from "@/lib/scan/place-id-refresh";
import { createAndStartScan } from "@/lib/scan/service";
import { persistPlaces } from "@/lib/scan/store";
import { setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

const ORIGIN = "http://127.0.0.1:3000";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 8);
let t: TestDb;
let db: Db;

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, any>;

const rec = (placeId: string, businessStatus = "OPERATIONAL"): PlaceRecord => ({
  placeId,
  source: "demo",
  name: "x",
  lat: 51.5,
  lng: -0.12,
  types: ["cafe"],
  businessStatus,
});

async function seed(ids: string[], at = T0, status = "OPERATIONAL") {
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
    ids.map((id) => rec(id, status)),
    at,
  );
  await db.update(scans).set({ status: "completed", finishedAt: at }).where(eq(scans.id, scanId));
  return scanId;
}

function idStub(map: Record<string, string | null | PlacesApiError>): PlacesProvider {
  return {
    id: "mock",
    pageSize: 20,
    maxTextResults: 60,
    maxNearbyResults: 20,
    searchText: async () => ({ places: [], sku: "text_search_ids" }),
    searchNearby: async () => ({ places: [], sku: "nearby_search_pro" }),
    async getDetails(id: string, fields: readonly string[]): Promise<DetailsResult> {
      expect(fields).toEqual(["id"]);
      const a = map[id];
      if (a instanceof PlacesApiError) throw a;
      return { place: null, sku: "place_details_ids_only", id: a ?? null };
    },
  };
}

beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
  await setSetting(db, "places.provider", "mock");
});
afterEach(async () => {
  await t.cleanup();
});

describe("alan düzeyinde saklama politikası", () => {
  it("her Places alanı ve türetilmiş alan için kural ve kaynak bağlantısı vardır", () => {
    for (const f of [...Object.keys(FIELD_TIERS), ...DERIVED_FIELDS]) {
      const rule = (GOOGLE_RETENTION_POLICY as Record<string, { termsRef: string } | undefined>)[f];
      expect(rule, f).toBeDefined();
      expect(rule!.termsRef).toMatch(/^https:\/\/(cloud|developers)\.google\.com\//);
    }
    expect(GOOGLE_RETENTION_POLICY.id.class).toBe("indefinite");
    expect(GOOGLE_RETENTION_POLICY.location).toMatchObject({ class: "ttl", maxDays: 30 });
    expect(GOOGLE_RETENTION_POLICY.displayName.class).toBe("session");
    expect(GOOGLE_RETENTION_POLICY.wasFuture).toMatchObject({
      class: "derived",
      legalReview: "pending",
    });
  });

  it("ayar 30 günü aşamaz; politika tablosu güncel ayarları yansıtır", () => {
    expect(effectiveCacheDays(90)).toBe(MAX_COORD_DAYS);
    expect(effectiveCacheDays(0)).toBe(1);
    expect(effectiveCacheDays(Number.NaN)).toBe(30);
    const rows = policyRows({ cacheDays: 10, derivedFlagsDays: 365 });
    expect(rows.find((r) => r.field === "location")!.maxDays).toBe(10);
    expect(rows.find((r) => r.field === "id")).toMatchObject({
      maxDays: null,
      refreshAfterDays: 365,
    });
    expect(rows.find((r) => r.field === "wasFuture")!.maxDays).toBe(365);
    // Ayarın silmediği türetilmiş alanlar süre vaat etmez; gerçek davranışları yazılıdır.
    expect(rows.find((r) => r.field === "goneAt")).toMatchObject({
      maxDays: null,
      keptBecause: "prevents_reappearing",
    });
    expect(rows.find((r) => r.field === "reviewsSignal")!.keptBecause).toBe("recomputed_each_scan");
    expect(rows.find((r) => r.field === "countryCity")!.keptBecause).toBe("own_dataset");
  });

  it("politikada süreli görünen her türetilmiş alan purgeDerivedFlags tarafından gerçekten silinir", async () => {
    await seed(["d1"], T0, "FUTURE_OPENING");
    const scanId = (await db.select().from(scans))[0]!.id;
    await db
      .update(places)
      .set({
        wasFuture: true,
        isClosed: true,
        openedDetectedAt: T0,
        newDetectedAt: T0,
        notFoundInScanId: scanId,
        statusCheckedAt: T0,
      })
      .where(eq(places.placeId, "d1"));
    /** Politika alanı → places sütunu ve "temizlenmiş" değeri. */
    const cleared: Record<string, (p: typeof places.$inferSelect) => boolean> = {
      wasFuture: (p) => p.wasFuture === false,
      isClosed: (p) => p.isClosed === false,
      openedDetectedAt: (p) => p.openedDetectedAt === null,
      newDetectedAt: (p) => p.newDetectedAt === null,
      notFoundInScanId: (p) => p.notFoundInScanId === null,
      statusCheckedAt: (p) => p.statusCheckedAt === null,
    };
    const promised = policyRows({ cacheDays: 30, derivedFlagsDays: 90 })
      .filter((r) => r.class === "derived" && r.maxDays !== null)
      .map((r) => r.field);
    expect(promised.sort()).toEqual(Object.keys(cleared).sort());
    await purgeDerivedFlags(db, 90, T0 + 91 * DAY);
    const [row] = await db.select().from(places).where(eq(places.placeId, "d1"));
    for (const f of promised) expect(cleared[f]!(row!), f).toBe(true);
  });

  it("koordinat temizliği politika üst sınırını kullanır", async () => {
    await seed(["a"], T0);
    const r = await purgeExpiredGoogleData(db, 365, T0 + 31 * DAY);
    expect(r.coordinates).toBe(1);
  });

  it("türetilmiş bayraklar: null = süresiz; süre dolunca bayraklar ve izler temizlenir, kayıt kalır", async () => {
    await seed(["f1", "f2"], T0, "FUTURE_OPENING");
    expect(await purgeDerivedFlags(db, null, T0 + 1000 * DAY)).toEqual({ places: 0, snapshots: 0 });
    expect((await purgeDerivedFlags(db, 90, T0 + 30 * DAY)).places).toBe(0);
    const r = await purgeDerivedFlags(db, 90, T0 + 91 * DAY);
    expect(r).toEqual({ places: 2, snapshots: 2 });
    const rows = await db.select().from(places);
    expect(rows.every((p) => !p.wasFuture)).toBe(true);
    expect(rows).toHaveLength(2);
    expect((await db.select().from(placeSnapshots)).every((s) => !s.wasFuture)).toBe(true);
    // 30 günden kısa süre verilse bile 30 gün tabanı uygulanır.
    await seed(["f3"], T0 + 100 * DAY, "FUTURE_OPENING");
    expect((await purgeDerivedFlags(db, 5, T0 + 110 * DAY)).places).toBe(0);
  });
});

describe("yer kimliği yenileme", () => {
  it("12 aydan eski kimlikler; aynı/yeni/birleşik/kaybolan; yalnızca IDs Only", async () => {
    await seed(["same", "moved", "dup", "target", "lost", "nf", "fresh"], T0);
    await db
      .update(places)
      .set({ placeIdCheckedAt: T0 + 300 * DAY })
      .where(eq(places.placeId, "fresh"));
    const now = T0 + 400 * DAY;
    const due = await dueIdRefresh(db, { now, limit: 50 });
    expect(due.sort()).toEqual(["dup", "lost", "moved", "nf", "same", "target"]);

    const leadsBefore = new Map((await db.select().from(leads)).map((l) => [l.placeId, l.id]));
    const res = await runPlaceIdRefresh(
      {
        db,
        provider: idStub({
          same: "same",
          moved: "moved-new",
          dup: "target",
          target: "target",
          lost: null,
          nf: new PlacesApiError("not_found", "yok", { status: 404 }),
        }),
        getBudgetUsd: async () => 100,
        now: () => now,
        sleep: async () => undefined,
      },
      { limit: 50 },
    );
    expect(res).toMatchObject({ checked: 6, unchanged: 2, remapped: 1, merged: 1, gone: 2 });

    const by = new Map((await db.select().from(places)).map((p) => [p.placeId, p]));
    expect(by.has("moved")).toBe(false);
    expect(by.get("moved-new")).toMatchObject({ placeIdCheckedAt: now, goneAt: null });
    const movedLead = (await db.select().from(leads)).find(
      (l) => l.id === leadsBefore.get("moved"),
    );
    expect(movedLead!.placeId).toBe("moved-new");
    expect((await db.select().from(placeSnapshots)).some((s) => s.placeId === "moved-new")).toBe(
      true,
    );
    // İki tarafta da lead var: birleştirilmez, eski lead etiketlenir; eski yer kapanır.
    const dupLead = (await db.select().from(leads)).find((l) => l.id === leadsBefore.get("dup"));
    expect(dupLead!.tags).toContain(MERGED_TAG);
    expect(by.get("dup")!.goneAt).toBe(now);
    expect(by.get("lost")!.goneAt).toBe(now);
    expect(by.get("nf")!.goneAt).toBe(now);
    expect(by.get("same")).toMatchObject({ placeIdCheckedAt: now, goneAt: null });
    expect(
      (await db.select().from(auditLog)).some((a) => a.action === "places.ids_refreshed"),
    ).toBe(true);
    // İdempotent: yeniden çalıştırma denetlenmiş yeri sormaz.
    expect(await dueIdRefresh(db, { now: now + 1, limit: 50 })).toEqual([]);
  });

  it("çakışmada yalnızca eski lead varsa yeni yere taşınır", async () => {
    await seed(["old"], T0);
    await db.insert(places).values({
      placeId: "new",
      source: "demo",
      coordsFetchedAt: T0,
      firstSeenAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await remapPlaceId(db, "old", "new", T0 + 1)).toBe("merged");
    const [l] = await db.select().from(leads);
    expect(l!.placeId).toBe("new");
    expect(l!.tags).not.toContain(MERGED_TAG);
  });

  it("kota hatasında durur; bütçe engelinde istek yapmaz", async () => {
    await seed(["a", "b"], T0);
    const r = await runPlaceIdRefresh(
      {
        db,
        provider: idStub({ a: new PlacesApiError("quota", "kota", { status: 429 }) }),
        getBudgetUsd: async () => 100,
        now: () => T0 + 400 * DAY,
        sleep: async () => undefined,
      },
      { limit: 10 },
    );
    expect(r).toMatchObject({ checked: 0, stoppedReason: "quota" });
    const stop = await runPlaceIdRefresh(
      {
        db,
        provider: idStub({}),
        getBudgetUsd: async () => 100,
        now: () => T0 + 400 * DAY,
        shouldStop: () => true,
      },
      { limit: 10 },
    );
    expect(stop.stoppedReason).toBe("stopped");
  });

  it("demo sağlayıcı kimliği aynen döndürür", async () => {
    const p = new MockPlacesProvider({ getEpoch: () => 0 });
    const r = await p.getDetails("not-a-demo-id", ["id"]);
    expect(r).toMatchObject({ place: null, id: null });
  });
});

describe("HTTP: /api/google-data", () => {
  it("GET sınıflara göre sayım ve politika; eski alanlar korunur", async () => {
    await seed(["a", "b"], Date.now() - 400 * DAY, "FUTURE_OPENING");
    await db.update(places).set({ goneAt: Date.now() }).where(eq(places.placeId, "b"));
    await setSetting(db, "google.derivedFlagsDays", 365);
    const r = await json(await googleDataRoute.GET(req("GET", "/api/google-data"), undefined));
    expect(r).toMatchObject({
      cachedPlaces: expect.any(Number),
      storedCoordinates: 2,
      maxRetentionDays: 30,
      termsReviewedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      byPolicy: {
        indefinite: { placeIds: 2, dueRefresh: 1, gone: 1, refreshAfterDays: 365 },
        ttl: { coordinates: 2, maxDays: 30 },
        derived: { flaggedPlaces: 2, maxDays: 365, legalReview: "pending" },
      },
    });
    expect(r.policy.length).toBeGreaterThan(10);
    expect(await db.select().from(placeCache)).toBeDefined();
  });

  it("POST refresh-ids: 202, gün başına tek el ile iş; kurulum yoksa 403; bilinmeyen alan 400", async () => {
    const no = await refreshRoute.POST(req("POST", "/api/google-data/refresh-ids", {}), undefined);
    expect(no.status).toBe(403);
    await setSetting(db, "targets.countries", ["GB"]);
    await setSetting(db, "company.profile", {
      legalName: "Örnek A.Ş.",
      address: "Ankara",
      taxId: "1234567890",
      phone: "+90 312 000 00 00",
      contactName: "Ayşe Demir",
    });
    await setSetting(db, "consent", { version: "x", acceptedAt: T0, name: "Ayşe Demir" });
    await setSetting(db, "setup.completed", true);
    const a = await refreshRoute.POST(
      req("POST", "/api/google-data/refresh-ids", { limit: 10 }),
      undefined,
    );
    expect(a.status).toBe(202);
    expect(await json(a)).toMatchObject({ queued: true });
    const b = await refreshRoute.POST(req("POST", "/api/google-data/refresh-ids"), undefined);
    expect(await json(b)).toMatchObject({ queued: false });
    expect(await db.select().from(jobs).where(eq(jobs.type, "places.refresh_ids"))).toHaveLength(1);
    const bad = await refreshRoute.POST(
      req("POST", "/api/google-data/refresh-ids", { limit: 0 }),
      undefined,
    );
    expect(bad.status).toBe(400);
  });
});
