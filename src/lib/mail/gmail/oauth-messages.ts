import { t, type Locale, type TrKey } from "@/lib/i18n";

/**
 * Gmail OAuth sonucunun Türkçe metni (C12). Hem sistem tarayıcısında açılan bağımsız sonuç sayfası hem de uygulama
 * penceresindeki posta kutusu bölümü bu saf işlevi kullanır; iki yerde aynı neden aynı sözlerle anlatılır.
 */

export interface OAuthResultLike {
  ok: boolean;
  /** `OAuthError.kind` (başarıda null). Bilinmeyen değerler genel metne düşer. */
  reason: string | null;
  /** İstenen okuma izni verilmedi; kutu yalnızca gönderim izniyle bağlandı. */
  readDenied: boolean;
}

/** Kullanıcıya ayrıca anlatılan nedenler; geri kalanı genel "tamamlanamadı" metnine düşer. */
export const KNOWN_OAUTH_REASONS = [
  "invalid_state",
  "expired",
  "access_denied",
  "account_mismatch",
  "scope_missing",
  "scope_excess",
  "no_refresh_token",
  "transient",
] as const;

/** Nedene özgü "ne yapmalı" ipucu olan nedenler. */
const HINTED: Readonly<Record<string, TrKey>> = {
  invalid_state: "mbx.oauth.hint.expired",
  expired: "mbx.oauth.hint.expired",
  access_denied: "mbx.oauth.hint.access_denied",
  account_mismatch: "mbx.oauth.hint.account_mismatch",
  scope_missing: "mbx.oauth.hint.scope",
  scope_excess: "mbx.oauth.hint.scope",
  no_refresh_token: "mbx.oauth.hint.no_refresh_token",
};

export function oauthReasonKey(reason: string | null): TrKey {
  const known = (KNOWN_OAUTH_REASONS as readonly string[]).includes(reason ?? "");
  return `mbx.oauth.reason.${known ? reason : "other"}` as TrKey;
}

/**
 * Sonuç metni. Sunucuda (geri çağrı sayfası) dil AÇIKÇA verilir: süreç içi etkin dil sunucuda istekler arasında
 * paylaşıldığından güvenilmez. Arayüzde verilmezse etkin dil kullanılır.
 */
export function oauthResultText(
  r: OAuthResultLike,
  locale?: Locale,
): {
  title: string;
  message: string;
  hint: string | null;
} {
  if (r.ok) {
    return {
      title: t("mbx.oauth.page.ok", {}, locale),
      message: r.readDenied
        ? t("mbx.oauth.result.readDenied", {}, locale)
        : t("mbx.oauth.result.ok", {}, locale),
      hint: null,
    };
  }
  const hintKey = r.reason ? HINTED[r.reason] : undefined;
  return {
    title: t("mbx.oauth.page.error", {}, locale),
    message: t(oauthReasonKey(r.reason), {}, locale),
    hint: hintKey ? t(hintKey, {}, locale) : null,
  };
}
