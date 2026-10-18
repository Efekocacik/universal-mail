import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { budgetStatus, monthSkuCalls } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  categorySets,
  jobs,
  regions,
  scans,
  scanUnits,
  type RegionGeometry,
} from "@/lib/db/schema";
import type {
  FieldProfile,
  ProviderId,
  RegionInput,
  SearchStrategy,
  SkuId,
} from "@/lib/domain/types";
import { roundBBox } from "@/lib/geo/bbox";
import { enqueueJob } from "@/lib/jobs/queue";
import { getSetting } from "@/lib/settings";
import { buildQueries, computeScanKey } from "./queries";
import {
  estimateScan,
  planUnits,
  skuForScan,
  PlanError,
  type PlanInput,
  type ScanEstimate,
} from "./planner";
import { insertUnits, loadScan, setScanStatus } from "./store";

export { PlanError };

export interface ScanRequest {
  region: RegionInput;
  categoryIds: number[];
  customKeywords?: string[];
  strategy?: SearchStrategy;
  fieldProfile?: FieldProfile;
}

async function resolvePlan(db: Db, req: ScanRequest) {
  const cats = req.categoryIds.length
    ? await db.select().from(categorySets).where(inArray(categorySets.id, req.categoryIds))
    : [];
  const queries = buildQueries(cats, req.customKeywords ?? []);
  const input: PlanInput = {
    bbox: req.region.bbox,
    circle: req.region.circle,
    queries,
    strategy: req.strategy ?? "text",
    fieldProfile: req.fieldProfile ?? "discovery",
  };
  return { cats, queries, input };
}

/** Tarama öncesi tahmini çağrı sayısı ve maliyet (FR-DIS-05). Hiçbir kayıt oluşturmaz. */
export async function estimateForRequest(
  db: Db,
  req: ScanRequest,
): Promise<{ estimate: ScanEstimate; queries: number }> {
  const { input, queries } = await resolvePlan(db, req);
  const provider = await getSetting(db, "places.provider");
  const sku = skuForScan(input.strategy, input.fieldProfile);
  const skus: SkuId[] = [sku, skuForScan(input.strategy, input.fieldProfile, "keyword")];
  const monthCallsBySku: Partial<Record<SkuId, number>> = {};
  for (const s of new Set(skus)) monthCallsBySku[s] = await monthSkuCalls(db, provider, s);
  return { estimate: estimateScan(input, { monthCallsBySku }), queries: queries.length };
}

async function findOrCreateRegion(db: Db, r: RegionInput, now: number): Promise<number> {
  const geometry: RegionGeometry = {
    bbox: roundBBox(r.bbox, 5),
    circle: r.circle,
    cityId: r.cityId,
  };
  const sig = JSON.stringify(geometry);
  const existing = await db
    .select()
    .from(regions)
    .where(and(eq(regions.name, r.name), eq(regions.kind, r.kind)));
  const hit = existing.find((e) => JSON.stringify(e.geometry) === sig);
  if (hit) return hit.id;
  const rows = await db
    .insert(regions)
    .values({
      name: r.name,
      kind: r.kind,
      countryCode: r.countryCode ?? null,
      geometry,
      createdAt: now,
    })
    .returning({ id: regions.id });
  return rows[0]!.id;
}

export interface CreatedScan {
  scanId: number;
  estimate: ScanEstimate;
}

/** Taramayı oluşturur ve kuyruğa alır. Kullanıcı tahmini onayladıktan sonra çağrılır. */
export async function createAndStartScan(
  db: Db,
  req: ScanRequest,
  now: number = Date.now(),
): Promise<CreatedScan> {
  const { input, queries } = await resolvePlan(db, req);
  const { units } = planUnits(input); // doğrulama + birim üretimi (PlanError fırlatabilir)
  const { estimate } = await estimateForRequest(db, req);
  const provider = await getSetting(db, "places.provider");
  const regionId = await findOrCreateRegion(db, req.region, now);
  const scanKey = computeScanKey({
    bbox: input.bbox,
    circle: input.circle,
    queries,
    strategy: input.strategy,
  });

  const inserted = await db
    .insert(scans)
    .values({
      regionId,
      scanKey,
      categorySetIds: req.categoryIds,
      queries,
      strategy: input.strategy,
      fieldProfile: input.fieldProfile,
      provider: provider as ProviderId,
      status: "queued",
      estimate,
      progress: { unitsTotal: units.length, unitsDone: 0, placesFound: 0, callsTotal: 0 },
      createdAt: now,
    })
    .returning({ id: scans.id });
  const scanId = inserted[0]!.id;
  await insertUnits(db, scanId, units, now);
  await enqueueScanJob(db, scanId);
  await audit(db, "scan.created", "scan", scanId, {
    region: req.region.name,
    queries: queries.length,
    estimate: estimate.calls,
  });
  return { scanId, estimate };
}

async function hasActiveJob(db: Db, scanId: number): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "scan.run"),
        inArray(jobs.status, ["queued", "running"]),
        sql`json_extract(${jobs.payload}, '$.scanId') = ${scanId}`,
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function enqueueScanJob(db: Db, scanId: number): Promise<void> {
  if (await hasActiveJob(db, scanId)) return;
  await enqueueJob(db, "scan.run", { scanId }, { maxAttempts: 1, priority: 10 });
}

export type ControlResult = { ok: true } | { ok: false; error: string };

export async function pauseScan(db: Db, scanId: number): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı." };
  if (scan.status !== "queued" && scan.status !== "running")
    return { ok: false, error: "Yalnızca sürmekte olan tarama duraklatılabilir." };
  await setScanStatus(db, scanId, "paused", { pauseReason: "Siz duraklattınız." });
  return { ok: true };
}

export async function resumeScan(db: Db, scanId: number): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı." };
  if (scan.status !== "paused" && scan.status !== "budget_stopped") {
    return {
      ok: false,
      error: "Yalnızca duraklatılmış veya bütçe nedeniyle durmuş tarama sürdürülebilir.",
    };
  }
  const budget = await budgetStatus(db, scan.provider, await getSetting(db, "budget.monthlyUsd"));
  if (budget.level === "blocked") {
    return {
      ok: false,
      error:
        "Aylık bütçe sınırına ulaşıldı. Ayarlar'dan bütçeyi artırın veya gelecek ayı bekleyin.",
    };
  }
  await setScanStatus(db, scanId, "queued");
  await enqueueScanJob(db, scanId);
  return { ok: true };
}

export async function cancelScan(
  db: Db,
  scanId: number,
  now: number = Date.now(),
): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı." };
  if (["completed", "failed", "cancelled"].includes(scan.status))
    return { ok: false, error: "Tarama zaten bitmiş." };
  await setScanStatus(db, scanId, "cancelled", { finishedAt: now });
  return { ok: true };
}

export async function listScans(db: Db, limit = 50) {
  return db
    .select({ scan: scans, regionName: regions.name, countryCode: regions.countryCode })
    .from(scans)
    .innerJoin(regions, eq(regions.id, scans.regionId))
    .orderBy(desc(scans.id))
    .limit(limit);
}

export async function getScanDetail(db: Db, scanId: number) {
  const rows = await db
    .select({
      scan: scans,
      regionName: regions.name,
      countryCode: regions.countryCode,
      geometry: regions.geometry,
    })
    .from(scans)
    .innerJoin(regions, eq(regions.id, scans.regionId))
    .where(eq(scans.id, scanId))
    .limit(1);
  if (!rows[0]) return undefined;
  const unitStats = await db
    .select({
      status: scanUnits.status,
      n: sql<number>`count(*)`,
      saturated: sql<number>`sum(${scanUnits.saturated})`,
    })
    .from(scanUnits)
    .where(eq(scanUnits.scanId, scanId))
    .groupBy(scanUnits.status);
  const failedUnits = await db
    .select({ id: scanUnits.id, term: scanUnits.term, error: scanUnits.error })
    .from(scanUnits)
    .where(and(eq(scanUnits.scanId, scanId), eq(scanUnits.status, "failed")))
    .limit(10);
  return { ...rows[0], unitStats, failedUnits };
}
