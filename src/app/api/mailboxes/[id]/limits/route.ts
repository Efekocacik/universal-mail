import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import {
  MAILBOX_LIMITS_STATUS,
  MailboxLimitsError,
  updateMailboxLimits,
} from "@/lib/mail/mailbox-limits";
import { requireConsent } from "../../../campaigns/schema";
import { mailboxDailyLimitsSchema } from "../../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Posta kutusunun günlük tavanı ve haftalık ısınma artışı. Gövde: `{dailyCap?, warmupStep?, expected: {dailyCap, warmupStep}}`.
 * Hatalar: 400 `CAP_ABOVE_PROVIDER_MAX` / `WARMUP_STEP_ABOVE_MAX` (`max` alanıyla), 404 `NOT_FOUND`, 409
 * `NOT_EDITABLE` (demo), 409 `CONFLICT` (`expected` artık güncel değil). Yanıt
 * `warmupRebased: true` ise ısınma rampası bugünkü tavandan devam edecek şekilde yeniden başlatılmıştır. Bu uç HİÇBİR ŞEY GÖNDERMEZ; tavan yükselirse
 * yalnızca dağıtıcıyı uyandırır, kurallar gönderim anında yeniden uygulanır.
 */
export const PATCH = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const input = await body(req, mailboxDailyLimitsSchema);
  await requireConsent(db);
  try {
    return json(await updateMailboxLimits(db, id, input));
  } catch (e) {
    if (e instanceof MailboxLimitsError) {
      return json(
        { error: e.message, code: e.kind.toUpperCase(), ...e.detail },
        { status: MAILBOX_LIMITS_STATUS[e.kind] },
      );
    }
    throw e;
  }
});
