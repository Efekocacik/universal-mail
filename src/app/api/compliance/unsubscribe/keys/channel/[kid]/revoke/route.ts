import { body, database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { revokeChannelKey } from "@/lib/unsubscribe/channel";
import { requireConsent } from "../../../../../../campaigns/schema";
import { kidParam, revokeSchema, withUnsubscribeLock } from "../../../../shared";

export const dynamic = "force-dynamic";

/**
 * Kanal anahtarını İPTAL eder: özel anahtar silinir. GERİ ALINAMAZ; etkin anahtar iptal edilirse yeni bir kanal anahtarı
 * üretilip aktarıcıya yüklenene kadar çıkış olayları çekilemez. Açık onay (`confirm: true`) gerekir.
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ kid: string }> }) => {
  const db = await database();
  const kid = kidParam((await ctx.params).kid);
  await body(req, revokeSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    if (!(await revokeChannelKey(db, kid))) {
      throw new HttpError(404, "Anahtar bulunamadı veya zaten iptal edilmiş.", {
        code: "NOT_FOUND",
      });
    }
    return json({ revoked: true });
  });
});
