import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs, mailboxes } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { getDemoInbox } from "../inbound/fake-inbox";
import { syncInbox, type InboxReader } from "../inbound/sync";

/**
 * `inbox.sync` iş türü: demo gelen kutusunu okuyup iletileri işler (Aşama 13).
 *
 * GÜVENLİK: Varsayılan KAPALI. Yalnızca `FAZ3_DEMO_INBOX_ENABLED=1` ile açılır (bu sürümde yalnızca testlerde/E2E).
 * `FAZ3_DEMO_SCHEDULER_ENABLED` bayrağından BAĞIMSIZDIR: o kapalıyken de bu açılabilir, tersi de geçerlidir.
 * Kapalıyken hiçbir ileti okunmaz, veritabanına hiçbir şey yazılmaz. Yalnızca demo posta kutuları okunur.
 */

export const INBOX_SYNC_JOB = "inbox.sync";
export const INBOX_FLAG = "FAZ3_DEMO_INBOX_ENABLED";
export const INBOX_SYNC_INTERVAL_MS = 60_000;
const STALE_INBOX_JOB_LOCK_MS = 60_000;

export function isDemoInboxEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const v = env[INBOX_FLAG];
  return v === "1" || v === "true";
}

/** Bekleyen veya çalışan başka bir `inbox.sync` işi yoksa yenisini ekler. */
export async function scheduleInboxSync(
  db: Db,
  opts: { runAt: number; now?: number; exceptJobId?: number },
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, INBOX_SYNC_JOB), inArray(jobs.status, ["queued", "running"])));
    if (existing.some((j) => j.id !== opts.exceptJobId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        type: INBOX_SYNC_JOB,
        payload: {},
        status: "queued",
        priority: 0,
        maxAttempts: 1,
        runAt: opts.runAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: jobs.id });
    return row?.id ?? null;
  });
}

export function createInboxSyncHandler(opts: {
  enabled: boolean;
  reader?: InboxReader;
  now?: () => number;
}): JobHandler {
  return async (ctx) => {
    if (!opts.enabled) {
      throw new NonRetryableJobError(
        `${INBOX_FLAG} kapalı: demo gelen kutusu okunmadı, hiçbir ileti işlenmedi.`,
      );
    }
    const clock = opts.now ?? Date.now;
    const reader = opts.reader ?? getDemoInbox();
    try {
      const boxes = await ctx.db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.provider, "demo"), eq(mailboxes.status, "connected")))
        .orderBy(asc(mailboxes.id));
      for (const b of boxes) {
        const r = await syncInbox(ctx.db, reader, b.id, { now: clock });
        if (r.fetched > 0) {
          ctx.log(
            `gelen kutusu: ${r.processed} işlendi, ${r.duplicates} yinelenen, ${r.needsReview} inceleme, ${r.effects} etki${r.floodGuard ? " (hacim sınırı aşıldı)" : ""}`,
          );
        }
      }
    } catch (e) {
      ctx.log(`gelen kutusu hatası: ${e instanceof Error ? e.name : "unknown"}`);
    }
    if (ctx.shouldStop()) return;
    try {
      await scheduleInboxSync(ctx.db, {
        runAt: clock() + INBOX_SYNC_INTERVAL_MS,
        now: clock(),
        exceptJobId: ctx.job.id,
      });
    } catch (e) {
      ctx.log(`sonraki gelen kutusu turu planlanamadı: ${e instanceof Error ? e.name : "unknown"}`);
    }
  };
}

/** Worker başlangıcı: bayrak açıksa turu planlar; kapalıysa veritabanına HİÇ yazmaz. */
export async function startInboxScheduler(
  db: Db,
  opts: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    now?: () => number;
  },
): Promise<{ enabled: boolean }> {
  if (!isDemoInboxEnabled(opts.env)) return { enabled: false };
  const clock = opts.now ?? Date.now;
  await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, runAt: clock(), updatedAt: clock() })
    .where(
      and(
        eq(jobs.type, INBOX_SYNC_JOB),
        eq(jobs.status, "running"),
        lt(jobs.lockedAt, clock() - STALE_INBOX_JOB_LOCK_MS),
      ),
    );
  await scheduleInboxSync(db, { runAt: clock(), now: clock() });
  return { enabled: true };
}
