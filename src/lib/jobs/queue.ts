import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import type { JobStatus } from "@/lib/domain/types";

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  /** Aynı anahtarla ikinci bir iş eklenmez (tekrarlı tıklamalara karşı). */
  dedupeKey?: string;
  runAt?: number;
  priority?: number;
  maxAttempts?: number;
}

/** İş ekler. `dedupeKey` zaten varsa `null` döner. */
export async function enqueueJob(db: Db, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<number | null> {
  const now = Date.now();
  const rows = await db
    .insert(jobs)
    .values({
      type,
      payload,
      status: "queued",
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 3,
      runAt: opts.runAt ?? now,
      dedupeKey: opts.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

/**
 * Çalıştırılabilir en eski/en öncelikli işi kilitleyip döndürür. Kilitleme iyimserdir: aynı anda
 * iki işçi denerse yalnızca biri `status='queued'` koşulunu sağlayıp kazanır.
 */
export async function claimNextJob(db: Db, workerId: string, now: number = Date.now()): Promise<JobRow | null> {
  const candidates = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now)))
    .orderBy(desc(jobs.priority), asc(jobs.id))
    .limit(5);
  for (const c of candidates) {
    const res = await db
      .update(jobs)
      .set({ status: "running", lockedBy: workerId, lockedAt: now, attempts: sql`${jobs.attempts} + 1`, updatedAt: now })
      .where(and(eq(jobs.id, c.id), eq(jobs.status, "queued")))
      .returning();
    if (res[0]) return res[0];
  }
  return null;
}

export async function heartbeatJob(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await db.update(jobs).set({ lockedAt: now, updatedAt: now }).where(and(eq(jobs.id, id), eq(jobs.status, "running")));
}

export async function completeJob(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await db.update(jobs).set({ status: "done", finishedAt: now, updatedAt: now, lockedBy: null }).where(eq(jobs.id, id));
}

export async function cancelJob(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await db.update(jobs).set({ status: "cancelled", finishedAt: now, updatedAt: now, lockedBy: null }).where(eq(jobs.id, id));
}

/** İş hata verdi: deneme hakkı varsa gecikmeyle yeniden kuyruğa alınır, yoksa `failed` olur. */
export async function failJob(
  db: Db,
  job: Pick<JobRow, "id" | "attempts" | "maxAttempts">,
  error: string,
  retryDelayMs = 30_000,
  now: number = Date.now(),
): Promise<JobStatus> {
  const lastError = error.slice(0, 2000);
  if (job.attempts < job.maxAttempts) {
    await db
      .update(jobs)
      .set({ status: "queued", lastError, runAt: now + retryDelayMs * job.attempts, updatedAt: now, lockedBy: null, lockedAt: null })
      .where(eq(jobs.id, job.id));
    return "queued";
  }
  await db
    .update(jobs)
    .set({ status: "failed", lastError, finishedAt: now, updatedAt: now, lockedBy: null })
    .where(eq(jobs.id, job.id));
  return "failed";
}

export async function listRunningJobs(db: Db): Promise<JobRow[]> {
  return db.select().from(jobs).where(eq(jobs.status, "running"));
}

export async function requeueJob(db: Db, id: number, now: number = Date.now()): Promise<void> {
  await db.update(jobs).set({ status: "queued", lockedBy: null, lockedAt: null, runAt: now, updatedAt: now }).where(eq(jobs.id, id));
}

export async function countJobs(db: Db, status: JobStatus, type?: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .where(type ? and(eq(jobs.status, status), eq(jobs.type, type)) : eq(jobs.status, status));
  return Number(rows[0]?.n ?? 0);
}

/** Bitmiş eski iş kayıtlarını temizler (varsayılan 30 gün). */
export async function pruneFinishedJobs(db: Db, olderThanMs = 30 * 86_400_000, now: number = Date.now()): Promise<void> {
  await db.delete(jobs).where(and(sql`${jobs.status} in ('done','failed','cancelled')`, lte(jobs.finishedAt, now - olderThanMs)));
}
