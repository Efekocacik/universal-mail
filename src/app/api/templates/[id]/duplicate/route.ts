import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { duplicateTemplate } from "@/lib/mail/template-service";
import { requireConsent } from "../../../campaigns/schema";
import { emptyBodySchema } from "../../schema";

export const dynamic = "force-dynamic";

/** "Çoğalt ve düzenle": yerleşik veya kullanıcı şablonunun düzenlenebilir kopyasını oluşturur. */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  await body(req, emptyBodySchema);
  await requireConsent(db);
  return json(await duplicateTemplate(db, id), { status: 201 });
});
