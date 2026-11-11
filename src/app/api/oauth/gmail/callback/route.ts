import { database } from "@/lib/api/http";
import { t } from "@/lib/i18n";
import { completeAuthorization, getOAuthDeps, OAuthError } from "@/lib/mail/gmail/oauth";
import { oauthResultText, type OAuthResultLike } from "@/lib/mail/gmail/oauth-messages";
import { lookupOAuthResult, recordOAuthResult } from "@/lib/mail/gmail/oauth-result";

export const dynamic = "force-dynamic";

/** Sonuç sayfası hiçbir betik, dış kaynak, form veya çerçeve kullanmaz; yalnızca satır içi stil. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Sistem tarayıcısında gösterilen, uygulamanın geri kalanından bağımsız küçük Türkçe sonuç sayfası. */
function oauthResultPage(r: OAuthResultLike): string {
  const text = oauthResultText(r);
  const color = r.ok ? "#15803d" : "#b91c1c";
  const lines = [text.message, text.hint, r.ok ? null : t("mbx.oauth.page.retry")]
    .filter((x): x is string => !!x)
    .map((x) => `<p>${escapeHtml(x)}</p>`)
    .join("");
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(t("mbx.oauth.page.title"))}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#111827}
main{max-width:30rem;margin:12vh auto 0;padding:1.5rem;background:#fff;border:1px solid #e5e7eb;border-radius:12px}
h1{margin:0 0 .75rem;font-size:1.25rem;color:${color}}
p{margin:.5rem 0;line-height:1.5;font-size:.95rem}
.close{margin-top:1rem;padding-top:.75rem;border-top:1px solid #e5e7eb;color:#4b5563}
@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}main{background:#1f2937;border-color:#374151}.close{border-color:#374151;color:#d1d5db}}
</style>
</head>
<body>
<main role="main">
<h1>${escapeHtml(text.title)}</h1>
${lines}
<p class="close">${escapeHtml(t("mbx.oauth.page.close"))}</p>
</main>
</body>
</html>`;
}

function page(r: OAuthResultLike): Response {
  return new Response(oauthResultPage(r), {
    status: r.ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Google'ın yönlendirdiği yerel geri çağrı. Yetkilendirme kodu ve state yalnızca bu istekte işlenir; state tek
 * kullanımlıktır. Yanıt, kod/belirteç/state İÇERMEYEN bağımsız bir sonuç sayfasıdır (uygulamanın tamamı sistem
 * tarayıcısında açılmaz). Sonuç kodu, uygulama penceresinin sorgulayabilmesi için state özetiyle bellekte saklanır.
 */
export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const state = sp.get("state");
  let result: OAuthResultLike & { mailboxId: number | null };
  try {
    const db = await database();
    const r = await completeAuthorization(db, getOAuthDeps(), {
      state,
      code: sp.get("code"),
      error: sp.get("error"),
    });
    result = {
      ok: true,
      reason: null,
      readDenied: r.readRequestedButDenied,
      mailboxId: r.mailboxId,
    };
  } catch (e) {
    const kind = e instanceof OAuthError ? e.kind : "token_exchange_failed";
    if (kind === "invalid_state") {
      // Aynı geri çağrı sekmesi yenilendi/geri yüklendi: state zaten kullanıldı. İlk sonuç kayıtlıysa onu göster
      // (başarılı bir bağlantı "kurulamadı" diye gösterilmez); kayıt değiştirilmez.
      const prev = lookupOAuthResult(state);
      if (prev) return page({ ok: prev.ok, reason: prev.reason, readDenied: prev.readDenied });
    }
    result = { ok: false, reason: kind, readDenied: false, mailboxId: null };
  }
  recordOAuthResult(state, result);
  return page(result);
}
