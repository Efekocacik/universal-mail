import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { deleteMailbox, updateMailbox } from "@/lib/mail/mailbox-service";
import { requireConsent } from "../../campaigns/schema";
import { updateMailboxSchema } from "../../mail/schema";

export const dynamic = "force-dynamic";

/** Ad ve (`not_configured` ↔ `disabled`) durum. `connected` bu uçla verilemez; demo kutusu değiştirilemez. */
export const PATCH = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, updateMailboxSchema);
  await requireConsent(db);
  await updateMailbox(db, id, input);
  return json({ ok: true });
});

/** Siler: demo ve bağlı kutu ile kampanya/ileti geçmişi olan kutu silinemez. */
export const DELETE = domainRoute(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const db = await database();
    const id = intParam((await ctx.params).id);
    await requireConsent(db);
    await deleteMailbox(db, id);
    return json({ ok: true });
  },
);
