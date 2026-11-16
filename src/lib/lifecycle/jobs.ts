import { BACKUP_AUTO_JOB, makeAutoBackupHandler, type AutoBackupPayload } from "@/lib/backup/auto";
import type { Db } from "@/lib/db/client";
import { enqueueJob } from "@/lib/jobs/queue";
import { registerJobHandler } from "@/lib/jobs/registry";
import { getSetting } from "@/lib/settings";
import { localDayKey } from "@/lib/backup/auto";
import { runRetention } from "./retention";

/**
 * Faz 6 (paket Y): yaşam döngüsü işleri. İşçi açılışta bir kez çağırır (`src/worker/index.ts`).
 *  - `backup.auto`: açılış/haftalık otomatik yedek (bkz. `src/lib/backup/auto.ts`).
 *  - `data.retention`: günlük saklama süresi uygulaması (bakım turu ekler; `data.retention:<gün>` tekil).
 */
export const RETENTION_JOB = "data.retention";

export function registerLifecycleJobs(): void {
  registerJobHandler<AutoBackupPayload>(BACKUP_AUTO_JOB, makeAutoBackupHandler());
  registerJobHandler(RETENTION_JOB, async (ctx) => {
    const s = await getSetting(ctx.db, "retention.leads");
    if (!s.enabled) return;
    const r = await runRetention(ctx.db);
    if (r.deleted > 0) ctx.log(`saklama süresi: ${r.deleted} eski kayıt silindi.`);
  });
}

/** Bakım turu adımı: saklama açıksa bugünün işini (tekil) ekler. */
export async function enqueueRetentionIfEnabled(
  db: Db,
  opts: { now: number },
): Promise<number | null> {
  const s = await getSetting(db, "retention.leads");
  if (!s.enabled) return null;
  return enqueueJob(
    db,
    RETENTION_JOB,
    {},
    { dedupeKey: `${RETENTION_JOB}:${localDayKey(opts.now)}`, runAt: opts.now, maxAttempts: 3 },
  );
}
