import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { COST_CAP, PROVIDER_CHANGED, USER_PAUSED } from "./pause-codes";
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
  /** Zamanlanmış tarama: onaylı toplam maliyet tavanı (USD); `estimate.costCapUsd` olarak saklanır. */
  costCapUsd?: number | null;
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
      estimate:
        origin === "schedule" && typeof opts.costCapUsd === "number"
          ? { ...p.estimate, costCapUsd: opts.costCapUsd }
          : p.estimate,
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

async function hasActiveJob(db: DbExecutor, scanId: number): Promise<boolean> {
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

/** İşlem içinde: tarama için kuyrukta/çalışan `scan.run` işi yoksa ekler (denetim ve ekleme aynı işlemde). */
async function enqueueScanJobTx(
  tx: DbExecutor,
  scanId: number,
  now: number,
  priority = 10,
): Promise<boolean> {
  if (await hasActiveJob(tx, scanId)) return false;
  await tx.insert(jobs).values({
    type: "scan.run",
    payload: { scanId },
    status: "queued",
    priority,
    maxAttempts: 1,
    runAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

/** Kuyrukta (`queued`) olup işi kaybolmuş taramanın kendiliğinden yeniden kuyruğa alınması için bekleme süresi. */
export const ORPHAN_SCAN_GRACE_MS = 2 * 60_000;

/**
 * Öksüz tarama onarımı (zamanlama turunda çalışır): `queued` durumda olup kuyrukta/çalışan `scan.run` işi olmayan ve
 * son işi (yoksa oluşturulması) `ORPHAN_SCAN_GRACE_MS`'den eski taramalar yeniden kuyruğa alınır. Böyle tarama eski
 * sürümlerdeki atomik olmayan sürdürme ya da iş eklenmeden çöken bir süreçten kalabilir; aksi halde sonsuza dek
 * "Sırada" görünür ve zamanlaması PREVIOUS_RUN_ACTIVE ile atlanırdı. Durum ve iş denetimi ekleme ile aynı işlemdedir.
 */
export async function requeueOrphanScans(
  db: Db,
  now: number,
  log?: (m: string) => void,
  limit = 20,
): Promise<number[]> {
  const lastJobAt = sql<number | null>`(select max(${jobs.updatedAt}) from ${jobs}
    where ${jobs.type} = 'scan.run' and json_extract(${jobs.payload}, '$.scanId') = ${scans.id})`;
  const candidates = await db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        eq(scans.status, "queued"),
        sql`not exists (select 1 from ${jobs} where ${jobs.type} = 'scan.run'
          and ${jobs.status} in ('queued', 'running')
          and json_extract(${jobs.payload}, '$.scanId') = ${scans.id})`,
        sql`coalesce(${lastJobAt}, ${scans.createdAt}) <= ${now - ORPHAN_SCAN_GRACE_MS}`,
      ),
    )
    .orderBy(scans.id)
    .limit(limit);
  const out: number[] = [];
  for (const { id } of candidates) {
    const done = await db.transaction(async (tx) => {
      const still = await tx
        .select({ id: scans.id })
        .from(scans)
        .where(and(eq(scans.id, id), eq(scans.status, "queued")))
        .limit(1);
      if (still.length === 0) return false;
      if (!(await enqueueScanJobTx(tx, id, now))) return false;
      await audit(tx, "scan.requeued_orphan", "scan", id, {}, now);
      return true;
    });
    if (done) {
      out.push(id);
      log?.(`tarama #${id}: işi kaybolmuştu, yeniden kuyruğa alındı`);
    }
  }
  return out;
}

/**
 * Duraklat/sürdür/iptal hata kodları → HTTP durumu (control rotası). Her kodun TR+EN `apiError.<KOD>` metni vardır
 * (tests/api-error-text.test.ts); İngilizce arayüz Türkçe sunucu metnini göstermez.
 */
export const SCAN_CONTROL_STATUS = {
  SCAN_NOT_FOUND: 404,
  SCAN_NOT_PAUSABLE: 409,
  SCAN_NOT_RESUMABLE: 409,
  SCAN_PROVIDER_CHANGED: 409,
  BUDGET_BLOCKED: 409,
  SCAN_CHANGED: 409,
  SCAN_FINISHED: 409,
} as const;
export type ScanControlCode = keyof typeof SCAN_CONTROL_STATUS;

export type ControlResult = { ok: true } | { ok: false; error: string; code: ScanControlCode };

export async function pauseScan(db: Db, scanId: number): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı.", code: "SCAN_NOT_FOUND" };
  if (scan.status !== "queued" && scan.status !== "running")
    return {
      ok: false,
      error: "Yalnızca sürmekte olan tarama duraklatılabilir.",
      code: "SCAN_NOT_PAUSABLE",
    };
  await setScanStatus(db, scanId, "paused", {
    pauseReason: "Siz duraklattınız.",
    pauseCode: USER_PAUSED,
  });
  return { ok: true };
}

export async function resumeScan(db: Db, scanId: number): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı.", code: "SCAN_NOT_FOUND" };
  if (scan.status !== "paused" && scan.status !== "budget_stopped") {
    return {
      ok: false,
      error: "Yalnızca duraklatılmış veya bütçe nedeniyle durmuş tarama sürdürülebilir.",
      code: "SCAN_NOT_RESUMABLE",
    };
  }
  if (
    scan.pauseCode === PROVIDER_CHANGED ||
    scan.provider !== (await getSetting(db, "places.provider"))
  ) {
    return {
      ok: false,
      error: "Yer sağlayıcısı değiştiği için bu tarama sürdürülemez. Yeni bir tarama başlatın.",
      code: "SCAN_PROVIDER_CHANGED",
    };
  }
  const budget = await budgetStatus(db, scan.provider, await getSetting(db, "budget.monthlyUsd"));
  if (budget.level === "blocked") {
    return {
      ok: false,
      error:
        "Aylık bütçe sınırına ulaşıldı. Ayarlar'dan bütçeyi artırın veya gelecek ayı bekleyin.",
      code: "BUDGET_BLOCKED",
    };
  }
  // Onaylı maliyet tavanında duran zamanlanmış taramayı kullanıcı ELLE sürdürüyorsa bu açık bir onaydır: tavan kalkar
  // (tarama elle başlatılmış gibi sürer; güvenlik çağrı sınırı ve aylık bütçe yine geçerlidir).
  const liftCap =
    scan.pauseCode === COST_CAP && !!scan.estimate && typeof scan.estimate === "object";
  // Tek işlem + karşılaştır-ve-yaz: durum geçişi, tavanın kaldırılması, denetim kaydı ve iş ekleme birlikte olur ya da
  // hiç olmaz. Aksi halde iş eklenemeden bir hata `queued` ama işi olmayan (sonsuza dek "Sırada") tarama bırakırdı;
  // eşzamanlı iki sürdürme de çift iş/denetim yazamaz. Okumadan sonra değişen tarama (ör. sağlayıcı değişti →
  // PROVIDER_CHANGED, kullanıcı iptal etti) sürdürülmez.
  const now = Date.now();
  const moved = await db.transaction(async (tx) => {
    const rows = await tx
      .update(scans)
      .set({
        status: "queued",
        pauseReason: null,
        pauseCode: null,
        error: null,
        ...(liftCap ? { estimate: { ...(scan.estimate as object), costCapUsd: null } } : {}),
      })
      .where(
        and(
          eq(scans.id, scanId),
          eq(scans.status, scan.status),
          scan.pauseCode === null ? isNull(scans.pauseCode) : eq(scans.pauseCode, scan.pauseCode),
        ),
      )
      .returning({ id: scans.id });
    if (rows.length === 0) return false;
    if (liftCap) await audit(tx, "scan.cost_cap_lifted", "scan", scanId, {}, now);
    await enqueueScanJobTx(tx, scanId, now);
    return true;
  });
  if (!moved)
    return {
      ok: false,
      error: "Tarama bu sırada değişti. Sayfayı yenileyip yeniden deneyin.",
      code: "SCAN_CHANGED",
    };
  return { ok: true };
}

export async function cancelScan(
  db: Db,
  scanId: number,
  now: number = Date.now(),
): Promise<ControlResult> {
  const scan = await loadScan(db, scanId);
  if (!scan) return { ok: false, error: "Tarama bulunamadı.", code: "SCAN_NOT_FOUND" };
  if (["completed", "failed", "cancelled"].includes(scan.status))
    return { ok: false, error: "Tarama zaten bitmiş.", code: "SCAN_FINISHED" };
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
