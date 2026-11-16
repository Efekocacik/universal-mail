import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { backups } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { NonRetryableJobError, type JobContext } from "@/lib/jobs/registry";
import { notify } from "@/lib/notifications";
import { getSetting } from "@/lib/settings";
import { LifecycleError } from "./errors";
import { createBackup, type BackupDeps } from "./service";
import { hasBackupPassphrase } from "./shared";

/**
 * Faz 6 (paket Y.4): otomatik yedekler. Açılış yedeği yerel günde en çok bir kez (`backup.auto:startup:<gün>`),
 * haftalık yedek son başarılı haftalıktan 7 gün sonra, ISO haftasında bir kez (`backup.auto:weekly:<yıl>-W<hafta>`).
 * Parola yoksa hiçbir otomatik yedek alınmaz (Ayarlar uyarı gösterir). Başarısızlıkta günde bir `backup.failed`
 * bildirimi; parola/klasör hataları yeniden denenmez.
 */

export const BACKUP_AUTO_JOB = "backup.auto";
const DAY = 86_400_000;
export const WEEKLY_INTERVAL_MS = 7 * DAY;

const pad = (n: number) => String(n).padStart(2, "0");

/** Yerel takvim günü "YYYY-MM-DD". */
export function localDayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Yerel günün başlangıcı (ms). */
export function localDayStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** ISO 8601 hafta anahtarı "YYYY-Www" (yerel takvim). */
export function isoWeekKey(now: number): string {
  const d = new Date(now);
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY + 1) / 7);
  return `${day.getUTCFullYear()}-W${pad(week)}`;
}

export interface AutoBackupPayload {
  reason: "startup" | "weekly";
}

async function hasOkStartupToday(db: Db, now: number): Promise<boolean> {
  const rows = await db
    .select({ id: backups.id })
    .from(backups)
    .where(
      and(
        eq(backups.kind, "startup"),
        eq(backups.status, "ok"),
        gte(backups.createdAt, localDayStart(now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function lastOkWeeklyAt(db: Db): Promise<number | null> {
  const r = await db
    .select({ at: backups.createdAt })
    .from(backups)
    .where(and(eq(backups.kind, "weekly"), eq(backups.status, "ok")))
    .orderBy(desc(backups.createdAt))
    .limit(1);
  return r[0]?.at ?? null;
}

/**
 * İşçi açılışı (P0 dikişi; imza değişmez): gerekiyorsa bugünün açılış yedeğini kuyruğa ekler. Hata işçiyi düşürmez;
 * çağıran yakalayıp günlüğe yazar.
 */
export async function onWorkerStarted(db: Db, opts: { now: number }): Promise<void> {
  await enqueueStartupIfDue(db, opts);
}

/** Açılış yedeği gerekiyorsa (otomatik + açılış açık, parola ayarlı, bugün başarılı açılış yedeği yok) kuyruğa ekler. */
export async function enqueueStartupIfDue(db: Db, opts: { now: number }): Promise<number | null> {
  const s = await getSetting(db, "backup.schedule");
  if (!s.auto || !s.onStartup) return null;
  if (!(await hasBackupPassphrase())) return null;
  if (await hasOkStartupToday(db, opts.now)) return null;
  return enqueueJob(db, BACKUP_AUTO_JOB, { reason: "startup" } satisfies AutoBackupPayload, {
    dedupeKey: `${BACKUP_AUTO_JOB}:startup:${localDayKey(opts.now)}`,
    runAt: opts.now,
    maxAttempts: 3,
  });
}

/** Bakım turu adımı: haftalık yedek zamanı geldiyse kuyruğa ekler. */
export async function enqueueWeeklyIfDue(db: Db, opts: { now: number }): Promise<number | null> {
  const s = await getSetting(db, "backup.schedule");
  if (!s.auto || !s.weekly) return null;
  if (!(await hasBackupPassphrase())) return null;
  const last = await lastOkWeeklyAt(db);
  if (last !== null && opts.now - last < WEEKLY_INTERVAL_MS) return null;
  return enqueueJob(db, BACKUP_AUTO_JOB, { reason: "weekly" } satisfies AutoBackupPayload, {
    dedupeKey: `${BACKUP_AUTO_JOB}:weekly:${isoWeekKey(opts.now)}`,
    runAt: opts.now,
    maxAttempts: 3,
  });
}

/** Yeniden denenmeyen hatalar: kullanıcı müdahalesi gerekir. */
const PERMANENT = new Set([
  "BACKUP_PASSPHRASE_REQUIRED",
  "BACKUP_FOLDER_UNWRITABLE",
  "BACKUP_FOLDER_INVALID",
]);

/** `backup.auto` işleyicisi. */
export function makeAutoBackupHandler(deps: BackupDeps = {}, clock: () => number = Date.now) {
  return async (ctx: JobContext<AutoBackupPayload>): Promise<void> => {
    const reason = ctx.payload?.reason;
    if (reason !== "startup" && reason !== "weekly")
      throw new NonRetryableJobError("Geçersiz otomatik yedek isteği.");
    const now = clock();
    const s = await getSetting(ctx.db, "backup.schedule");
    if (!s.auto || (reason === "startup" ? !s.onStartup : !s.weekly)) {
      ctx.log("otomatik yedek kapatıldı; atlandı.");
      return;
    }
    if (reason === "startup" && (await hasOkStartupToday(ctx.db, now))) return;
    try {
      const r = await createBackup(ctx.db, { kind: reason, now }, deps);
      ctx.log(`otomatik yedek alındı (${reason}, ${r.backup.sizeBytes ?? 0} bayt).`);
    } catch (e) {
      // Başka bir yedek sürüyor: bildirim yok, iş normal geri çekilmeyle yeniden denenir (başarı sayılırsa günün
      // tekilleştirme anahtarı harcanır ve o gün açılış yedeği alınmazdı).
      if (e instanceof LifecycleError && e.code === "BACKUP_IN_PROGRESS") {
        ctx.log("başka bir yedek sürüyor; otomatik yedek sonra yeniden denenecek.");
        throw new Error("Başka bir yedek sürüyor (BACKUP_IN_PROGRESS).");
      }
      const code = e instanceof LifecycleError ? e.code : "BACKUP_FAILED";
      await notify(
        ctx.db,
        {
          kind: "backup.failed",
          dedupeKey: `backup.failed:${localDayKey(now)}`,
          params: { code },
          url: "/settings",
        },
        { now },
      ).catch(() => undefined);
      if (PERMANENT.has(code))
        throw new NonRetryableJobError(`Otomatik yedek alınamadı (${code}).`);
      throw new Error(`Otomatik yedek alınamadı (${code}).`);
    }
  };
}
