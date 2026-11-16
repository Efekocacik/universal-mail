import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { runRetention } from "@/lib/lifecycle/retention";
import { lifecycleRoute } from "../../../backups/http";

export const dynamic = "force-dynamic";

const schema = z.object({ expectedMax: z.number().int().min(0) }).strict();

/**
 * Saklama süresini şimdi uygular. Güncel aday sayısı kullanıcının gördüğü önizlemeyi (`expectedMax`) aşıyorsa hiçbir şey
 * silinmez: 409 RETENTION_PREVIEW_STALE. 200 `{deleted, cutoff}`. Denetim: `retention.run` (yalnızca sayılar).
 */
export const POST = lifecycleRoute(async (req: Request) => {
  const db = await database();
  const b = await body(req, schema);
  return json(await runRetention(db, { expectedMax: b.expectedMax, manual: true }));
});
