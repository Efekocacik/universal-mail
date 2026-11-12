import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  jobs,
  regions,
  scanSchedules,
  type ScheduleIntervalDays,
  type ScheduleOutcome,
} from "@/lib/db/schema";
import type { RegionInput } from "@/lib/domain/types";
import { getSetting, setSetting } from "@/lib/settings";
import { errorMessage } from "@/lib/util";
import { uniqueViolationOn } from "./db-errors";
import { ScanGateError, type GateCode } from "./gate-error";
import { checkCollectionReady, checkPaidScan, checkTargetCountry } from "./gates";
import { PlanError } from "./planner";
import { safeNotify } from "./scan-notifications";
import { checkScheduleCategorySets, CATEGORY_SET_MISSING } from "./schedule-categories";
import { insertPreparedScan, prepareScan, type PreparedScan, type ScanRequest } from "./service";

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

export type ScheduleSkipCode = GateCode | typeof CATEGORY_SET_MISSING | "PLAN_INVALID";

/** Atlama kodu → yeniden deneme gecikmesi. ACTIVE_SCAN kısa (aynı tarama bitince), diğerleri bir gün. */
export function retryDelayMs(code: ScheduleSkipCode): number {
  return code === "ACTIVE_SCAN" ? 3_600_000 : DAY_MS;
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
        .set({ nextRunAt: opts.now + 3_600_000, updatedAt: opts.now })
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
