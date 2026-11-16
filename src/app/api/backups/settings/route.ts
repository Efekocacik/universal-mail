import { body, database, json } from "@/lib/api/http";
import { updateBackupSettings } from "@/lib/backup/service";
import { backupFolderSchema, backupScheduleSchema } from "@/lib/settings";
import { lifecycleRoute } from "../http";

export const dynamic = "force-dynamic";

const schema = backupScheduleSchema.extend({ folder: backupFolderSchema }).strict();

/**
 * Otomatik yedek ayarları + klasör (`null` = varsayılan). Klasör mutlak, var olan, yazılabilir ve uygulama paketi
 * dışında olmalıdır. 200 `{schedule, folder}`; 400 VALIDATION / BACKUP_FOLDER_INVALID / BACKUP_FOLDER_UNWRITABLE.
 */
export const PUT = lifecycleRoute(async (req: Request) => {
  const db = await database();
  return json(await updateBackupSettings(db, await body(req, schema)));
});
