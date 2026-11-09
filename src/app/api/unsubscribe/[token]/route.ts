import { database, HttpError, json, route } from "@/lib/api/http";
import { processUnsubscribe, unsubscribeRateLimited } from "@/lib/mail/unsubscribe-service";

export const dynamic = "force-dynamic";

/**
 * DEMO iletişimden çıkma uç noktası. Yalnızca bu bilgisayardan (127.0.0.1, aynı kaynak) erişilir; alıcılar ve posta
 * sağlayıcıları ulaşamaz, bu yüzden gerçek tek tıklamalı çıkış (RFC 8058) DEĞİLDİR. İşlem yalnızca POST ile yapılır
 * (GET yalnızca onay sayfasını gösterir; önizleme/tarayıcı ön yüklemeleri çıkış üretmesin).
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  if (unsubscribeRateLimited()) {
    throw new HttpError(429, "Çok fazla deneme. Biraz bekleyip yeniden deneyin.", {
      code: "RATE_LIMITED",
    });
  }
  const { token } = await ctx.params;
  const type = req.headers.get("content-type") ?? "";
  let confirmed = false;
  if (type.includes("application/json")) {
    const b = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
    confirmed = b?.confirm === true;
  } else if (type.includes("application/x-www-form-urlencoded")) {
    confirmed = new URLSearchParams(await req.text()).get("List-Unsubscribe") === "One-Click";
  }
  if (!confirmed) throw new HttpError(400, "Onay gerekli.", { code: "UNCONFIRMED" });
  const outcome = await processUnsubscribe(await database(), token);
  if (outcome === "invalid")
    throw new HttpError(404, "Bağlantı geçersiz.", { code: "INVALID_TOKEN" });
  if (outcome === "unavailable")
    throw new HttpError(503, "Hizmet şu an kullanılamıyor.", { code: "UNAVAILABLE" });
  return json({ outcome });
});
