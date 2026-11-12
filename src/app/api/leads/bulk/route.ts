import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { selectionSchema } from "@/lib/api/filters";
import { BULK_ACTIONS, runBulk } from "@/lib/leads/bulk";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    action: z.enum(BULK_ACTIONS),
    selection: selectionSchema,
    /** Yalnızca sayıları döndür, hiçbir şey yazma (onay penceresi için). */
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * Seçili lead'ler üzerinde toplu işlem: arşivle, arşivden çıkar, "İletişime geçme" olarak işaretle (bkz.
 * src/lib/leads/bulk.ts). Yanıt: `{action, matched, changed, skipped:{unchanged, activeCampaign, notFound}, capped,
 * matchedTotal, dryRun, changedIds}`. Seçime/süzgece hiç lead uymuyorsa 409 `NOTHING_MATCHED` (hepsi zaten istenen durumdaysa
 * 200 ve `changed: 0`).
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  const input = await body(req, schema);
  const result = await runBulk(db, input);
  if (result.matchedTotal === 0)
    throw new HttpError(
      409,
      "Seçimde işlenecek işletme kalmadı. Liste değişmiş olabilir; sayfayı yenileyip yeniden seçin.",
      { code: "NOTHING_MATCHED" },
    );
  return json(result);
});
