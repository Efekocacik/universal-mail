import { body, database, HttpError, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { revokeSigningKey } from "@/lib/unsubscribe/keys";
import { requireConsent } from "../../../../../../campaigns/schema";
import { kidParam, revokeSchema, withUnsubscribeLock } from "../../../../shared";

export const dynamic = "force-dynamic";

/**
 * İmza anahtarını İPTAL eder (sızıntı durumu): genel anahtar doğrulama kümesinden çıkar, özel anahtar silinir.
 * GERİ ALINAMAZ: bu anahtarla imzalanmış, daha önce gönderilmiş iletilerdeki çıkış bağlantıları çalışmaz olur.
 * Açık onay (`confirm: true`) gerekir.
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ kid: string }> }) => {
  const db = await database();
  const kid = kidParam((await ctx.params).kid);
  await body(req, revokeSchema);
  await requireConsent(db);
  return withUnsubscribeLock(async () => {
    if (!(await revokeSigningKey(db, kid))) {
      throw new HttpError(404, "Anahtar bulunamadı veya zaten iptal edilmiş.", {
        code: "NOT_FOUND",
      });
    }
    return json({ revoked: true });
  });
});
