import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { resolveReview } from "@/lib/mail/inbound/process";
import { requireConsent } from "../../../campaigns/schema";
import { reviewDecisionSchema } from "../../../mail/schema";

export const dynamic = "force-dynamic";

/** İnceleme kararı: `apply` (türünün standart etkisi, kullanıcı kararıyla) veya `ignore`. */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { decision } = await body(req, reviewDecisionSchema);
  await requireConsent(db);
  return json(await resolveReview(db, id, decision));
});
