import { database, json } from "@/lib/api/http";
import { dismissLifecycleResult } from "@/lib/lifecycle/service";
import { lifecycleRoute } from "../../backups/http";

export const dynamic = "force-dynamic";

/** Son geri yükleme/silme sonucunun bildirimini kapatır (idempotent). Denetim: `data.result.dismiss`. */
export const DELETE = lifecycleRoute(async () => {
  const db = await database();
  return json({ dismissed: await dismissLifecycleResult(db) });
});
