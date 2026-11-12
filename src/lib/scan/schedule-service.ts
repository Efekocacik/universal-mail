import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import {
  categorySets,
  regions,
  scanSchedules,
  scans,
  type ScheduleIntervalDays,
} from "@/lib/db/schema";
import { deleteNotificationsFor } from "@/lib/notifications";
import { uniqueViolationOn } from "./db-errors";
import { DAY_MS, DEFAULT_INTERVAL_DAYS, scheduleRequest, type ScheduleRow } from "./schedule";
import { estimateForRequest, prepareScan } from "./service";

/**
 * Zamanlama yönetimi (oluştur/düzenle/sil/listele). Yalnızca etkileşimli API çağırır; her değişiklik denetim kaydı
 * yazar. Hatalar tiplidir (`ScheduleError`); uç nokta bunları HttpError'a çevirir.
 */
export type ScheduleErrorCode =
  "SCHEDULE_NOT_FOUND" | "SCAN_NOT_FOUND" | "SCAN_NOT_STARTED" | "SCHEDULE_EXISTS";

export const SCHEDULE_ERROR_STATUS: Record<ScheduleErrorCode, number> = {
  SCHEDULE_NOT_FOUND: 404,
  SCAN_NOT_FOUND: 404,
  SCAN_NOT_STARTED: 409,
  SCHEDULE_EXISTS: 409,
};

const MESSAGES: Record<ScheduleErrorCode, string> = {
  SCHEDULE_NOT_FOUND: "Zamanlama bulunamadı.",
  SCAN_NOT_FOUND: "Tarama bulunamadı.",
  SCAN_NOT_STARTED: "Henüz başlatılmamış bir tarama düzenli tekrarlanamaz.",
  SCHEDULE_EXISTS: "Bu bölge ve kategoriler için zaten bir zamanlama var.",
};

export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(MESSAGES[code]);
    this.name = "ScheduleError";
  }
}

const interval = z.union([z.literal(7), z.literal(14), z.literal(30)]);
const cost = z.number().finite().min(0).max(10_000).nullable();

export const createScheduleSchema = z
  .object({
    fromScanId: z.number().int().positive(),
    intervalDays: interval.default(DEFAULT_INTERVAL_DAYS),
    maxCostUsd: cost.optional(),
  })
  .strict();
export const patchScheduleSchema = z
  .object({
    intervalDays: interval.optional(),
    enabled: z.boolean().optional(),
    maxCostUsd: cost.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "En az bir alan gerekli." });

/** İlk çalışma en erken bir dakika sonra (aynı anda başka işlerle yarışmasın). */
const MIN_LEAD_MS = 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ScheduleView {
  id: number;
  regionId: number;
  regionName: string;
  countryCode: string | null;
  categories: string[];
  customKeywords: string[];
  strategy: "text" | "nearby";
  fieldProfile: "discovery" | "enrich";
  intervalDays: ScheduleIntervalDays;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastScanId: number | null;
  lastOutcome: "started" | "skipped" | "completed" | "failed" | null;
  lastSkipCode: string | null;
  missedRuns: number;
  maxCostUsd: number | null;
  ackMaxUsd: number | null;
  createdAt: number;
}

export async function listSchedules(db: Db): Promise<ScheduleView[]> {
  const rows = await db
    .select({ s: scanSchedules, regionName: regions.name, countryCode: regions.countryCode })
    .from(scanSchedules)
    .innerJoin(regions, eq(regions.id, scanSchedules.regionId))
    .orderBy(desc(scanSchedules.id))
    .limit(200);
  const catIds = [...new Set(rows.flatMap((r) => r.s.categorySetIds))];
  const cats = catIds.length
    ? await db
        .select({ id: categorySets.id, name: categorySets.name })
        .from(categorySets)
        .where(inArray(categorySets.id, catIds))
    : [];
  const name = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map(({ s, regionName, countryCode }) => ({
    id: s.id,
    regionId: s.regionId,
    regionName,
    countryCode,
    categories: s.categorySetIds.map((id) => name.get(id)).filter((n): n is string => !!n),
    customKeywords: s.customKeywords,
    strategy: s.strategy,
    fieldProfile: s.fieldProfile,
    intervalDays: s.intervalDays,
    enabled: s.enabled,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastScanId: s.lastScanId,
    lastOutcome: s.lastOutcome,
    lastSkipCode: s.lastSkipCode,
    missedRuns: s.missedRuns,
    maxCostUsd: s.maxCostUsd,
    ackMaxUsd: s.ackMaxUsd,
    createdAt: s.createdAt,
  }));
}

export async function getSchedule(db: Db, id: number): Promise<ScheduleRow> {
  const row = (await db.select().from(scanSchedules).where(eq(scanSchedules.id, id)).limit(1))[0];
  if (!row) throw new ScheduleError("SCHEDULE_NOT_FOUND");
  return row;
}

/**
 * M5 ön onay: kullanıcının belirlediği tarama başına üst sınır; yoksa oluşturma anındaki LİSTE FİYATLI yüksek tahmin
 * (ücretsiz aylık kota hesaba katılmaz; böylece kota ay içinde bitince onaylı çalışmalar atlanmaz).
 * Arka plan çalışması bu tutarı aşan tahminde atlanır (NEEDS_ACK) ve kullanıcıya bildirilir.
 */
async function authorizedUsd(db: Db, s: ScheduleRow, maxCostUsd: number | null): Promise<number> {
  if (maxCostUsd !== null) return round2(maxCostUsd);
  const req = await scheduleRequest(db, s);
  if (!req) return 0;
  // Liste fiyatıyla (ücretsiz kota bitmiş varsayımı): ay içinde kota tükenince ön onay geçersiz kalmasın.
  const { estimate } = await estimateForRequest(db, req.request, { ignoreFreeTier: true });
  return round2(estimate.costUsd.high);
}

/**
 * Bir taramadan zamanlama oluşturur (bölge, kategoriler, strateji ve alan profili aynen). Tarama anahtarı başına tek
 * zamanlama (tekil indeks). Tarama sürüyor olabilir (yeni tarama oluşturucusundaki "Bu taramayı düzenli tekrarla"):
 * ilk zamanlanmış çalışma `tarama anı + aralık`tır; sürmekte olan tarama zamanlamanın ilk çalışması sayılır.
 */
export async function createScheduleFromScan(
  db: Db,
  input: z.infer<typeof createScheduleSchema>,
  now: number = Date.now(),
): Promise<{ id: number; nextRunAt: number; ackMaxUsd: number }> {
  const scan = (await db.select().from(scans).where(eq(scans.id, input.fromScanId)).limit(1))[0];
  if (!scan) throw new ScheduleError("SCAN_NOT_FOUND");
  if (scan.status === "draft") throw new ScheduleError("SCAN_NOT_STARTED");
  const existing = (
    await db
      .select({ id: scanSchedules.id })
      .from(scanSchedules)
      .where(eq(scanSchedules.scanKey, scan.scanKey))
      .limit(1)
  )[0];
  if (existing) throw new ScheduleError("SCHEDULE_EXISTS", { scheduleId: existing.id });

  const customKeywords = scan.queries
    .filter((q) => q.kind === "keyword" && !q.categoryKey)
    .map((q) => q.term);
  const ranAt = scan.finishedAt ?? scan.createdAt;
  const nextRunAt = Math.max(ranAt + input.intervalDays * DAY_MS, now + MIN_LEAD_MS);
  // Bitmiş taramanın sonucu zamanlamanın son sonucu olur; süren taramanınki bilinmiyor (null).
  const lastOutcome =
    scan.status === "completed" ? "completed" : scan.status === "failed" ? "failed" : null;
  const draft: ScheduleRow = {
    id: 0,
    regionId: scan.regionId,
    scanKey: scan.scanKey,
    categorySetIds: scan.categorySetIds,
    customKeywords,
    strategy: scan.strategy,
    fieldProfile: scan.fieldProfile,
    intervalDays: input.intervalDays,
    enabled: true,
    maxCostUsd: input.maxCostUsd ?? null,
    ackMaxUsd: null,
    ackAt: null,
    nextRunAt,
    lastRunAt: ranAt,
    lastScanId: scan.id,
    lastOutcome,
    lastSkipCode: null,
    missedRuns: 0,
    createdAt: now,
    updatedAt: now,
  };
  // Plan bugün de geçerli mi (ör. kategori kapatıldı)? PlanError burada 400'e dönüşür.
  const req = await scheduleRequest(db, draft);
  if (req) await prepareScan(db, req.request);
  const ackMaxUsd = await authorizedUsd(db, draft, draft.maxCostUsd);
  const { id: _omit, ...values } = draft;
  void _omit;
  try {
    // Kayıt ve iki denetim satırı birlikte yazılır ya da hiçbiri (denetimsiz zamanlama/ön onay kalmaz).
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(scanSchedules)
        .values({ ...values, ackMaxUsd, ackAt: now })
        .returning({ id: scanSchedules.id });
      await audit(
        tx,
        "schedule.created",
        "schedule",
        row!.id,
        { fromScanId: scan.id, intervalDays: input.intervalDays, nextRunAt },
        now,
      );
      await audit(
        tx,
        "schedule.authorized",
        "schedule",
        row!.id,
        { ackMaxUsd, maxCostUsd: draft.maxCostUsd },
        now,
      );
      return row!.id;
    });
    return { id, nextRunAt, ackMaxUsd };
  } catch (e) {
    if (uniqueViolationOn(e, /scan_schedules\.scan_key/i)) {
      const again = (
        await db
          .select({ id: scanSchedules.id })
          .from(scanSchedules)
          .where(eq(scanSchedules.scanKey, scan.scanKey))
          .limit(1)
      )[0];
      throw new ScheduleError("SCHEDULE_EXISTS", { scheduleId: again?.id ?? null });
    }
    throw e;
  }
}

/**
 * Düzenle. Aralık değişince sonraki çalışma `(son çalışma ?? oluşturma) + yeni aralık` olur (en erken bir dakika
 * sonra). Yeniden etkinleştirme geçmişi doldurmaz: gecikmişse tek çalışma bir dakika içinde yapılır.
 * Üst sınır değişince ön onay (`ack_max_usd`) yenilenir ve denetim kaydı yazılır.
 */
export async function updateSchedule(
  db: Db,
  id: number,
  patch: z.infer<typeof patchScheduleSchema>,
  now: number = Date.now(),
): Promise<ScheduleRow> {
  const s = await getSchedule(db, id);
  const set: Partial<typeof scanSchedules.$inferInsert> = { updatedAt: now };
  let nextRunAt = s.nextRunAt;
  if (patch.intervalDays !== undefined && patch.intervalDays !== s.intervalDays) {
    set.intervalDays = patch.intervalDays;
    nextRunAt = Math.max(
      (s.lastRunAt ?? s.createdAt) + patch.intervalDays * DAY_MS,
      now + MIN_LEAD_MS,
    );
  }
  if (patch.enabled !== undefined && patch.enabled !== s.enabled) {
    set.enabled = patch.enabled;
    if (patch.enabled) nextRunAt = Math.max(nextRunAt, now + MIN_LEAD_MS);
  }
  if (nextRunAt !== s.nextRunAt) set.nextRunAt = nextRunAt;
  let authorized: number | undefined;
  if (patch.maxCostUsd !== undefined) {
    set.maxCostUsd = patch.maxCostUsd;
    authorized = await authorizedUsd(db, s, patch.maxCostUsd);
    set.ackMaxUsd = authorized;
    set.ackAt = now;
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(scanSchedules)
      .set(set)
      .where(eq(scanSchedules.id, id))
      .returning();
    // Bu arada silindiyse denetim yazılmaz; 404 döner.
    if (!row) throw new ScheduleError("SCHEDULE_NOT_FOUND");
    await audit(tx, "schedule.updated", "schedule", id, { ...patch, nextRunAt }, now);
    if (authorized !== undefined)
      await audit(
        tx,
        "schedule.authorized",
        "schedule",
        id,
        { ackMaxUsd: authorized, maxCostUsd: patch.maxCostUsd },
        now,
      );
    return row;
  });
}

/** Siler; geçmiş taramalar kalır (schedule_id NULL olur). Zamanlamaya bağlı bildirimler de silinir. */
export async function deleteSchedule(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await getSchedule(db, id);
  await db.transaction(async (tx) => {
    await tx.delete(scanSchedules).where(eq(scanSchedules.id, id));
    await deleteNotificationsFor(tx, { scheduleIds: [id] });
    await audit(tx, "schedule.deleted", "schedule", id, undefined, now);
  });
}
