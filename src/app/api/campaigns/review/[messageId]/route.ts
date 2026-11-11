import { z } from "zod";
import { domainRoute } from "@/lib/api/domain-route";
import { body, database, intParam, json } from "@/lib/api/http";
import {
  RESOLVE_REVIEW_STATUS,
  REVIEW_NOTE_MAX,
  ResolveReviewError,
  resolveUncertainSend,
  UNCERTAIN_SEND_DECISIONS,
} from "@/lib/mail/scheduler/resolve-review";
import { requireConsent } from "../../schema";

export const dynamic = "force-dynamic";

const resolveSchema = z
  .object({
    decision: z.enum(UNCERTAIN_SEND_DECISIONS),
    confirm: z.boolean().optional(),
    note: z.string().max(REVIEW_NOTE_MAX).optional(),
  })
  .strict();

/**
 * Sonucu belirsiz gönderim için kullanıcı kararı: `mark_sent`, `mark_not_sent` (açık onay ister) veya `stop_sequence`.
 * Bu uç HİÇBİR ŞEY GÖNDERMEZ; `mark_not_sent` adımı yalnızca yeniden uygun hâle getirir.
 */
export const POST = domainRoute(
  async (req: Request, ctx: { params: Promise<{ messageId: string }> }) => {
    const db = await database();
    const id = intParam((await ctx.params).messageId);
    const input = await body(req, resolveSchema);
    await requireConsent(db);
    try {
      return json(
        await resolveUncertainSend(db, id, input.decision, {
          confirm: input.confirm,
          note: input.note,
        }),
      );
    } catch (e) {
      if (e instanceof ResolveReviewError) {
        return json(
          { error: e.message, code: e.kind.toUpperCase() },
          { status: RESOLVE_REVIEW_STATUS[e.kind] },
        );
      }
      throw e;
    }
  },
);
