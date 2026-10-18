import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetStatus, canSpend, recordUsage } from "@/lib/budget";
import {
  categorySets,
  jobs,
  leads,
  placeSnapshots,
  places,
  scanUnits,
  scans,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import type { PlacesProvider } from "@/lib/places/provider";
import { PlacesApiError } from "@/lib/places/errors";
import { MockPlacesProvider } from "@/lib/places/mock";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { recomputeNovelty } from "@/lib/scan/novelty-sync";
import { enrichPlaces } from "@/lib/scan/enrich";
import { runScan, type RunnerDeps } from "@/lib/scan/runner";
import {
  cancelScan,
  createAndStartScan,
  estimateForRequest,
  pauseScan,
  resumeScan,
} from "@/lib/scan/service";
import { getSetting, setSetting } from "@/lib/settings";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let db: Db;
let epoch = 0;

const londonBox = bboxFromCenter(51.5085, -0.1257, 3.5);

async function categoryIds(keys: string[]): Promise<number[]> {
  const rows = await db.select().from(categorySets);
  return rows.filter((r) => keys.includes(r.key)).map((r) => r.id);
}

async function newScan(keys = ["cafe"], extra: Record<string, unknown> = {}) {
  return createAndStartScan(db, {
    region: { kind: "city", name: "London", countryCode: "GB", bbox: londonBox },
    categoryIds: await categoryIds(keys),
    ...extra,
  });
}

function deps(over: Partial<RunnerDeps> = {}, provider?: PlacesProvider): RunnerDeps {
  return {
    db,
    provider: provider ?? new MockPlacesProvider({ getEpoch: () => epoch }),
    getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
    getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
    sleep: async () => undefined,
    minIntervalMs: 0,
    ...over,
  };
}

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

describe("tahmin ve planlama", () => {
  it("tarama öncesi çağrı ve maliyet aralığı verir, kayıt oluşturmaz", async () => {
    const { estimate, queries } = await estimateForRequest(db, {
      region: { kind: "city", name: "London", bbox: londonBox },
      categoryIds: await categoryIds(["cafe", "pub"]),
    });
    expect(queries).toBe(4); // cafe, coffee_shop, pub, bar
    expect(estimate.units).toBe(estimate.cells * 4);
    expect(estimate.calls.low).toBeLessThanOrEqual(estimate.calls.expected);
    expect(estimate.calls.expected).toBeLessThan(estimate.calls.high);
    expect(estimate.sku).toBe("text_search_pro");
    expect(estimate.freeCallsLeft).toBe(5000);
    expect(estimate.costUsd.low).toBe(0); // ücretsiz kota içinde
    expect(await db.select().from(scans)).toHaveLength(0);
  });

  it("zenginleştirme profili Enterprise SKU ile tahmin edilir", async () => {
    const { estimate } = await estimateForRequest(db, {
      region: { kind: "city", name: "London", bbox: londonBox },
      categoryIds: await categoryIds(["cafe"]),
      fieldProfile: "enrich",
    });
    expect(estimate.sku).toBe("text_search_enterprise");
    expect(estimate.freeCallsLeft).toBe(1000);
    expect(estimate.notes.join(" ")).toContain("Enterprise");
  });

  it("çok büyük alanı ve boş sorguyu reddeder", async () => {
    await expect(
      createAndStartScan(db, {
        region: { kind: "bbox", name: "dev", bbox: bboxFromCenter(48, 10, 80) },
        categoryIds: await categoryIds(["cafe"]),
      }),
    ).rejects.toThrow(/çok büyük/);
    await expect(
      createAndStartScan(db, {
        region: { kind: "city", name: "London", bbox: londonBox },
        categoryIds: [],
      }),
    ).rejects.toThrow(/kategori/);
  });
});

describe("temel tarama (baz çizgi)", () => {
  it("taramayı tamamlar; işletme, snapshot, lead ve kullanım kayıtları oluşur", async () => {
    const { scanId } = await newScan(["cafe", "pub"]);
    const outcome = await runScan(deps(), scanId);
    expect(outcome).toBe("completed");

    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.status).toBe("completed");
    expect(scan.isBaseline).toBe(true);
    expect(scan.comparedToScanId).toBeNull();
    expect((scan.progress as { placesFound: number }).placesFound).toBeGreaterThan(50);
    expect(scan.finishedAt).not.toBeNull();

    const p = await db.select().from(places);
    const snaps = await db.select().from(placeSnapshots).where(eq(placeSnapshots.scanId, scanId));
    const l = await db.select().from(leads);
    expect(p.length).toBe(snaps.length);
    expect(l.length).toBe(p.length);
    expect(p.every((x) => x.source === "demo" && x.countryCode === "GB")).toBe(true);
    expect(p.every((x) => x.lat >= londonBox.south && x.lat <= londonBox.north)).toBe(true);

    // Baz çizgide "yeni tespit" sinyali yok; yalnızca FUTURE_OPENING yüksek skor taşır.
    expect(p.every((x) => x.newDetectedAt === null)).toBe(true);
    const future = l.filter((x) => x.noveltyLabel === "future_opening");
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((x) => x.noveltyScore === 100)).toBe(true);
    expect(
      l.filter((x) => x.noveltyLabel !== "future_opening").every((x) => x.noveltyScore === 0),
    ).toBe(true);
  });

  it("yoğun hücreleri otomatik böler (doygunluk) ve tekrarlayan kayıtları tekilleştirir", async () => {
    // Geniş alan => büyük hücreler => merkezdeki hücreler 60 sonuç sınırına ulaşır.
    const { scanId } = await createAndStartScan(db, {
      region: {
        kind: "city",
        name: "London (geniş)",
        countryCode: "GB",
        bbox: bboxFromCenter(51.5085, -0.1257, 12),
      },
      categoryIds: await categoryIds(["cafe"]),
    });
    expect(await runScan(deps(), scanId)).toBe("completed");
    const units = await db.select().from(scanUnits).where(eq(scanUnits.scanId, scanId));
    const saturated = units.filter((u) => u.saturated);
    const children = units.filter((u) => u.parentId !== null);
    expect(saturated.length).toBeGreaterThan(0);
    expect(children.length).toBeGreaterThan(0);
    expect(children.length % 4).toBe(0);
    const byId = new Map(units.map((u) => [u.id, u]));
    for (const c of children) {
      const parent = byId.get(c.parentId!)!;
      expect(parent.saturated).toBe(true);
      expect(c.depth).toBe(parent.depth + 1);
      expect(c.term).toBe(parent.term);
    }
    expect(units.every((u) => u.status === "done")).toBe(true);
    // Kayıtlar tekil; bölme sayesinde ana hücrelerin 60'lık sınırından fazla işletme bulundu.
    const ids = await db.select({ id: places.placeId }).from(places);
    expect(new Set(ids.map((i) => i.id)).size).toBe(ids.length);
    const rootCap = units
      .filter((u) => u.parentId === null)
      .reduce((a, u) => a + Math.min(u.resultCount, 60), 0);
    expect(ids.length).toBeGreaterThan(rootCap * 0.5);
    expect(units.reduce((a, u) => a + u.resultCount, 0)).toBeGreaterThan(rootCap);
  });

  it("maliyet sayacı artar ve SKU'ya göre kaydedilir", async () => {
    const { scanId } = await newScan(["cafe"]);
    await runScan(deps(), scanId);
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    const calls = Object.values(scan.callsBySku).reduce((a, b) => a + b, 0);
    expect(calls).toBeGreaterThan(20);
    expect(scan.callsBySku.text_search_pro).toBe(calls);
    const status = await budgetStatus(db, "mock", 30);
    expect(status.totalCalls).toBe(calls);
    expect(status.bySku[0]?.sku).toBe("text_search_pro");
    expect(status.level).toBe("ok");
  });
});

describe("ikinci tarama: yeni işletme tespiti (snapshot karşılaştırması)", () => {
  it("14 gün sonraki tarama yeni ve açılan işletmeleri işaretler", async () => {
    const first = await newScan(["cafe", "pub"]);
    await runScan(deps(), first.scanId);
    const before = new Map((await db.select().from(places)).map((p) => [p.placeId, p]));

    epoch = 3; // simüle: haftalar geçti, yeni yerler açıldı, bazı FUTURE_OPENING işletmeler açıldı
    const second = await newScan(["cafe", "pub"]);
    expect(await runScan(deps(), second.scanId)).toBe("completed");

    const scan2 = (await db.select().from(scans).where(eq(scans.id, second.scanId)))[0]!;
    expect(scan2.isBaseline).toBe(false);
    expect(scan2.comparedToScanId).toBe(first.scanId);

    const after = await db.select().from(places);
    const fresh = after.filter((p) => !before.has(p.placeId));
    expect(fresh.length).toBeGreaterThan(0);
    expect(
      fresh.every((p) => p.newDetectedAt !== null && p.firstSeenScanId === second.scanId),
    ).toBe(true);
    // Önceden var olanlar "yeni" sayılmaz
    expect(after.filter((p) => before.has(p.placeId)).every((p) => p.newDetectedAt === null)).toBe(
      true,
    );

    const opened = after.filter((p) => p.openedDetectedAt !== null);
    expect(opened.length).toBeGreaterThan(0);
    expect(
      opened.every(
        (p) =>
          before.get(p.placeId)?.businessStatus === "FUTURE_OPENING" &&
          p.businessStatus === "OPERATIONAL",
      ),
    ).toBe(true);

    const l = await db.select().from(leads);
    const byPlace = new Map(l.map((x) => [x.placeId, x]));
    for (const p of fresh) {
      const lead = byPlace.get(p.placeId)!;
      expect(lead.noveltyLabel).toBe("high");
      expect(lead.noveltyScore).toBe(70);
      expect(lead.noveltySignals.map((s) => s.id)).toContain("new_in_snapshot");
    }
    for (const p of opened) expect(byPlace.get(p.placeId)!.noveltyScore).toBe(90);
  });

  it("farklı kategori seti karşılaştırılabilir değildir (yeni baz çizgi)", async () => {
    const a = await newScan(["cafe"]);
    await runScan(deps(), a.scanId);
    const b = await newScan(["pub"]);
    await runScan(deps(), b.scanId);
    const scanB = (await db.select().from(scans).where(eq(scans.id, b.scanId)))[0]!;
    expect(scanB.isBaseline).toBe(true);
    expect((await db.select().from(places)).every((p) => p.newDetectedAt === null)).toBe(true);
  });

  it("başka bir taramada daha önce görülmüş yer 'yeni' sayılmaz", async () => {
    const a = await newScan(["cafe"]);
    await runScan(deps(), a.scanId);
    const b = await newScan(["cafe", "pub"]); // farklı anahtar
    await runScan(deps(), b.scanId);
    const c = await newScan(["cafe", "pub"]); // aynı anahtar: b ile karşılaştırılır
    await runScan(deps(), c.scanId);
    const cafes = (await db.select().from(places)).filter((p) => p.primaryType === "cafe");
    expect(cafes.every((p) => p.newDetectedAt === null)).toBe(true);
  });

  it("önceki taramada olup bu taramada görünmeyenler 'bulunamadı' olarak işaretlenir (kapandı sayılmaz)", async () => {
    epoch = 3;
    const a = await newScan(["cafe"]);
    await runScan(deps(), a.scanId);
    // Sağlayıcı artık bazı yerleri döndürmüyor (epoch geriye sarıldı gibi): daha az sonuç.
    epoch = 0;
    const b = await newScan(["cafe"]);
    await runScan(deps(), b.scanId);
    const missing = (await db.select().from(places)).filter((p) => p.notFoundInScanId === b.scanId);
    expect(missing.length).toBeGreaterThan(0);
    // Ve tekrar görülürlerse işaret kalkar
    epoch = 3;
    const c = await newScan(["cafe"]);
    await runScan(deps(), c.scanId);
    expect(
      (await db.select().from(places)).filter((p) => p.notFoundInScanId !== null),
    ).toHaveLength(0);
  });

  it("zamanla yeni-tespit sinyali sona erer (yeniden hesaplama)", async () => {
    const a = await newScan(["cafe"]);
    await runScan(deps(), a.scanId);
    epoch = 3;
    const b = await newScan(["cafe"]);
    await runScan(deps(), b.scanId);
    const config = await getSetting(db, "novelty.thresholds");
    const stillNew = (await db.select().from(leads)).filter(
      (l) => l.noveltyLabel === "high",
    ).length;
    expect(stillNew).toBeGreaterThan(0);

    const in90Days = Date.now() + 90 * 86_400_000;
    const updated = await recomputeNovelty(db, config, { now: in90Days });
    expect(updated).toBeGreaterThan(0);
    expect((await db.select().from(leads)).filter((l) => l.noveltyLabel === "high")).toHaveLength(
      0,
    );
  });
});

describe("duraklatma, devam ve kalıcılık", () => {
  it("birim sayısı dolunca durdurulan tarama duraklar ve devamında aynı sonuca ulaşır", async () => {
    const uninterrupted = await newScan(["cafe"]);
    await runScan(deps(), uninterrupted.scanId);
    const expectedIds = new Set(
      (
        await db
          .select({ id: placeSnapshots.placeId })
          .from(placeSnapshots)
          .where(eq(placeSnapshots.scanId, uninterrupted.scanId))
      ).map((x) => x.id),
    );

    const interrupted = await newScan(["cafe"]);
    let calls = 0;
    const out = await runScan(deps({ shouldStop: () => ++calls > 10 }), interrupted.scanId);
    expect(out).toBe("paused");
    let scan = (await db.select().from(scans).where(eq(scans.id, interrupted.scanId)))[0]!;
    expect(scan.status).toBe("paused");
    expect(scan.pauseReason).toContain("devam");
    const doneSoFar = (
      await db.select().from(scanUnits).where(eq(scanUnits.scanId, interrupted.scanId))
    ).filter((u) => u.status === "done").length;
    expect(doneSoFar).toBeGreaterThan(0);

    expect(await resumeScan(db, interrupted.scanId)).toEqual({ ok: true });
    expect(await runScan(deps(), interrupted.scanId)).toBe("completed");
    scan = (await db.select().from(scans).where(eq(scans.id, interrupted.scanId)))[0]!;
    const gotIds = new Set(
      (
        await db
          .select({ id: placeSnapshots.placeId })
          .from(placeSnapshots)
          .where(eq(placeSnapshots.scanId, interrupted.scanId))
      ).map((x) => x.id),
    );
    expect(gotIds).toEqual(expectedIds);
    expect(scan.status).toBe("completed");
  });

  it("çökme sonrası 'running' kalmış birimler kuyruğa döner ve tarama sürer", async () => {
    const { scanId } = await newScan(["cafe"]);
    await db.update(scans).set({ status: "queued" }).where(eq(scans.id, scanId));
    await db
      .update(scanUnits)
      .set({ status: "running" })
      .where(sql`${scanUnits.id} IN (SELECT id FROM scan_units WHERE scan_id = ${scanId} LIMIT 3)`);
    expect(await runScan(deps(), scanId)).toBe("completed");
    const units = await db.select().from(scanUnits).where(eq(scanUnits.scanId, scanId));
    expect(units.every((u) => u.status === "done")).toBe(true);
  });

  it("kullanıcı duraklatınca çalışıcı durur; iptal edilen tarama sürdürülemez", async () => {
    const { scanId } = await newScan(["cafe"]);
    let n = 0;
    const out = await runScan(
      deps({
        sleep: async () => {
          if (++n === 3) await pauseScan(db, scanId);
        },
      }),
      scanId,
    );
    expect(out).toBe("paused");
    expect(await resumeScan(db, scanId)).toEqual({ ok: true });
    expect(await cancelScan(db, scanId)).toEqual({ ok: true });
    expect(await resumeScan(db, scanId)).toMatchObject({ ok: false });
    expect(await runScan(deps(), scanId)).toBe("cancelled");
  });

  it("aynı tarama için ikinci iş eklenmez", async () => {
    const { scanId } = await newScan(["cafe"]);
    await db.update(scans).set({ status: "paused" }).where(eq(scans.id, scanId));
    await resumeScan(db, scanId);
    await resumeScan(db, scanId).catch(() => undefined);
    const rows = await db.select().from(jobs);
    expect(rows.filter((j) => j.type === "scan.run")).toHaveLength(1);
  });
});

describe("bütçe koruması", () => {
  it("bütçe dolunca tarama durur ve çağrı yapılmaz", async () => {
    await setSetting(db, "budget.monthlyUsd", 0.1);
    // Ücretsiz kota (5.000) bitmiş gibi göster: bundan sonraki her çağrı 0,032 USD.
    await recordUsage(db, "mock", "text_search_pro", 5000);
    const { scanId } = await newScan(["cafe"]);
    const out = await runScan(deps(), scanId);
    expect(out).toBe("budget_stopped");
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.status).toBe("budget_stopped");
    expect(scan.pauseReason).toContain("bütçe");
    const status = await budgetStatus(db, "mock", 0.1);
    expect(status.spentUsd).toBeLessThanOrEqual(0.1);
    expect(status.spentUsd).toBeGreaterThan(0.06);
    // Bütçe tamamen dolduğunda devam ettirilemez
    expect(await resumeScan(db, scanId)).toMatchObject({ ok: true }); // 0,096 < 0,1: hâlâ yer var
    await setSetting(db, "budget.monthlyUsd", 0.096);
    await db.update(scans).set({ status: "budget_stopped" }).where(eq(scans.id, scanId));
    expect(await resumeScan(db, scanId)).toMatchObject({ ok: false });
  });

  it("ücretsiz kota içindeki çağrılar bütçe 0 olsa da çalışır", async () => {
    await setSetting(db, "budget.monthlyUsd", 0);
    const { scanId } = await newScan(["cafe"]);
    expect(await runScan(deps(), scanId)).toBe("completed");
    expect((await budgetStatus(db, "mock", 0)).spentUsd).toBe(0);
  });

  it("canSpend kademeli maliyeti hesaba katar", async () => {
    expect((await canSpend(db, "mock", 1, "text_search_pro", 100)).ok).toBe(true);
    await recordUsage(db, "mock", "text_search_pro", 5000);
    expect((await canSpend(db, "mock", 1, "text_search_pro", 100)).ok).toBe(false); // 3,2 USD > 1
    expect((await canSpend(db, "mock", 1, "text_search_pro", 10)).ok).toBe(true); // 0,32 USD
  });

  it("güvenlik çağrı sınırı aşılırsa tarama duraklar", async () => {
    const { scanId } = await newScan(["cafe"]);
    await db
      .update(scans)
      .set({ estimate: { maxCalls: 5 } })
      .where(eq(scans.id, scanId));
    const out = await runScan(deps(), scanId);
    expect(out).toBe("paused");
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.pauseReason).toContain("Güvenlik");
  });
});

describe("hata yönetimi", () => {
  function failingProvider(
    kind: ConstructorParameters<typeof PlacesApiError>[0],
    failOn: (n: number, term: string) => boolean,
  ): PlacesProvider {
    const inner = new MockPlacesProvider({ getEpoch: () => epoch });
    let n = 0;
    return {
      id: "mock",
      pageSize: inner.pageSize,
      maxTextResults: inner.maxTextResults,
      maxNearbyResults: inner.maxNearbyResults,
      searchNearby: (r) => inner.searchNearby(r),
      getDetails: (id, f) => inner.getDetails(id, f),
      searchText: async (r) => {
        n++;
        if (failOn(n, r.textQuery)) throw new PlacesApiError(kind, `test hatası: ${kind}`);
        return inner.searchText(r);
      },
    };
  }

  it("kota hatasında tarama duraklatılır, birim kuyrukta kalır", async () => {
    const { scanId } = await newScan(["cafe"]);
    const out = await runScan(
      deps(
        {},
        failingProvider("quota", (n) => n === 4),
      ),
      scanId,
    );
    expect(out).toBe("paused");
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.status).toBe("paused");
    expect(scan.pauseReason).toContain("quota");
    const units = await db.select().from(scanUnits).where(eq(scanUnits.scanId, scanId));
    expect(units.some((u) => u.status === "running")).toBe(false);
    // Düzelince devam eder
    await resumeScan(db, scanId);
    expect(await runScan(deps(), scanId)).toBe("completed");
  });

  it("yetkilendirme/faturalandırma hatasında tarama başarısız olur", async () => {
    const { scanId } = await newScan(["cafe"]);
    const out = await runScan(
      deps(
        {},
        failingProvider("billing", () => true),
      ),
      scanId,
    );
    expect(out).toBe("failed");
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.status).toBe("failed");
    expect(scan.error).toContain("billing");
  });

  it("tek bir türün geçersiz olması taramayı bozmaz; sonuç karşılaştırmaya girmez", async () => {
    const { scanId } = await newScan(["cafe"]); // cafe + coffee_shop
    const out = await runScan(
      deps(
        {},
        failingProvider("invalid", (_n, term) => term === "coffee shop"),
      ),
      scanId,
    );
    expect(out).toBe("completed");
    const units = await db.select().from(scanUnits).where(eq(scanUnits.scanId, scanId));
    expect(units.filter((u) => u.status === "failed").length).toBeGreaterThan(0);
    expect(units.filter((u) => u.status === "done").length).toBeGreaterThan(0);
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect((scan.progress as { unitsFailed: number }).unitsFailed).toBeGreaterThan(0);
    expect(scan.isBaseline).toBe(false);
    // Bir sonraki (hatasız) tarama, eksik kapsamlı taramaya karşı "yeni" üretmez
    const next = await newScan(["cafe"]);
    await runScan(deps(), next.scanId);
    expect((await db.select().from(places)).every((p) => p.newDetectedAt === null)).toBe(true);
  });

  it("art arda çok sayıda geçersiz birimde tarama başarısız olur", async () => {
    const { scanId } = await newScan(["cafe"]);
    const out = await runScan(
      deps(
        {},
        failingProvider("invalid", () => true),
      ),
      scanId,
    );
    expect(out).toBe("failed");
  });
});

describe("zenginleştirme (Place Details)", () => {
  it("web sitesi, telefon ve yorum sayısını doldurur; lead durumu ve skor güncellenir", async () => {
    const { scanId } = await newScan(["cafe"]);
    await runScan(deps(), scanId);
    const target = (
      await db.select().from(places).where(eq(places.businessStatus, "OPERATIONAL")).limit(3)
    ).map((p) => p.placeId);
    expect(
      (await db.select().from(places).where(eq(places.placeId, target[0]!)))[0]!.website,
    ).toBeNull();

    const res = await enrichPlaces(
      {
        db,
        provider: new MockPlacesProvider({ getEpoch: () => epoch }),
        getBudgetUsd: () => getSetting(db, "budget.monthlyUsd"),
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
      },
      target,
    );
    expect(res.enriched).toBe(3);
    for (const id of target) {
      const p = (await db.select().from(places).where(eq(places.placeId, id)))[0]!;
      expect(p.website).toMatch(/\.example$/);
      expect(typeof p.userRatingCount).toBe("number");
      expect(p.enrichedAt).not.toBeNull();
      const lead = (await db.select().from(leads).where(eq(leads.placeId, id)))[0]!;
      expect(lead.status).toBe("enriched");
    }
    const usage = await budgetStatus(db, "mock", 30);
    expect(usage.bySku.find((s) => s.sku === "place_details_enterprise")?.calls).toBe(3);
  });

  it("bütçe dolunca zenginleştirme durur", async () => {
    await recordUsage(db, "mock", "place_details_enterprise", 1000);
    const { scanId } = await newScan(["cafe"]);
    await runScan(deps(), scanId);
    const ids = (await db.select().from(places).limit(3)).map((p) => p.placeId);
    const res = await enrichPlaces(
      {
        db,
        provider: new MockPlacesProvider({ getEpoch: () => epoch }),
        getBudgetUsd: async () => 0.001,
        getNoveltyConfig: () => getSetting(db, "novelty.thresholds"),
        sleep: async () => undefined,
      },
      ids,
    );
    expect(res.enriched).toBe(0);
    expect(res.stoppedReason).toContain("bütçe");
  });
});
