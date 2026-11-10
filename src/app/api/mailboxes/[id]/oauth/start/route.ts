import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { getOAuthDeps, loopbackRedirectUri, startAuthorization } from "@/lib/mail/gmail/oauth";
import { requireConsent } from "../../../../campaigns/schema";
import { oauthStartSchema } from "../../../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Yetkilendirmeyi başlatır: yalnızca bir yetki ADRESİ üretir; hiçbir dış istek atmaz. Kullanıcı bu adresi kendisi
 * açar. `send`: yalnızca gönderim izni. `send_read`: gelen kutusu okuma izni de istenir (ayrı, bilinçli adım).
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { level } = await body(req, oauthStartSchema);
  await requireConsent(db);
  const r = await startAuthorization(db, getOAuthDeps(), {
    mailboxId: id,
    level,
    redirectUri: loopbackRedirectUri(req.url),
  });
  return json(r);
});
