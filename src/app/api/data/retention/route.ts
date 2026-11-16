import { body, database, json } from "@/lib/api/http";
import { previewRetention, updateRetentionSettings } from "@/lib/lifecycle/retention";
import { getSetting, retentionLeadsSchema } from "@/lib/settings";
import { lifecycleRoute } from "../../backups/http";

export const dynamic = "force-dynamic";

/** Saklama süresi ayarı, önizleme (şu an silinecek kayıt sayısı) ve son çalıştırma. */
export const GET = lifecycleRoute(async () => {
  const db = await database();
  return json({
    ...(await previewRetention(db)),
    lastRun: await getSetting(db, "retention.lastRun"),
  });
});

/** `{enabled, months 1..12}` (yalnızca kısaltılabilir: en çok 12 ay). 200 `{settings, preview}`; 400 VALIDATION. */
export const PUT = lifecycleRoute(async (req: Request) => {
  const db = await database();
  return json(await updateRetentionSettings(db, await body(req, retentionLeadsSchema.strict())));
});
