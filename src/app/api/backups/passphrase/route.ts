import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { setBackupPassphrase } from "@/lib/backup/service";
import { lifecycleRoute } from "../http";

export const dynamic = "force-dynamic";

const schema = z
  .object({ passphrase: z.string().max(1024), confirm: z.string().max(1024) })
  .strict();

/**
 * Yedek parolasını ayarlar/değiştirir (eski yedekler eski parolayla açılır). 200 `{passphraseSet:true}`;
 * 400 BACKUP_PASSPHRASE_WEAK / BACKUP_PASSPHRASE_MISMATCH. Değer asla döndürülmez ve günlüğe yazılmaz.
 */
export const PUT = lifecycleRoute(async (req: Request) => {
  const db = await database();
  await setBackupPassphrase(db, await body(req, schema));
  return json({ passphraseSet: true });
});
