import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { canSpend, recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { places, regions, scanUnits, scans } from "@/lib/db/schema";
import type { SkuId } from "@/lib/domain/types";
import { emitEvent } from "@/lib/events";
import { splitBBox, bboxCircumCircle } from "@/lib/geo/bbox";
import type { NoveltyConfig } from "@/lib/novelty/score";
import { PlacesApiError } from "@/lib/places/errors";
import { DISCOVERY_FIELDS, ENRICH_FIELDS, skuFor } from "@/lib/places/fields";
import type { PlacesProvider, SearchResult } from "@/lib/places/provider";
import { typeToQuery } from "@/lib/places/provider";
import { chunk, errorMessage, sleep as defaultSleep } from "@/lib/util";
import { recomputeNovelty } from "./novelty-sync";
import {
  APP_STOPPED,
  BUDGET_STOP_CODE,
  CALL_LIMIT,
  COST_CAP,
  providerPauseCode,
} from "./pause-codes";
import { onScanCompleted, onScanFailed, onScanPaused } from "./scan-notifications";
import { canSubdivide } from "./planner";
import {
  countSnapshot,
  insertUnits,
  loadScan,
  nextQueuedUnit,
  persistPlaces,
  saveProgress,
  scanStatusOf,
  setScanStatus,
  unitBBox,
  unitCounts,
  type ScanRow,
  type UnitRow,
} from "./store";

export interface RunnerDeps {
  db: Db;
  provider: PlacesProvider;
  getBudgetUsd: () => Promise<number>;
  getNoveltyConfig: () => Promise<NoveltyConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** İki Google çağrısı arasındaki asgari bekleme (kibar hız sınırı). */
  minIntervalMs?: number;
  /** Uygulama kapanırken `true` olur; tarama güvenle duraklatılır. */
  shouldStop?: () => boolean;
  log?: (message: string) => void;
}

export type ScanOutcome = "completed" | "paused" | "cancelled" | "failed" | "budget_stopped";

interface RunState {
  callsBySku: Record<string, number>;
  costUsd: number;
  callsTotal: number;
  unitsFailed: number;
  consecutiveUnitFailures: number;
  newPlaces: number;
  /** Faz 4: FUTURE_OPENING → OPERATIONAL geçişi görülen yer sayısı (persistPlaces().openedIds). */
  openedPlaces: number;
  maxCalls: number;
  /** Zamanlanmış taramanın onaylı toplam maliyet tavanı (`readCostCap`); yoksa null. */
  costCapUsd: number | null;
  regionCountry: string | null;
}

const MAX_CONSECUTIVE_UNIT_FAILURES = 5;
/** Faz 4 duraklatma kodları (`pause-codes.ts`); işçi kurtarması buradan içe aktarır. */
export { APP_STOPPED, INTERRUPTED } from "./pause-codes";

function readMaxCalls(scan: ScanRow): number {
  const est = scan.estimate as { maxCalls?: number } | null;
  return typeof est?.maxCalls === "number" ? est.maxCalls : 5000;
}

/**
 * Zamanlanmış taramanın onaylı TOPLAM maliyet tavanı (USD) ya da `null`. Tavan tarama oluşturulurken yazılır
 * (schedule.ts `runSchedule`) ve tüm çalıştırmalarda `scans.cost_usd` (birikimli) ile karşılaştırılır: geçici hatadan,
 * uygulama kapanışından veya bütçe yenilenmesinden sonraki kendiliğinden sürdürmeler (`effectiveMaxCalls` her seferinde
 * yeni çağrı payı verir) onaylanan tutarı AŞAMAZ. Elle başlatılan taramada tavan yoktur.
 */
export function readCostCap(scan: Pick<ScanRow, "origin" | "estimate">): number | null {
  if (scan.origin !== "schedule") return null;
  const cap = (scan.estimate as { costCapUsd?: unknown } | null)?.costCapUsd;
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : null;
}

/**
 * Güvenlik çağrı sınırı. İlk çalıştırmada tahminden türetilen sınırdır. Kullanıcı duraklamış bir taramayı
 * SÜRDÜRDÜĞÜNDE, o zamana kadar yapılmış çağrıların üstüne sınırın yarısı kadar yeni pay verilir; böylece
 * "Devam et" her zaman ilerler ama kontrolsüz de sürmez (her duraklamada kullanıcıya yeniden sorulur).
 */
export function effectiveMaxCalls(estimateMax: number, callsSoFar: number): number {
  return Math.max(estimateMax, callsSoFar + Math.ceil(estimateMax * 0.5));
}

/**
 * Bir taramanın kalan birimlerini çalıştırır. Yeniden başlatılabilir: durum tamamen veritabanındadır,
 * "running" kalmış birimler kuyruğa döner ve tarama kaldığı yerden devam eder.
 * Ücretli her çağrıdan önce bütçe denetlenir; geçici hatalarda tarama duraklatılır, kalıcı hatalarda başarısız olur.
 */
export async function runScan(deps: RunnerDeps, scanId: number): Promise<ScanOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  const scan = await loadScan(db, scanId);
  if (!scan) throw new Error(`Tarama bulunamadı: ${scanId}`);
  if (scan.status !== "queued" && scan.status !== "running") {
    return scan.status === "completed" ||
      scan.status === "failed" ||
      scan.status === "cancelled" ||
      scan.status === "budget_stopped"
      ? scan.status
      : "paused";
  }

  await setScanStatus(db, scanId, "running", { startedAt: scan.startedAt ?? now() });
  await db
    .update(scanUnits)
    .set({ status: "queued", updatedAt: now() })
    .where(and(eq(scanUnits.scanId, scanId), eq(scanUnits.status, "running")));

  const state: RunState = {
    callsBySku: { ...(scan.callsBySku ?? {}) },
    costUsd: scan.costUsd ?? 0,
    callsTotal: Object.values(scan.callsBySku ?? {}).reduce((a, b) => a + b, 0),
    unitsFailed: (await unitCounts(db, scanId)).failed,
    consecutiveUnitFailures: 0,
    newPlaces: 0,
    openedPlaces: scan.progress?.openedPlaces ?? 0,
    maxCalls: 0,
    costCapUsd: readCostCap(scan),
    regionCountry:
      (
        await db
          .select({ cc: regions.countryCode })
          .from(regions)
          .where(eq(regions.id, scan.regionId))
          .limit(1)
      )[0]?.cc ?? null,
  };
  state.maxCalls = effectiveMaxCalls(readMaxCalls(scan), state.callsTotal);

  for (;;) {
    const current = await scanStatusOf(db, scanId);
    if (current === "paused" || current === "cancelled") return current;
    if (deps.shouldStop?.()) {
      await setScanStatus(db, scanId, "paused", {
        pauseReason: "Uygulama kapatıldı; devam edebilirsiniz.",
        pauseCode: APP_STOPPED,
      });
      return "paused";
    }

    const unit = await nextQueuedUnit(db, scanId);
    if (!unit) break;

    const result = await runUnit(deps, scan, unit, state, now, log);
    await syncProgress(db, scanId, state);
    if (result !== "ok") return result;
  }

  return finalizeScan(deps, scanId, state, now, log);
}

type UnitResult = "ok" | ScanOutcome;

async function runUnit(
  deps: RunnerDeps,
  scan: ScanRow,
  unit: UnitRow,
  state: RunState,
  now: () => number,
  log: (m: string) => void,
): Promise<UnitResult> {
  const { db, provider } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const fields = scan.fieldProfile === "enrich" ? ENRICH_FIELDS : DISCOVERY_FIELDS;
  const cap = unit.kind === "text" ? provider.maxTextResults : provider.maxNearbyResults;
  const sku: SkuId = skuFor(unit.kind === "text" ? "text" : "nearby", fields);
  const bbox = unitBBox(unit);

  await db
    .update(scanUnits)
    .set({ status: "running", updatedAt: now() })
    .where(eq(scanUnits.id, unit.id));

  let token: string | undefined;
  let collected = 0;
  let calls = 0;

  const requeue = async () => {
    await db
      .update(scanUnits)
      .set({ status: "queued", callsMade: unit.callsMade + calls, updatedAt: now() })
      .where(eq(scanUnits.id, unit.id));
  };

  do {
    // Güvenlik: tahminin çok üstüne çıkan taramayı duraklat.
    if (state.callsTotal >= state.maxCalls) {
      await requeue();
      await setScanStatus(db, scan.id, "paused", {
        pauseReason: `Güvenlik sınırı: bu tarama ${state.maxCalls} çağrıyı aştı. Devam etmek için taramayı sürdürün.`,
        pauseCode: CALL_LIMIT,
      });
      await onScanPaused(db, scan.id, now(), log);
      return "paused";
    }

    const status = await scanStatusOf(db, scan.id);
    if (status === "paused" || status === "cancelled") {
      await requeue();
      return status;
    }
    if (deps.shouldStop?.()) {
      await requeue();
      await setScanStatus(db, scan.id, "paused", {
        pauseReason: "Uygulama kapatıldı; devam edebilirsiniz.",
        pauseCode: APP_STOPPED,
      });
      return "paused";
    }

    const spend = await canSpend(db, provider.id, await deps.getBudgetUsd(), sku, 1);
    if (!spend.ok) {
      await requeue();
      await setScanStatus(db, scan.id, "budget_stopped", {
        pauseReason: spend.reason,
        pauseCode: BUDGET_STOP_CODE,
      });
      await onScanPaused(db, scan.id, now(), log);
      return "budget_stopped";
    }
    // Zamanlanmış tarama: bir sonraki ücretli çağrı onaylı toplam tutarı aşacaksa çağrı YAPILMAZ.
    if (state.costCapUsd !== null && state.costUsd + spend.addUsd > state.costCapUsd + 1e-9) {
      await requeue();
      await setScanStatus(db, scan.id, "paused", {
        pauseReason: `Bu zamanlanmış tarama onayladığınız ${state.costCapUsd.toFixed(2)} USD tutarına ulaştı. Devam etmek için taramayı sürdürün; sürdürürseniz bu tavan bu tarama için kalkar.`,
        pauseCode: COST_CAP,
      });
      await onScanPaused(db, scan.id, now(), log);
      return "paused";
    }

    let res: SearchResult;
    try {
      res =
        unit.kind === "text"
          ? await provider.searchText({
              textQuery: unit.termKind === "type" ? typeToQuery(unit.term) : unit.term,
              includedType: unit.termKind === "type" ? unit.term : undefined,
              bbox,
              pageToken: token,
              fields,
              includeFutureOpening: true,
            })
          : await provider.searchNearby({
              includedTypes: unit.term.split(","),
              circle: bboxCircumCircle(bbox),
              fields,
              includeFutureOpening: true,
            });
    } catch (e) {
      return handleCallError(deps, scan, unit, state, e, requeue, now, log);
    }

    calls++;
    state.callsTotal++;
    state.callsBySku[res.sku] = (state.callsBySku[res.sku] ?? 0) + 1;
    state.costUsd += await recordUsage(db, provider.id, res.sku, 1, now());

    const saved = await persistPlaces(db, scan.id, res.places, now(), {
      queries: scan.queries,
      unit: { kind: unit.kind, termKind: unit.termKind, term: unit.term },
      regionCountry: state.regionCountry,
    });
    state.newPlaces += saved.inserted;
    state.openedPlaces += saved.openedIds.length;
    collected += res.places.length;
    token = res.nextPageToken;

    // Kibar hız sınırı yalnızca gerçek Google çağrıları için gerekir; demo sağlayıcıda kısa tutulur.
    await sleep(deps.minIntervalMs ?? (provider.id === "mock" ? 20 : 150));
  } while (token && collected < cap);

  const saturated = collected >= cap;
  await db
    .update(scanUnits)
    .set({
      status: "done",
      callsMade: unit.callsMade + calls,
      resultCount: collected,
      saturated,
      updatedAt: now(),
    })
    .where(eq(scanUnits.id, unit.id));
  state.consecutiveUnitFailures = 0;

  if (saturated && canSubdivide({ bbox, depth: unit.depth, kind: unit.kind })) {
    await insertUnits(
      db,
      scan.id,
      splitBBox(bbox).map((b) => ({
        bbox: b,
        kind: unit.kind,
        termKind: unit.termKind,
        term: unit.term,
        depth: unit.depth + 1,
        parentId: unit.id,
      })),
      now(),
    );
    log(`Birim ${unit.id} doygun (${collected} sonuç); 4 alt hücreye bölündü.`);
  }
  return "ok";
}

async function handleCallError(
  deps: RunnerDeps,
  scan: ScanRow,
  unit: UnitRow,
  state: RunState,
  e: unknown,
  requeue: () => Promise<void>,
  now: () => number,
  log: (m: string) => void,
): Promise<UnitResult> {
  const { db } = deps;
  if (!(e instanceof PlacesApiError)) {
    const message = errorMessage(e);
    log(`Beklenmeyen hata: ${message}`);
    await requeue();
    await setScanStatus(db, scan.id, "failed", { error: message, finishedAt: now() });
    await emitEvent("scan.failed", { scanId: scan.id, error: message });
    await onScanFailed(db, scan.id, now(), log);
    return "failed";
  }

  if (e.isPausable) {
    // Kota, hız sınırı, ağ veya geçici sunucu hatası: tarama duraklatılır, kullanıcı sonra devam ettirir (NFR-04).
    // Kod (PROVIDER_*) zamanlanmış taramanın bir saat sonra kendiliğinden sürdürülmesini sağlar (schedule.ts).
    await requeue();
    await setScanStatus(db, scan.id, "paused", {
      pauseReason: e.message,
      pauseCode: providerPauseCode(e.kind),
    });
    await onScanPaused(db, scan.id, now(), log);
    return "paused";
  }

  if (e.kind === "invalid" || e.kind === "not_found") {
    // Tek bir sorgu geçersiz (ör. desteklenmeyen tür): yalnızca bu birim başarısız sayılır, tarama sürer.
    await db
      .update(scanUnits)
      .set({ status: "failed", error: e.message, updatedAt: now() })
      .where(eq(scanUnits.id, unit.id));
    state.unitsFailed++;
    state.consecutiveUnitFailures++;
    log(`Birim ${unit.id} (${unit.term}) reddedildi: ${e.message}`);
    if (state.consecutiveUnitFailures >= MAX_CONSECUTIVE_UNIT_FAILURES) {
      await setScanStatus(db, scan.id, "failed", { error: e.message, finishedAt: now() });
      await emitEvent("scan.failed", { scanId: scan.id, error: e.message });
      await onScanFailed(db, scan.id, now(), log);
      return "failed";
    }
    return "ok";
  }

  // auth, billing, disabled, unknown: devam etmek anlamsız.
  await requeue();
  await setScanStatus(db, scan.id, "failed", { error: e.message, finishedAt: now() });
  await emitEvent("scan.failed", { scanId: scan.id, error: e.message });
  await onScanFailed(db, scan.id, now(), log);
  return "failed";
}

async function syncProgress(db: Db, scanId: number, state: RunState): Promise<void> {
  const [units, snap] = await Promise.all([unitCounts(db, scanId), countSnapshot(db, scanId)]);
  await saveProgress(db, scanId, {
    unitsTotal: units.total,
    unitsDone: units.done + units.failed,
    unitsFailed: units.failed,
    placesFound: snap.total,
    futureOpening: snap.future,
    newPlaces: state.newPlaces,
    openedPlaces: state.openedPlaces,
    callsTotal: state.callsTotal,
    callsBySku: state.callsBySku,
    costUsd: Math.round(state.costUsd * 10_000) / 10_000,
  });
}

/** Karşılaştırılabilir önceki tarama: aynı anahtar, tamamlanmış, hatasız birimlerle. */
async function findPreviousComparable(db: Db, scan: ScanRow): Promise<ScanRow | undefined> {
  const rows = await db
    .select()
    .from(scans)
    .where(
      and(eq(scans.scanKey, scan.scanKey), eq(scans.status, "completed"), lt(scans.id, scan.id)),
    )
    .orderBy(desc(scans.id))
    .limit(10);
  return rows.find(
    (r) => ((r.progress as { unitsFailed?: number } | null)?.unitsFailed ?? 0) === 0,
  );
}

async function finalizeScan(
  deps: RunnerDeps,
  scanId: number,
  state: RunState,
  now: () => number,
  log: (m: string) => void,
): Promise<ScanOutcome> {
  const { db } = deps;
  const scan = (await loadScan(db, scanId))!;
  const units = await unitCounts(db, scanId);
  const comparable = units.failed === 0;
  const previous = comparable ? await findPreviousComparable(db, scan) : undefined;
  const t = now();

  let newDetected = 0;
  if (previous) {
    // Yeni: bu taramada VE ilk kez bu taramada görülmüş, önceki taramanın snapshot'ında olmayanlar.
    const newRows = await db.all<{ place_id: string }>(sql`
      SELECT s.place_id AS place_id
      FROM place_snapshots s
      JOIN places p ON p.place_id = s.place_id
      WHERE s.scan_id = ${scanId}
        AND p.first_seen_scan_id = ${scanId}
        AND NOT EXISTS (SELECT 1 FROM place_snapshots o WHERE o.scan_id = ${previous.id} AND o.place_id = s.place_id)
    `);
    const newIds = newRows.map((r) => r.place_id);
    for (const part of chunk(newIds, 500)) {
      await db
        .update(places)
        .set({ newDetectedAt: t })
        .where(and(inArray(places.placeId, part), sql`${places.newDetectedAt} IS NULL`));
    }
    newDetected = newIds.length;

    // Önceki taramada vardı, bu taramada yok: kapandı demek değildir, yalnızca "bulunamadı".
    const missingRows = await db.all<{ place_id: string }>(sql`
      SELECT o.place_id AS place_id
      FROM place_snapshots o
      WHERE o.scan_id = ${previous.id}
        AND NOT EXISTS (SELECT 1 FROM place_snapshots s WHERE s.scan_id = ${scanId} AND s.place_id = o.place_id)
    `);
    for (const part of chunk(
      missingRows.map((r) => r.place_id),
      500,
    )) {
      await db
        .update(places)
        .set({ notFoundInScanId: scanId })
        .where(inArray(places.placeId, part));
    }
  }

  await recomputeNovelty(db, await deps.getNoveltyConfig(), { scanId, now: t });

  const snap = await countSnapshot(db, scanId);
  await db
    .update(scans)
    .set({
      status: "completed",
      pauseReason: null,
      error: null,
      finishedAt: t,
      isBaseline: comparable && !previous,
      comparedToScanId: previous?.id ?? null,
    })
    .where(eq(scans.id, scanId));
  await syncProgress(db, scanId, { ...state, newPlaces: previous ? newDetected : state.newPlaces });
  await db.update(regions).set({ lastScanAt: t }).where(eq(regions.id, scan.regionId));
  await audit(db, "scan.completed", "scan", scanId, {
    places: snap.total,
    newDetected,
    baseline: comparable && !previous,
    calls: state.callsTotal,
    costUsd: state.costUsd,
    openedPlaces: state.openedPlaces,
    origin: scan.origin,
  });
  await emitEvent("scan.completed", { scanId, newPlaces: newDetected, totalPlaces: snap.total });
  // Bildirimler doğrudan yazılır (olay yolu en iyi çabadır ve hataları yutar); dedupe_key ile tarama başına tek.
  await onScanCompleted(
    db,
    { scanId, newDetected, openedPlaces: state.openedPlaces, compared: !!previous },
    t,
    log,
  );
  return "completed";
}
