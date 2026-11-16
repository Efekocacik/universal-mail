import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { backupOverview, createBackup } from "@/lib/backup/service";
import { currentPending, lastLifecycleResult } from "@/lib/lifecycle/service";
import { lifecycleRoute } from "./http";

export const dynamic = "force-dynamic";

/**
 * Faz 6 (paket Y.7): yedek listesi ve ayarları. 200 `{backups, schedule, folder, folderIsDefault, defaultFolder,
 * passphraseSet, preMigrateCount, pending, lastResult}`. Parola değeri hiçbir zaman döndürülmez.
 */
export const GET = lifecycleRoute(async () => {
  const db = await database();
  return json({
    ...(await backupOverview(db)),
    pending: currentPending(),
    lastResult: lastLifecycleResult(),
  });
});

const createSchema = z.object({ includeSecrets: z.boolean().optional() }).strict();

/**
 * Şimdi yedekle (elle). 201 `{backup, secretsSkipped}`. Hatalar: 400 BACKUP_PASSPHRASE_REQUIRED /
 * BACKUP_FOLDER_UNWRITABLE, 409 BACKUP_IN_PROGRESS, 507 BACKUP_DISK_FULL, 500 BACKUP_FAILED. Denetim: `backup.create`.
 */
export const POST = lifecycleRoute(async (req: Request) => {
  const db = await database();
  const b = await body(req, createSchema);
  const r = await createBackup(db, { kind: "manual", includeSecrets: b.includeSecrets });
  return json({ backup: r.backup, secretsSkipped: r.secretsSkipped }, { status: 201 });
});
