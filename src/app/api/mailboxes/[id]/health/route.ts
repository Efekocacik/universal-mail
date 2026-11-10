import { eq } from "drizzle-orm";
import { database, HttpError, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { mailboxes } from "@/lib/db/schema";
import { getMailboxHealth } from "@/lib/mail/mailbox-health";

export const dynamic = "force-dynamic";

/** Posta kutusu düzeyi gönderim sağlığı (SRS 5.6.1). Şikâyet oranı bu sürümde ölçülemez ve öyle gösterilir. */
export const GET = domainRoute(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const [mb] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.id, id))
    .limit(1);
  if (!mb) throw new HttpError(404, "Posta kutusu bulunamadı.");
  return json(await getMailboxHealth(db, id));
});
