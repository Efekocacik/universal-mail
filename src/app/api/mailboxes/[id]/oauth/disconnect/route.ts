import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { disconnectGmail, getOAuthDeps } from "@/lib/mail/gmail/oauth";
import { requireConsent } from "../../../../campaigns/schema";
import { oauthDisconnectSchema } from "../../../../mail/schema";

export const dynamic = "force-dynamic";

/** Bağlantıyı keser: yetkiyi Google'da iptal etmeyi dener (en iyi çaba), yerel belirteci siler. Açık onay ister. */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, oauthDisconnectSchema);
  await requireConsent(db);
  return json(await disconnectGmail(db, getOAuthDeps(), id, input));
});
