import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { budgetStatus, monthSkuCalls } from "@/lib/budget";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  categorySets,
  jobs,
  regions,
  scans,
  scanUnits,
  type RegionGeometry,
  type ScanOrigin,
} from "@/lib/db/schema";
import type {
  FieldProfile,
  ProviderId,
  RegionInput,
  ScanQuery,
  SearchStrategy,
  SkuId,
} from "@/lib/domain/types";
import { roundBBox } from "@/lib/geo/bbox";
import { SKU_PRICING } from "@/lib/places/pricing";
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
import { ACTIVE_SCAN_MESSAGE, ScanGateError } from "./gate-error";
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
  opts: { ignoreFreeTier?: boolean } = {},
): Promise<{ estimate: ScanEstimate; queries: number }> {
  const { input, queries } = await resolvePlan(db, req);
  const provider = await getSetting(db, "places.provider");
  const sku = skuForScan(input.strategy, input.fieldProfile);
  const skus: SkuId[] = [sku, skuForScan(input.strategy, input.fieldProfile, "keyword")];
  const monthCallsBySku: Partial<Record<SkuId, number>> = {};
  for (const s of new Set(skus)) {
    const used = await monthSkuCalls(db, provider, s);
    // `ignoreFreeTier`: ücretsiz aylık kota bitmiş varsayılır (liste fiyatı). Zamanlama ön onayı (M5) bununla
    // hesaplanır; aksi halde ay içinde kota bitince "ücretsiz" onaylanmış her çalışma NEEDS_ACK ile atlanırdı.
    const free = SKU_PRICING[s].freeMonthly;
    monthCallsBySku[s] = opts.ignoreFreeTier && Number.isFinite(free) ? Math.max(used, free) : used;
  }
  return { estimate: estimateScan(input, { monthCallsBySku }), queries: queries.length };
}

async function findOrCreateRegion(db: DbExecutor, r: RegionInput, now: number): Promise<number> {
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

/** Bir taramayı başlatmadan önce yalnızca OKUYARAK hazırlanan plan (işlem dışında hesaplanır). */
export interface PreparedScan {
  req: ScanRequest;
  input: PlanInput;
  queries: ScanQuery[];
  units: ReturnType<typeof planUnits>["units"];
  estimate: ScanEstimate;
  provider: ProviderId;
  scanKey: string;
}

/** Plan, tahmin ve tarama anahtarı. Kayıt oluşturmaz; `PlanError` fırlatabilir. */
export async function prepareScan(db: Db, req: ScanRequest): Promise<PreparedScan> {
  const { input, queries } = await resolvePlan(db, req);
  const { units } = planUnits(input); // doğrulama + birim üretimi (PlanError fırlatabilir)
  const { estimate } = await estimateForRequest(db, req);
  const provider = (await getSetting(db, "places.provider")) as ProviderId;
  const scanKey = computeScanKey({
    bbox: input.bbox,
    circle: input.circle,
    queries,
    strategy: input.strategy,
  });
  return { req, input, queries, units, estimate, provider, scanKey };
}

export const ACTIVE_SCAN_STATUSES = ["queued", "running", "paused", "budget_stopped"] as const;

/** Aynı tarama anahtarıyla sürmekte, kuyrukta veya duraklatılmış tarama (varsa kimliği). */
export async function activeScanForKey(db: DbExecutor, scanKey: string): Promise<number | null> {
  const rows = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.scanKey, scanKey), inArray(scans.status, [...ACTIVE_SCAN_STATUSES])))
    .limit(1);
  return rows[0]?.id ?? null;
}

export interface StartScanOptions {
  origin?: ScanOrigin;
  scheduleId?: number | null;
  /** Zamanlamanın çalışma anı (eski `next_run_at`); (schedule_id, slot) tekil indeksle korunur. */
  scheduleSlot?: number | null;
  /** İş önceliği: elle 10 (önce), zamanlanmış 5. */
  priority?: number;
  /** Bilinen bölge (zamanlama); verilmezse ad + geometriyle bulunur/oluşturulur. */
  regionId?: number;
}

/**
 * Hazırlanmış taramayı TEK İŞLEMDE kaydeder: bölge, tarama, birimler ve iş birlikte yazılır ya da hiçbiri yazılmaz
 * (önceden ara bir çöküş birimsiz "kuyrukta" tarama bırakabiliyordu; o tarama 0 yerle "tamamlanıp" önceki yerleri
 * "bulunamadı" işaretliyordu). Aynı anahtarla etkin tarama varsa `ScanGateError('ACTIVE_SCAN')` fırlatır.
 * Çağıran bir işlem içindeyse `tx` olarak onu verir (zamanlayıcının CAS'ı ile aynı işlem).
 */
export async function insertPreparedScan(
  tx: DbExecutor,
  p: PreparedScan,
  opts: StartScanOptions = {},
  now: number = Date.now(),
): Promise<CreatedScan> {
  if ((await activeScanForKey(tx, p.scanKey)) !== null)
    throw new ScanGateError("ACTIVE_SCAN", ACTIVE_SCAN_MESSAGE);
  const regionId = opts.regionId ?? (await findOrCreateRegion(tx, p.req.region, now));
  const origin = opts.origin ?? "manual";
  const inserted = await tx
    .insert(scans)
    .values({
      regionId,
      scanKey: p.scanKey,
      categorySetIds: p.req.categoryIds,
      queries: p.queries,
      strategy: p.input.strategy,
      fieldProfile: p.input.fieldProfile,
      provider: p.provider,
      status: "queued",
      estimate: p.estimate,
      progress: { unitsTotal: p.units.length, unitsDone: 0, placesFound: 0, callsTotal: 0 },
      createdAt: now,
      origin,
      scheduleId: origin === "schedule" ? (opts.scheduleId ?? null) : null,
      scheduleSlot: origin === "schedule" ? (opts.scheduleSlot ?? now) : null,
    })
    .returning({ id: scans.id });
  const scanId = inserted[0]!.id;
  await insertUnits(tx, scanId, p.units, now);
  await tx.insert(jobs).values({
    type: "scan.run",
    payload: { scanId },
    status: "queued",
    priority: opts.priority ?? (origin === "schedule" ? 5 : 10),
    maxAttempts: 1,
    runAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await audit(
    tx,
    "scan.created",
    "scan",
    scanId,
    {
      region: p.req.region.name,
      queries: p.queries.length,
      estimate: p.estimate.calls,
      origin,
      ...(opts.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    },
    now,
  );
  return { scanId, estimate: p.estimate };
}

/** Taramayı oluşturur ve kuyruğa alır. Kullanıcı tahmini onayladıktan sonra çağrılır. */
export async function createAndStartScan(
  db: Db,
  req: ScanRequest,
  now: number = Date.now(),
  opts: StartScanOptions = {},
): Promise<CreatedScan> {
  const prepared = await prepareScan(db, req);
  return db.transaction((tx) => insertPreparedScan(tx, prepared, opts, now));
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
