import { NextResponse } from "next/server";
import { database } from "@/lib/api/http";
import { completeAuthorization, getOAuthDeps, OAuthError } from "@/lib/mail/gmail/oauth";

export const dynamic = "force-dynamic";

/**
 * Google'ın yönlendirdiği yerel geri çağrı. Yetkilendirme kodu ve state yalnızca bu istekte işlenir; yanıt, kod veya
 * belirteç içermeyen bir yönlendirmedir (yalnızca sonuç kodu). State tek kullanımlıktır.
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const done = (qs: string) => {
    const res = NextResponse.redirect(new URL(`/settings?${qs}#mailbox`, req.url), 303);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };
  try {
    const db = await database();
    const r = await completeAuthorization(db, getOAuthDeps(), {
      state: sp.get("state"),
      code: sp.get("code"),
      error: sp.get("error"),
    });
    return done(`gmail=ok${r.readRequestedButDenied ? "&read=denied" : ""}`);
  } catch (e) {
    const kind = e instanceof OAuthError ? e.kind : "token_exchange_failed";
    return done(`gmail=error&reason=${encodeURIComponent(kind)}`);
  }
}
