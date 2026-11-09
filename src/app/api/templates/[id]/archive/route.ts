import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { archiveTemplate } from "@/lib/mail/template-service";
import { requireConsent } from "../../../campaigns/schema";
import { archiveTemplateSchema } from "../../schema";

export const dynamic = "force-dynamic";

/** Şablonu arşivler (silinmez). Yerleşik veya kilitli şablon arşivlenemez (409). */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { expectedVersion } = await body(req, archiveTemplateSchema);
  await requireConsent(db);
  await archiveTemplate(db, id, Date.now(), { expectedVersion });
  return json({ ok: true });
});
