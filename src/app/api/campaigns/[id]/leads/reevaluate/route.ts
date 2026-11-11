import { database, intParam, json, route } from "@/lib/api/http";
import { reevaluateExcluded } from "@/lib/campaigns/enrollment";
import { requireConsent } from "../../../schema";

export const dynamic = "force-dynamic";

/**
 * Hariç tutulan (`excluded`) dizileri yeniden değerlendirir (yalnızca taslak/hazır kampanya). Uygun çıkanlar `pending`
 * olur; diğerlerinin gerekçeleri yenilenir. Gövde beklenmez. Gerçek gönderim izni vermez: canlı kapılar kapalıyken
 * canlı kampanyadaki diziler hariç kalır.
 */
export const POST = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  await requireConsent(db);
  return json(await reevaluateExcluded(db, id));
});
