import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { getTemplateDetail, updateTemplate } from "@/lib/mail/template-service";
import { requireConsent } from "../../campaigns/schema";
import { updateTemplateSchema } from "../schema";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Şablon ayrıntısı (gövde dahil) ve onu kullanan kampanyalar. */
export const GET = domainRoute(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  return json(await getTemplateDetail(db, intParam((await ctx.params).id)));
});

/** Şablonu günceller. `expectedVersion` zorunludur; yerleşik veya kilitli şablon değiştirilemez (409). */
export const PATCH = domainRoute(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { expectedVersion, ...patch } = await body(req, updateTemplateSchema);
  await requireConsent(db);
  return json(await updateTemplate(db, id, patch, Date.now(), { expectedVersion }));
});
