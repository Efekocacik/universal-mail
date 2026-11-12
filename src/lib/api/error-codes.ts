/**
 * API hata kodları (Faz 4, 10a-3). Sunucu her hata yanıtında kararlı, BÜYÜK_HARF bir `code` gönderir; arayüz metni
 * bu koddan yerelleştirir (`apiError.<KOD>` anahtarları, src/lib/i18n/{tr,en}/core.ts). Kodlar sürümler arasında
 * değişmez: istemciler bunlara göre dallanır. Bu dosya istemci paketine de girer (sunucu bağımlılığı yok).
 *
 * `API_ERROR_CODES`, arayüzün özel metin gösterdiği kodlardır; listede olmayan bir kod da gelebilir (alan hataları:
 * kampanya, posta kutusu…) ve İngilizce arayüzde genel metne düşer. Her listedeki kodun iki dilde de anahtarı olduğu
 * tests/error-codes.test.ts ile denetlenir.
 */
export const API_ERROR_CODES = [
  // HTTP durumundan türetilen genel kodlar
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM",
  "UNAVAILABLE",
  "INTERNAL",
  // route() / body() / intParam()
  "VALIDATION",
  "BAD_JSON",
  "INVALID_ID",
  "DB_BUSY",
  "DB_NOT_READY",
  "PLAN_INVALID",
  "PLACES_AUTH",
  "PLACES_BILLING",
  "PLACES_DISABLED",
  "PLACES_QUOTA",
  "PLACES_RATE",
  "PLACES_INVALID",
  "PLACES_NETWORK",
  "PLACES_SERVER",
  "PLACES_UNKNOWN",
  // Tarama kapıları ve ayarlar
  "SETUP_REQUIRED",
  "PLACES_KEY_MISSING",
  "BUDGET_BLOCKED",
  "NEEDS_ACK",
  "COUNTRY_NOT_TARGETED",
  "ACTIVE_SCAN",
  "MAP_ID_INVALID",
  // Sık görülen alan hataları (domain-route)
  "INVALID_INPUT",
  "INVALID_EMAIL",
  "DUPLICATE",
  "LIVE_LOCKED",
  "UNCONFIRMED",
  "CONFIRMATION_REQUIRED",
  "IN_USE",
  "BUILT_IN",
  "ARCHIVED",
  // Uç ve alan servisi kodları (domain-route.ts: tür adı büyük harfle)
  "NOT_CONFIGURED",
  "CHANNEL_KEY_UNREADABLE",
  "KEY_UNREADABLE",
  "NOT_SENDABLE",
  "INVALID_SELECTOR",
  "NO_DOMAIN",
  "NO_SENT_MESSAGE",
  "INVALID_TOKEN",
  "INVALID_PARAM",
  "INVALID_TEMPLATE",
  "UNKNOWN_CATEGORY",
  "UNKNOWN_COUNTRY",
  "INVALID_MODE",
  "NO_POLICY",
  "LOOSENING_FORBIDDEN",
  "BELOW_FLOOR",
  "INVALID_DOMAIN",
  "PUBLIC_SUFFIX",
  "INVALID_REASON",
  "ALREADY_LIFTED",
  "PROTECTED",
  "IN_FLIGHT",
  "NOT_APPROVED",
  "NOT_HALTED",
  "STILL_EXCEEDED",
  "RESERVED_DOMAIN",
  "INVALID_CLIENT",
  "LIMIT",
  "NOT_EDITABLE",
  "INVALID_STATUS",
  "MAILBOX_NOT_FOUND",
  "MAILBOX_NOT_READY",
  "SEND_SCOPE_MISSING",
  "PROFILE_INCOMPLETE",
  "IN_PROGRESS",
  "BUILD_FAILED",
  "LIVE_SCOPE",
  "CLIENT_NOT_CONFIGURED",
  "NOT_GMAIL",
  "INVALID_STATE",
  "EXPIRED",
  "ACCESS_DENIED",
  "SCOPE_MISSING",
  "SCOPE_EXCESS",
  "ACCOUNT_MISMATCH",
  "TOKEN_EXCHANGE_FAILED",
  "INVALID_RESPONSE",
  "NO_REFRESH_TOKEN",
  "NOT_CONNECTED",
  "REAUTHORIZATION_REQUIRED",
  "TRANSIENT",
  "NOT_REVIEWABLE",
  "CANNOT_APPLY",
  "NO_ENDPOINT",
  "NOT_VERIFIED",
  "NO_KEY",
  "LEAD_UNAVAILABLE",
  "INVALID_URL",
  "TOO_MANY",
  "CHANNEL_INSECURE_URL",
  "CHANNEL_HTTP_ERROR",
  "CHANNEL_BAD_RESPONSE",
  "CHANNEL_NETWORK",
  "CHANNEL_TIMEOUT",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "BAD_REQUEST",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  502: "UPSTREAM",
  503: "UNAVAILABLE",
  504: "UPSTREAM",
};

/** Kodsuz bir hata yanıtı için HTTP durumundan türetilen genel kod. */
export function codeForStatus(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "BAD_REQUEST");
}

/** Makine kodu biçimi: BÜYÜK_HARF, rakam ve alt çizgi (1–60). */
export const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,59}$/;

/** Serbest bir değeri (ör. `e.kind`) güvenli koda çevirir: büyük harf, izin verilmeyen karakter `_`. */
export function toErrorCode(raw: string, prefix = ""): string {
  const c = `${prefix}${raw}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 60);
  return ERROR_CODE_RE.test(c) ? c : "INTERNAL";
}
