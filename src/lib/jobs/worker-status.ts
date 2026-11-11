import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { WORKER_STATUS_FILENAME, dataDir } from "@/lib/config/paths";
import type { DbExecutor } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";

/**
 * Arka plan işçisi canlılığı (veritabanından türetilir; yeni tablo yok).
 *
 *  - "Gecikmiş iş": gönderim, gelen kutusu veya çıkış çekme işi `STALE_JOB_MS`'den uzun süredir zamanı gelmiş hâlde
 *    kuyrukta bekliyor VE son `RUNNING_FRESH_MS` içinde kalp atışı veren çalışan bir iş yok → işçi çalışmıyor.
 *    (İşçi uzun bir taramayla meşgulse çalışan işin kalp atışı tazedir; uyarı verilmez.)
 *  - "Çökme döngüsü": Electron ana süreci işçinin art arda çöktüğünü veri klasöründeki dosyaya yazar.
 */

export const STALE_JOB_MS = 10 * 60_000;
export const RUNNING_FRESH_MS = 60_000;
/** `MAIL_SEND_JOB`, `INBOX_SYNC_JOB`, `UNSUBSCRIBE_DRAIN_JOB` (ağır modülleri içe aktarmamak için sabit; testte eşlenir). */
export const WATCHED_JOB_TYPES = ["mail.send", "inbox.sync", "unsubscribe.drain"] as const;

export interface WorkerStatus {
  ok: boolean;
  reason: "crash_loop" | "overdue_jobs" | null;
  overdueJobs: number;
  oldestOverdueAt: number | null;
  crashLoop: { at: number; restarts: number } | null;
}

function readCrashLoop(): WorkerStatus["crashLoop"] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dataDir(), WORKER_STATUS_FILENAME), "utf8"),
    ) as Record<string, unknown>;
    if (raw?.v !== 1 || raw.state !== "crash_loop") return null;
    const at = Number(raw.at);
    const restarts = Number(raw.restarts);
    if (!Number.isFinite(at) || !Number.isFinite(restarts)) return null;
    return { at, restarts };
  } catch {
    return null;
  }
}

export async function getWorkerStatus(db: DbExecutor, now = Date.now()): Promise<WorkerStatus> {
  const [overdue] = await db
    .select({ n: sql<number>`count(*)`, oldest: sql<number | null>`min(${jobs.runAt})` })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        inArray(jobs.type, [...WATCHED_JOB_TYPES]),
        lt(jobs.runAt, now - STALE_JOB_MS),
      ),
    );
  const overdueJobs = Number(overdue?.n ?? 0);
  let stale = false;
  if (overdueJobs > 0) {
    const [fresh] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "running"), gt(jobs.lockedAt, now - RUNNING_FRESH_MS)))
      .orderBy(asc(jobs.id))
      .limit(1);
    stale = !fresh;
  }
  const crashLoop = readCrashLoop();
  const reason = crashLoop ? "crash_loop" : stale ? "overdue_jobs" : null;
  return {
    ok: reason === null,
    reason,
    overdueJobs: stale ? overdueJobs : 0,
    oldestOverdueAt: stale && overdue?.oldest != null ? Number(overdue.oldest) : null,
    crashLoop,
  };
}
