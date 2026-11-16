import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { scheduleRestore } from "@/lib/backup/restore";
import { lifecycleRoute } from "../http";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    stageId: z.string().regex(/^[0-9a-f]{32}$/),
    confirm: z.boolean(),
    restoreSecrets: z.boolean(),
  })
  .strict();

/**
 * Hazırlanan yedeği yeniden başlatmada geri yüklemeye planlar (parola ayarlıysa önce şu anki verilerin şifreli
 * yedeği alınır). 202 `{restartRequired:true, safetyBackup}`. Hatalar: 400
 * RESTORE_CONFIRM_REQUIRED; 410 RESTORE_STAGE_NOT_FOUND (süresi doldu); 409 LIFECYCLE_PENDING.
 * Denetim: `backup.restore.schedule`.
 */
export const POST = lifecycleRoute(async (req: Request) => {
  const db = await database();
  const r = await scheduleRestore(db, await body(req, schema));
  return json({ restartRequired: true, safetyBackup: r.safetyBackup }, { status: 202 });
});
