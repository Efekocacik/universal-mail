import { database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { getOAuthStatus } from "@/lib/mail/gmail/oauth";

export const dynamic = "force-dynamic";

/** Kutunun bağlantı ve izin durumu (belirteç ASLA döndürülmez). Gönderim ve gelen kutusu okuma ayrı izinlerdir. */
export const GET = domainRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  return json(await getOAuthStatus(db, id));
});
