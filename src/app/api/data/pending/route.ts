import { database, json } from "@/lib/api/http";
import { cancelPending, currentPending } from "@/lib/lifecycle/service";
import { lifecycleRoute } from "../../backups/http";

export const dynamic = "force-dynamic";

/** Yeniden başlatmayı bekleyen işlem (geri yükleme veya verileri silme); yoksa `{pending:null}`. */
export const GET = lifecycleRoute(async () => json({ pending: currentPending() }));

/** Bekleyen işlemi iptal eder (idempotent; geri yüklemenin hazırlığı da silinir). Denetim: `data.pending.cancel`. */
export const DELETE = lifecycleRoute(async () => {
  const db = await database();
  return json({ cancelled: await cancelPending(db) });
});
