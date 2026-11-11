import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { sendTestEmail } from "@/lib/mail/test-send";
import { requireConsent } from "../../../campaigns/schema";
import { testSendSchema } from "../../../mail/schema";

export const dynamic = "force-dynamic";

/** "Kendime test gönder": yalnızca demo posta kutusu; alıcı her zaman kutunun kendi adresi (FR-TPL-07). */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const mailboxId = intParam((await ctx.params).id);
  const input = await body(req, testSendSchema);
  await requireConsent(db);
  const r = await sendTestEmail(db, { mailboxId, ...input });
  if (r.outcome === "not_sendable")
    return json(
      {
        error: "Şablon gönderime hazır değil.",
        code: "NOT_SENDABLE",
        outcome: r.outcome,
        errors: r.errors,
      },
      { status: 422 },
    );
  return json(r);
});
