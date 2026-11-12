import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  jobs,
  regions,
  scanSchedules,
  scans,
  type ScheduleIntervalDays,
  type ScheduleOutcome,
} from "@/lib/db/schema";
import type { RegionInput } from "@/lib/domain/types";
import { getSetting, setSetting } from "@/lib/settings";
import { errorMessage } from "@/lib/util";
import { uniqueViolationOn } from "./db-errors";
import { ScanGateError, type GateCode } from "./gate-error";
import {
  budgetSummary,
  checkCollectionReady,
  checkPaidScan,
  checkProviderKey,
  checkTargetCountry,
} from "./gates";
import { isAutoResumable, type OwnRunCode } from "./pause-codes";
import { PlanError } from "./planner";
import { safeNotify } from "./scan-notifications";
import { checkScheduleCategorySets, CATEGORY_SET_MISSING } from "./schedule-categories";
import {
  ACTIVE_SCAN_STATUSES,
  insertPreparedScan,
  prepareScan,
  type PreparedScan,
  type ScanRequest,
} from "./service";

/**
 * Zamanlanmış (tekrarlanan) taramalar (Faz 4, madde 1; SRS FR-DIS-07). Tasarım:
 *
 * - Kaynak `scan_schedules` satırıdır (tarama anahtarı başına tek zamanlama). Arka plan işi `scan.schedule.tick` her 5
 *   dakikada (ve Electron "uyan" dürtüsünde) `runDueSchedules` çağırır.
 * - Kaçırılan çalışmalar BİRLEŞTİRİLİR: uygulama 3 aralık kapalı kaldıysa açılışta tek tarama yapılır ve
 *   `missed_runs = 3` kaydedilir; sonraki çalışma `şimdi + aralık`tır (birikmiş kuyruk yeniden oynatılmaz).
 * - Bir an (eski `next_run_at`) en çok bir tarama doğurur: CAS (`… WHERE id = ? AND next_run_at = ?eski`) ve
 *   (schedule_id, schedule_slot) tekil indeksi aynı işlemdedir. İki eşzamanlı tick'ten yalnızca biri kazanır.
 * - Kapılar etkileşimli taramayla AYNIDIR (gates.ts); arka plan riski kendisi onaylamaz. M5: kullanıcı zamanlamayı
 *   oluştururken/düzenlerken bir üst sınırı (`ack_max_usd`) önceden onaylar; tahmin bunu aşarsa NEEDS_ACK ile atlanır.
 * - Atlamada tarama oluşmaz; `last_outcome='skipped'`, `last_skip_code` yazılır, `next_run_at` yeniden deneme anına
 *   kayar ve gün başına tekil bir `schedule.skipped` bildirimi üretilir.
 * - Zamanlamanın KENDİ son taraması henüz bitmediyse yeni tarama açılmaz (aynı anahtar ACTIVE_SCAN olurdu):
 *   kuyrukta/çalışıyorsa sessizce bir saat sonra (PREVIOUS_RUN_ACTIVE); geçici hata, kapanış veya bütçe nedeniyle
 *   durduysa ve kapılar izin veriyorsa KALDIĞI YERDEN sürdürülür (`resumed`); kullanıcı duraklattıysa ya da güvenlik
 *   sınırına takıldıysa SCAN_PAUSED ile atlanır (kullanıcıya "sürdürün ya da iptal edin" denir). Böylece kendi kendine
 *   duran bir tarama zamanlamayı kalıcı olarak kilitlemez (inceleme P1).
 * - M2 (yalnızca demo sağlayıcı): her zamanlanmış çalışma demo zamanını (`mock.epoch`) bir ilerletir; böylece demo
 *   modunda da yeni/açılan işletmeler birikir. Google sağlayıcısında asla dokunulmaz.
 * Bütün fonksiyonlar `now` alır (M1 kabul testi saat enjeksiyonu).
 */

export const DAY_MS = 86_400_000;
export const SCHEDULE_INTERVALS: readonly ScheduleIntervalDays[] = [7, 14, 30];
export const DEFAULT_INTERVAL_DAYS: ScheduleIntervalDays = 14;
export const SCHEDULE_TICK_JOB = "scan.schedule.tick";
export const TICK_INTERVAL_MS = 5 * 60_000;
/** İlk tick uygulama açıldıktan 60 sn sonra (açılış yükü ve kullanıcının ilk ekranı önce). */
export const FIRST_TICK_DELAY_MS = 60_000;
export const MAX_DEMO_EPOCH = 50;

export type ScheduleSkipCode = GateCode | typeof CATEGORY_SET_MISSING | "PLAN_INVALID" | OwnRunCode;

export const HOUR_MS = 3_600_000;

/**
 * Atlama kodu → yeniden deneme gecikmesi. Kısa (bir saat): başka/önceki tarama sürüyor veya geçici Google hatası.
 * Diğerleri (bütçe, onay, kurulum, kullanıcının duraklattığı tarama) bir gün.
 */
export function retryDelayMs(code: ScheduleSkipCode): number {
  return code === "ACTIVE_SCAN" || code === "PREVIOUS_RUN_ACTIVE" || code === "SCAN_RETRYING"
    ? HOUR_MS
    : DAY_MS;
}

export type ScheduleRow = typeof scanSchedules.$inferSelect;

export interface DueInfo {
  due: boolean;
  /** Bu çalışmanın anı (eski `next_run_at`); tarama `schedule_slot` olarak bunu taşır. */
  slot: number;
  /** Birleştirilen (yeniden oynatılmayan) kaçırılmış aralık sayısı. */
  missedRuns: number;
}

export function computeDue(
  s: Pick<ScheduleRow, "enabled" | "nextRunAt" | "intervalDays">,
  now: number,
): DueInfo {
  const due = s.enabled && now >= s.nextRunAt;
  return {
    due,
    slot: s.nextRunAt,
    missedRuns: due ? Math.floor((now - s.nextRunAt) / (s.intervalDays * DAY_MS)) : 0,
  };
}

/** Çalışmadan sonra yeniden çapala: kaçırılanlar birleşir, sonraki çalışma `now + aralık`. */
export function nextRunAfter(now: number, intervalDays: number): number {
  return now + intervalDays * DAY_MS;
}

/** UTC gün anahtarı (bildirim tekilleştirme). */
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Zamanlamanın tarama isteği (bölge kaydından). Bölge yoksa (silinmişse) null. */
export async function scheduleRequest(
  db: DbExecutor,
  s: ScheduleRow,
): Promise<{ request: ScanRequest; regionName: string } | null> {
  const r = (await db.select().from(regions).where(eq(regions.id, s.regionId)).limit(1))[0];
  if (!r) return null;
  const region: RegionInput = {
    kind: r.kind,
    name: r.name,
    countryCode: r.countryCode,
    bbox: r.geometry.bbox,
    circle: r.geometry.circle,
    cityId: r.geometry.cityId,
  };
  return {
    regionName: r.name,
    request: {
      region,
      categoryIds: s.categorySetIds,
      customKeywords: s.customKeywords,
      strategy: s.strategy,
      fieldProfile: s.fieldProfile,
    },
  };
}

export type ScheduleRunResult =
  | { scheduleId: number; outcome: "started"; scanId: number; missedRuns: number }
  | { scheduleId: number; outcome: "resumed"; scanId: number; missedRuns: number }
  | { scheduleId: number; outcome: "skipped"; code: ScheduleSkipCode; retryAt: number }
  | { scheduleId: number; outcome: "lost" };

/** Gate kontrolleri (yalnızca okuma). Başarıda hazırlanmış tarama planı döner. */
async function evaluate(
  db: Db,
  s: ScheduleRow,
  mode: { interactive: boolean; acknowledgeRisk?: boolean },
): Promise<
  | { ok: true; prepared: PreparedScan; regionName: string }
  | { ok: false; code: ScheduleSkipCode; message: string }
> {
  const ready = await checkCollectionReady(db);
  if (!ready.ok) return ready;
  const cats = await checkScheduleCategorySets(db, s.categorySetIds);
  if (!cats.ok)
    return {
      ok: false,
      code: CATEGORY_SET_MISSING,
      message: "Zamanlamanın kullandığı bir kategori artık yok.",
    };
  const req = await scheduleRequest(db, s);
  if (!req) return { ok: false, code: "SETUP_REQUIRED", message: "Bölge bulunamadı." };
  const country = await checkTargetCountry(db, req.request.region);
  if (country.blocked)
    return { ok: false, code: "COUNTRY_NOT_TARGETED", message: country.message ?? "" };
  const paid = await checkPaidScan(db, req.request, {
    acknowledgeRisk: mode.interactive ? mode.acknowledgeRisk : false,
    ackMaxUsd: mode.interactive ? undefined : s.ackMaxUsd,
  });
  if (!paid.ok) return paid;
  try {
    return { ok: true, prepared: await prepareScan(db, req.request), regionName: req.regionName };
  } catch (e) {
    if (e instanceof PlanError) return { ok: false, code: "PLAN_INVALID", message: e.message };
    throw e;
  }
}

async function bumpDemoEpoch(tx: DbExecutor, scheduleId: number, now: number): Promise<void> {
  if ((await getSetting(tx, "places.provider")) !== "mock") return;
  const epoch = await getSetting(tx, "mock.epoch");
  if (epoch >= MAX_DEMO_EPOCH) return;
  await setSetting(tx, "mock.epoch", epoch + 1);
  await audit(tx, "demo.epoch", "schedule", scheduleId, { epoch: epoch + 1, demoOnly: true }, now);
}

/**
 * Atlamayı kaydeder (CAS: başka tick bu anı ilerlettiyse dokunmaz) ve gün başına tekil bildirim üretir.
 * `notifyUser` false ise (etkileşimli "Şimdi çalıştır") bildirim üretilmez; kullanıcı hatayı ekranda görür.
 */
async function recordSkip(
  db: Db,
  s: ScheduleRow,
  code: ScheduleSkipCode,
  now: number,
  opts: { notifyUser: boolean; regionName?: string; log?: (m: string) => void },
): Promise<ScheduleRunResult> {
  const retryAt = now + retryDelayMs(code);
  const updated = await db
    .update(scanSchedules)
    .set({ nextRunAt: retryAt, lastOutcome: "skipped", lastSkipCode: code, updatedAt: now })
    .where(and(eq(scanSchedules.id, s.id), eq(scanSchedules.nextRunAt, s.nextRunAt)))
    .returning({ id: scanSchedules.id });
  if (updated.length === 0) return { scheduleId: s.id, outcome: "lost" };
  await audit(db, "schedule.skipped", "schedule", s.id, { code, retryAt }, now);
  if (opts.notifyUser)
    await safeNotify(
      db,
      {
        kind: "schedule.skipped",
        dedupeKey: `schedule.skipped:${s.id}:${code}:${dayKey(now)}`,
        params: { code, scheduleId: s.id, ...(opts.regionName ? { region: opts.regionName } : {}) },
        url: "/scans",
        entity: "schedule",
        entityId: s.id,
      },
      now,
      opts.log,
    );
  return { scheduleId: s.id, outcome: "skipped", code, retryAt };
}

/** Zamanlamanın son taraması hâlâ bitmemişse (kuyrukta/çalışıyor/duraklı/bütçe durdurdu) onu döndürür. */
async function ownUnfinishedRun(
  db: Db,
  s: ScheduleRow,
): Promise<{ id: number; status: string; pauseCode: string | null } | null> {
  if (s.lastScanId === null) return null;
  const row = (
    await db
      .select({ id: scans.id, status: scans.status, pauseCode: scans.pauseCode })
      .from(scans)
      .where(
        and(
          eq(scans.id, s.lastScanId),
          eq(scans.scheduleId, s.id),
          inArray(scans.status, [...ACTIVE_SCAN_STATUSES]),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

class ResumeRaceLost extends Error {}

/**
 * Zamanlamanın kendi duraklamış taramasını sürdürür: zamanlama CAS'ı, tarama durumu CAS'ı (paused|budget_stopped →
 * queued) ve iş kaydı TEK işlemde. Aynı an için iki tick'ten yalnızca biri kazanır; taramanın zaten bir işi varsa yenisi
 * eklenmez. Sonraki çalışma `şimdi + aralık` (tarama yeniden durursa çalıştırıcı bunu öne çeker).
 */
async function resumeOwnRun(
  db: Db,
  s: ScheduleRow,
  scanId: number,
  now: number,
  log?: (m: string) => void,
): Promise<ScheduleRunResult> {
  const { missedRuns } = computeDue(s, now);
  try {
    const ok = await db.transaction(async (tx) => {
      const cas = await tx
        .update(scanSchedules)
        .set({
          nextRunAt: nextRunAfter(now, s.intervalDays),
          lastRunAt: now,
          missedRuns,
          lastOutcome: "started" satisfies ScheduleOutcome,
          lastSkipCode: null,
          updatedAt: now,
        })
        .where(and(eq(scanSchedules.id, s.id), eq(scanSchedules.nextRunAt, s.nextRunAt)))
        .returning({ id: scanSchedules.id });
      if (cas.length === 0) return false;
      const moved = await tx
        .update(scans)
        .set({ status: "queued", pauseReason: null, pauseCode: null })
        .where(and(eq(scans.id, scanId), inArray(scans.status, ["paused", "budget_stopped"])))
        .returning({ id: scans.id });
      if (moved.length === 0) throw new ResumeRaceLost();
      const active = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, "scan.run"),
            inArray(jobs.status, ["queued", "running"]),
            sql`json_extract(${jobs.payload}, '$.scanId') = ${scanId}`,
          ),
        )
        .limit(1);
      if (active.length === 0)
        await tx.insert(jobs).values({
          type: "scan.run",
          payload: { scanId },
          status: "queued",
          priority: 5,
          maxAttempts: 1,
          runAt: now,
          createdAt: now,
          updatedAt: now,
        });
      await audit(tx, "schedule.resumed", "schedule", s.id, { scanId, missedRuns }, now);
      return true;
    });
    if (!ok) return { scheduleId: s.id, outcome: "lost" };
  } catch (e) {
    if (e instanceof ResumeRaceLost) return { scheduleId: s.id, outcome: "lost" };
    throw e;
  }
  log?.(`zamanlama #${s.id}: duraklamış tarama #${scanId} kaldığı yerden sürüyor`);
  return { scheduleId: s.id, outcome: "resumed", scanId, missedRuns };
}

/** Arka plan tick'i: zamanlamanın kendi bitmemiş taraması varsa yeni tarama yerine onu ele alır. */
async function handleOwnRun(
  db: Db,
  s: ScheduleRow,
  own: { id: number; status: string; pauseCode: string | null },
  now: number,
  log?: (m: string) => void,
): Promise<ScheduleRunResult> {
  // Hâlâ kuyrukta/çalışıyor: kullanıcıya söylenecek bir şey yok; bir saat sonra yeniden bakılır.
  if (own.status === "queued" || own.status === "running")
    return recordSkip(db, s, "PREVIOUS_RUN_ACTIVE", now, { notifyUser: false, log });
  if (!isAutoResumable(own.status, own.pauseCode))
    return recordSkip(db, s, "SCAN_PAUSED", now, { notifyUser: true, log });
  const ready = await checkCollectionReady(db);
  if (!ready.ok) return recordSkip(db, s, ready.code, now, { notifyUser: true, log });
  const key = await checkProviderKey(db);
  if (!key.ok) return recordSkip(db, s, key.code, now, { notifyUser: true, log });
  if ((await budgetSummary(db)).level === "blocked")
    return recordSkip(db, s, "SCAN_BUDGET_STOPPED", now, { notifyUser: true, log });
  return resumeOwnRun(db, s, own.id, now, log);
}

/**
 * Tek zamanlamayı bu an için çalıştırır (CAS + tarama oluşturma tek işlemde). `expectedNextRunAt` CAS değeridir.
 * Etkileşimli ("Şimdi çalıştır") çağrıda `slot = now` kullanılır ve `acknowledgeRisk` geçerlidir.
 */
export async function runSchedule(
  db: Db,
  s: ScheduleRow,
  now: number,
  mode: { interactive: boolean; acknowledgeRisk?: boolean; log?: (m: string) => void } = {
    interactive: false,
  },
): Promise<
  | ScheduleRunResult
  | { scheduleId: number; outcome: "gate"; code: ScheduleSkipCode; message: string }
> {
  const log = mode.log;
  const due = computeDue(s, now);
  if (!mode.interactive) {
    const own = await ownUnfinishedRun(db, s);
    if (own) return handleOwnRun(db, s, own, now, log);
  }
  const ev = await evaluate(db, s, mode);
  if (!ev.ok) {
    if (mode.interactive)
      return { scheduleId: s.id, outcome: "gate", code: ev.code, message: ev.message };
    return recordSkip(db, s, ev.code, now, { notifyUser: true, log });
  }
  const slot = mode.interactive ? now : due.slot;
  const missedRuns = mode.interactive ? 0 : due.missedRuns;
  try {
    const out = await db.transaction(async (tx) => {
      const cas = await tx
        .update(scanSchedules)
        .set({
          nextRunAt: nextRunAfter(now, s.intervalDays),
          lastRunAt: now,
          missedRuns,
          lastOutcome: "started" satisfies ScheduleOutcome,
          lastSkipCode: null,
          updatedAt: now,
        })
        .where(and(eq(scanSchedules.id, s.id), eq(scanSchedules.nextRunAt, s.nextRunAt)))
        .returning({ id: scanSchedules.id });
      if (cas.length === 0) return null;
      await bumpDemoEpoch(tx, s.id, now);
      const created = await insertPreparedScan(
        tx,
        ev.prepared,
        {
          origin: "schedule",
          scheduleId: s.id,
          scheduleSlot: slot,
          priority: 5,
          regionId: s.regionId,
        },
        now,
      );
      await tx
        .update(scanSchedules)
        .set({ lastScanId: created.scanId })
        .where(eq(scanSchedules.id, s.id));
      await audit(
        tx,
        "schedule.started",
        "schedule",
        s.id,
        { scanId: created.scanId, missedRuns, slot, interactive: mode.interactive },
        now,
      );
      return created.scanId;
    });
    if (out === null) return { scheduleId: s.id, outcome: "lost" };
    log?.(`zamanlama #${s.id}: tarama #${out} başlatıldı (kaçırılan ${missedRuns})`);
    return { scheduleId: s.id, outcome: "started", scanId: out, missedRuns };
  } catch (e) {
    if (e instanceof ScanGateError) {
      if (mode.interactive)
        return { scheduleId: s.id, outcome: "gate", code: e.code, message: e.message };
      return recordSkip(db, s, e.code, now, { notifyUser: true, regionName: ev.regionName, log });
    }
    // (schedule_id, schedule_slot) tekil indeksi: aynı an için tarama zaten var (başka tick kazandı).
    if (uniqueViolationOn(e, /scans\.schedule_id/i)) return { scheduleId: s.id, outcome: "lost" };
    throw e;
  }
}

/** Zamanı gelmiş etkin zamanlamalar (en eskisi önce). */
export async function dueSchedules(db: Db, now: number, limit: number): Promise<ScheduleRow[]> {
  return db
    .select()
    .from(scanSchedules)
    .where(and(eq(scanSchedules.enabled, true), lte(scanSchedules.nextRunAt, now)))
    .orderBy(asc(scanSchedules.nextRunAt), asc(scanSchedules.id))
    .limit(limit);
}

/**
 * Tick: zamanı gelmiş zamanlamaları (en çok `maxPerTick`) çalıştırır. Bir zamanlamanın hatası diğerlerini durdurmaz;
 * beklenmeyen hata günlüğe yazılır ve zamanlama bir saat sonra yeniden denenir (sonsuz hızlı döngü olmaz).
 */
export async function runDueSchedules(
  db: Db,
  opts: { now: number; maxPerTick?: number; log?: (m: string) => void },
): Promise<ScheduleRunResult[]> {
  const out: ScheduleRunResult[] = [];
  for (const s of await dueSchedules(db, opts.now, opts.maxPerTick ?? 3)) {
    try {
      const r = await runSchedule(db, s, opts.now, { interactive: false, log: opts.log });
      if (r.outcome !== "gate") out.push(r);
    } catch (e) {
      opts.log?.(`zamanlama #${s.id} çalıştırılamadı: ${errorMessage(e).slice(0, 160)}`);
      await db
        .update(scanSchedules)
        .set({ nextRunAt: opts.now + HOUR_MS, updatedAt: opts.now })
        .where(and(eq(scanSchedules.id, s.id), eq(scanSchedules.nextRunAt, s.nextRunAt)));
    }
  }
  return out;
}

/**
 * Tick işini tekil olarak planlar (mail.send `scheduleDispatch` deseni): kuyrukta/çalışan başka tick yoksa ekler.
 * Sabit `dedupeKey` KULLANILMAZ (biten işler anahtarı tutar; M3). `pullForward` ise kuyruktaki tick'in zamanı
 * `runAt`'e çekilir (Electron "uyan" dürtüsü).
 */
export async function scheduleTick(
  db: Db,
  opts: { runAt: number; now: number; exceptJobId?: number; pullForward?: boolean },
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id, status: jobs.status, runAt: jobs.runAt })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, SCHEDULE_TICK_JOB),
          inArray(jobs.status, ["queued", "running"]),
          opts.exceptJobId !== undefined ? ne(jobs.id, opts.exceptJobId) : undefined,
        ),
      )
      .limit(1);
    const cur = existing[0];
    if (cur) {
      if (opts.pullForward && cur.status === "queued" && cur.runAt > opts.runAt)
        await tx
          .update(jobs)
          .set({ runAt: opts.runAt, updatedAt: opts.now })
          .where(and(eq(jobs.id, cur.id), eq(jobs.status, "queued")));
      return null;
    }
    const [row] = await tx
      .insert(jobs)
      .values({
        type: SCHEDULE_TICK_JOB,
        payload: {},
        status: "queued",
        priority: 1,
        maxAttempts: 1,
        runAt: opts.runAt,
        createdAt: opts.now,
        updatedAt: opts.now,
      })
      .returning({ id: jobs.id });
    return row?.id ?? null;
  });
}

/** Durum özeti (GET /api/status): zamanı gelmiş etkin zamanlama sayısı ve en yakın çalışma. */
export async function scheduleSummary(
  db: Db,
  now: number,
): Promise<{ total: number; due: number; nextRunAt: number | null }> {
  const r = await db
    .select({
      total: sql<number>`count(*)`,
      due: sql<number>`coalesce(sum(case when ${scanSchedules.nextRunAt} <= ${now} then 1 else 0 end), 0)`,
      next: sql<number | null>`min(${scanSchedules.nextRunAt})`,
    })
    .from(scanSchedules)
    .where(eq(scanSchedules.enabled, true));
  return {
    total: Number(r[0]?.total ?? 0),
    due: Number(r[0]?.due ?? 0),
    nextRunAt: r[0]?.next === null || r[0]?.next === undefined ? null : Number(r[0].next),
  };
}
