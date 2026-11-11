import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { importSuppressionsCsv } from "@/lib/compliance/suppression";
import { requireConsent } from "../../../campaigns/schema";
import { importSchema } from "../../schema";

export const dynamic = "force-dynamic";

/**
 * CSV içe aktarma (en fazla 2 MB / 20.000 satır). Geçerli satırlar tek işlemde eklenir; geçersiz satırlar yalnızca
 * satır numarası ve hata koduyla raporlanır (adres raporda TEKRARLANMAZ).
 */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const { csv } = await body(req, importSchema);
  await requireConsent(db);
  return json(await importSuppressionsCsv(db, csv));
});
