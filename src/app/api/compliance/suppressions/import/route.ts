import { z } from "zod";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  CsvConfirmationRequiredError,
  importSuppressionsCsvGuarded,
} from "@/lib/compliance/suppression";
import { requireConsent } from "../../../campaigns/schema";
import { importSchema } from "../../schema";

export const dynamic = "force-dynamic";

/**
 * İçe aktarma gövdesi: CSV metni (bkz. `importSchema`), isteğe bağlı önizleme ve geri alınamaz kayıtlar için açık onay.
 * Onay yalnızca `true` olabilir (yanlışlıkla `false`/metin gönderilemez).
 */
const guardedImportSchema = z
  .object({
    csv: importSchema.shape.csv,
    dryRun: z.boolean().optional(),
    confirmIrreversible: z.literal(true).optional(),
  })
  .strict();

/**
 * CSV içe aktarma (en fazla 2 MB / 20.000 satır). Geçerli satırlar tek işlemde eklenir; geçersiz satırlar yalnızca
 * satır numarası ve hata koduyla raporlanır (adres raporda TEKRARLANMAZ).
 *  - `dryRun: true`: hiçbir şey yazmadan önizleme döner (eklenecek/güçlendirilecek/kopya, nedene ve kapsama göre
 *    dağılım, geri alınamaz kayıt sayısı).
 *  - Dosyada çıkış/şikâyet gibi sonradan kaldırılamayacak kayıt varsa gerçek içe aktarma `confirmIrreversible: true`
 *    ister; yoksa 409 `CONFIRMATION_REQUIRED` ve güncel önizleme döner, hiçbir şey yazılmaz.
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { csv, dryRun, confirmIrreversible } = await body(req, guardedImportSchema);
  await requireConsent(db);
  try {
    return json(await importSuppressionsCsvGuarded(db, csv, { dryRun, confirmIrreversible }));
  } catch (e) {
    if (e instanceof CsvConfirmationRequiredError) {
      return json(
        { error: e.message, code: "CONFIRMATION_REQUIRED", preview: e.preview },
        { status: 409 },
      );
    }
    throw e;
  }
});
