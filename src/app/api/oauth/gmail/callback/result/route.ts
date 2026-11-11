import { z } from "zod";
import { body, json, route } from "@/lib/api/http";
import { lookupOAuthResult } from "@/lib/mail/gmail/oauth-result";

export const dynamic = "force-dynamic";

const schema = z.object({ state: z.string().min(1).max(128) }).strict();

/**
 * Uygulama penceresinin başlattığı Gmail yetkilendirmesinin sonucu (C12). Pencere, yetki adresindeki `state`
 * değerini gövdede gönderir (POST: yerel sunucunun kaynak denetiminden geçer; state adres çubuğuna/günlüğe düşmez).
 * Yanıt yalnızca sonuç kodudur: kod, belirteç veya adres içermez. Hiçbir dış istek atılmaz.
 */
export const POST = route(async (req: Request) => {
  const { state } = await body(req, schema);
  const r = lookupOAuthResult(state);
  if (!r) return json({ status: "pending" as const });
  return json({
    status: "done" as const,
    ok: r.ok,
    reason: r.reason,
    readDenied: r.readDenied,
    at: r.at,
  });
});
