import { eq } from "drizzle-orm";
import { body, database, HttpError, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { mailboxes } from "@/lib/db/schema";
import { reenableMailbox } from "@/lib/mail/mailbox-health";
import { requireConsent } from "../../../../campaigns/schema";
import { reenableSchema } from "../../../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Durdurulmuş posta kutusunu yeniden etkinleştirir: açık onay + gerekçe ister ve bounce oranı hâlâ eşiğin üzerindeyse
 * REDDEDER. Duraklatılmış kampanyalar kendiliğinden devam etmez.
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, reenableSchema);
  await requireConsent(db);
  const [mb] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.id, id))
    .limit(1);
  if (!mb) throw new HttpError(404, "Posta kutusu bulunamadı.");
  await reenableMailbox(db, id, input);
  return json({ ok: true });
});
