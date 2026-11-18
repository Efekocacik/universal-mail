import { body, database, intParam, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { prepareTestSendConfirm } from "@/lib/mail/test-send";
import { requireConsent } from "../../../../campaigns/schema";
import { testSendChallengeSchema } from "../../../../mail/schema";

export const dynamic = "force-dynamic";

/**
 * "Kendime test gönder" onay hazırlığı (challenge). Gönderimle AYNI ön koşulları ve sınırları denetler; HİÇBİR ileti
 * göndermez ve HİÇBİR kayıt yazmaz. Gerçek (Gmail) kutuda, gerçek e-postanın gideceği adresi (her zaman kutunun kendi
 * adresi) ve imzalı, kısa ömürlü, tek kullanımlık, kutuya/şablona/işletmeye bağlı bir onay belirteci döner. Belirteç
 * olmadan gerçek test gönderimi yapılamaz; onayın kendisi gönderim işleminde denetim kaydına yazılır
 * (`mail.test_confirmed`). İnsan varlığının kesin kanıtı DEĞİLDİR (bkz. src/lib/mail/test-send-confirm.ts).
 */
export const POST = domainRoute(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const mailboxId = intParam((await ctx.params).id);
  const input = await body(req, testSendChallengeSchema);
  await requireConsent(db);
  return json(await prepareTestSendConfirm(db, { mailboxId, ...input }));
});
