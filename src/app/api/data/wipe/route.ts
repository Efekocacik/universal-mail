import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { scheduleWipe } from "@/lib/lifecycle/service";
import { lifecycleRoute } from "../../backups/http";

export const dynamic = "force-dynamic";

const schema = z.object({ confirm: z.string().max(100), deleteBackups: z.boolean() }).strict();

/**
 * "Tüm verilerimi sil"i yeniden başlatmaya planlar. Onay ifadesi "VERİLERİMİ SİL" veya "DELETE MY DATA" (büyük/küçük
 * harf ve I/İ farkı önemsiz). 202 `{restartRequired:true}`; 400 WIPE_CONFIRM_MISMATCH; 409 LIFECYCLE_PENDING.
 * Denetim: `data.wipe.schedule`.
 */
export const POST = lifecycleRoute(async (req: Request) => {
  const db = await database();
  await scheduleWipe(db, await body(req, schema));
  return json({ restartRequired: true }, { status: 202 });
});
