import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import type { Db } from "@/lib/db/client";
import { parseEmail } from "@/lib/email/address";
import {
  forgetAccessToken,
  getAccessToken,
  getOAuthDeps,
  OAuthError,
  requireScope,
  type OAuthDeps,
} from "./oauth";
import {
  ProviderUnavailableError,
  type MailProvider,
  type ProviderResult,
  type ProviderSendInput,
} from "../provider/provider";

/**
 * Gmail API gönderim bağdaştırıcısı (Aşama 15.4): `users.messages.send` (RFC 5322 ham ileti, base64url).
 *
 * KAPILAR (hepsi ağ isteğinden ÖNCE; biri kapalıysa HİÇBİR istek atılmaz):
 *  1. `LIVE_SENDING_ENABLED` kapalıysa gönderim reddedilir; fabrika (`getLiveProvider`) bağdaştırıcıyı hiç kurmaz.
 *  2. `gmail.send` izni zorunludur (okuma izni gönderim için gerekmez ve burada kullanılmaz).
 *  3. Girdi doğrulaması: gönderen = kutunun adresi, tek alıcı (ve `To` başlığıyla aynı), `Bcc`/`Cc` yok, yalnızca
 *     ASCII, boyut sınırı, `Message-ID` başlığı beklenenle aynı.
 *
 * SONUÇ SINIFLANDIRMASI (tekrar gönderim güvenliği esastır):
 *  - `accepted`: yalnızca geçerli 200 yanıtı (`id`, `threadId` doğrulanır) ve ikisi de kaydedilir.
 *  - `rejected`: yalnızca İLETİNİN KESİNLİKLE gönderilmediği bilinen durumlar (400/404/413, 401 yenileme sonrası,
 *    403 izin/kota, 429, ağ isteği atılmadan önceki hatalar). `permanent`: yeniden denemenin anlamı yok.
 *  - `unknown`: çağrı atıldıktan sonra emin olunamayan HER durum (5xx, bağlantı kopması, zaman aşımı, iptal,
 *    bozuk/eksik 200 yanıtı, tanınmayan durum kodu). Bunlar OTOMATİK YENİDEN GÖNDERİLMEZ.
 *  - 401: kimlik doğrulama başarısız = istek işlenmedi. Erişim belirteci BİR kez zorla yenilenir ve istek BİR kez
 *    tekrarlanır; ikinci 401 `rejected` (döngü yok).
 *  - 429 / 403 kota: `Retry-After` (saniye veya HTTP tarihi) okunur, 1 sn–24 saat arasına sıkıştırılır.
 *
 * Belirteç, gövde, adres ve sunucu yanıt metni hiçbir sonuç koduna, iletiye veya günlüğe yazılmaz.
 * NOT: Gmail, `Message-ID` başlığını değiştirebilir; gerçek hesapla doğrulanana kadar eşleştirme `threadId` ile de
 * desteklenmelidir (bkz. docs/09 canlı doğrulama). Gerçek Google'a bu aşamada HİÇ bağlanılmaz.
 */

export const GMAIL_API_BASE = "https://gmail.googleapis.com";
const SEND_PATH = "/gmail/v1/users/me/messages/send";
export const GMAIL_MAX_RAW_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_BODY = 64 * 1024;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 24 * 3_600_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface GmailProviderOptions {
  db: Db;
  mailbox: { id: number; address: string | null };
  oauth?: OAuthDeps;
  /** YALNIZCA testlerde (`NODE_ENV=test`): API taban adresi. */
  apiBase?: string;
  /** YALNIZCA testlerde (`NODE_ENV=test`): canlı gönderim anahtarı. Varsayılan `LIVE_SENDING_ENABLED`. */
  liveEnabled?: () => boolean;
}

const rej = (code: string, permanent: boolean, retryAfterMs?: number): ProviderResult => ({
  status: "rejected",
  code,
  permanent,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});
const unk = (code: string): ProviderResult => ({ status: "unknown", code });

/** `Retry-After`: saniye veya HTTP tarihi; 1 sn–24 saate sıkıştırılır; geçersizse tanımsız. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let ms: number;
  if (/^\d{1,9}$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms));
}

/** Gönderimden önce ham iletiyi doğrular; sorun varsa kod, yoksa null. */
function validateRaw(input: ProviderSendInput, mailboxAddress: string | null): string | null {
  const from = parseEmail(input.from);
  const mb = mailboxAddress ? parseEmail(mailboxAddress) : null;
  if (!from || !mb || from.email !== mb.email) return "sender_mismatch";
  const to = parseEmail(input.to);
  if (!to || to.email !== input.to.toLowerCase()) return "invalid_recipient";
  const raw = input.raw;
  if (raw.length === 0 || raw.length > GMAIL_MAX_RAW_BYTES) return "invalid_message";
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 127) return "invalid_message";
  }
  const sep = raw.indexOf("\r\n\r\n");
  if (sep < 0) return "invalid_message";
  const head = raw.slice(0, sep).replace(/\r\n[ \t]+/g, " ");
  const headers = new Map<string, string[]>();
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i <= 0) return "invalid_message";
    const k = line.slice(0, i).toLowerCase();
    headers.set(k, [...(headers.get(k) ?? []), line.slice(i + 1).trim()]);
  }
  if (headers.has("bcc") || headers.has("cc")) return "invalid_message";
  const toHeader = headers.get("to") ?? [];
  const parsedTo =
    toHeader.length === 1 ? parseEmail(/<([^<>]+)>/.exec(toHeader[0]!)?.[1] ?? toHeader[0]!) : null;
  if (!parsedTo || parsedTo.email !== to.email) return "invalid_message";
  const mid = headers.get("message-id") ?? [];
  if (mid.length !== 1 || mid[0] !== input.messageId) return "invalid_message";
  return null;
}

/** Google API'nin standart kimlik doğrulama hatası: `{ error: { code: 401, status: "UNAUTHENTICATED" } }`. */
function isGoogleAuthError(json: unknown): boolean {
  const e = (json as { error?: { code?: unknown; status?: unknown } } | null)?.error;
  return !!e && typeof e === "object" && e.code === 401 && e.status === "UNAUTHENTICATED";
}

const ERROR_STATUSES: Record<number, readonly string[]> = {
  400: ["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE"],
  403: ["PERMISSION_DENIED", "RESOURCE_EXHAUSTED"],
  404: ["NOT_FOUND"],
  413: ["INVALID_ARGUMENT", "OUT_OF_RANGE", "FAILED_PRECONDITION", "RESOURCE_EXHAUSTED"],
};

/**
 * Google API hata zarfı: `{ error: { code: <HTTP durumu>, status: "<GRPC_DURUMU>", errors: [{ reason }] } }`.
 * Doğrulama: `error.code` HTTP durumuyla AYNI sayı olmalı; `status` varsa o durum için beklenen kümede olmalı;
 * yoksa en az bir dizge `errors[].reason` bulunmalı. Aksi halde null (doğrulanamadı).
 */
function googleError(json: unknown, http: number): { status: string; reason: string } | null {
  const e = (json as { error?: unknown } | null)?.error as
    { code?: unknown; status?: unknown; errors?: unknown } | null | undefined;
  if (!e || typeof e !== "object" || e.code !== http) return null;
  const reasons = Array.isArray(e.errors)
    ? e.errors
        .map((x) => (x as { reason?: unknown } | null)?.reason)
        .filter((r): r is string => typeof r === "string" && r !== "")
    : [];
  if (e.status !== undefined) {
    if (typeof e.status !== "string" || !ERROR_STATUSES[http]?.includes(e.status)) return null;
    return { status: e.status, reason: reasons[0] ?? "" };
  }
  return reasons.length > 0 ? { status: "", reason: reasons[0]! } : null;
}

export class GmailProvider implements MailProvider {
  readonly id = "gmail" as const;
  private readonly oauth: OAuthDeps;
  private readonly apiBase: string;
  private readonly liveEnabled: () => boolean;

  constructor(private readonly opts: GmailProviderOptions) {
    const testing = process.env.NODE_ENV === "test";
    if ((opts.apiBase !== undefined || opts.liveEnabled !== undefined) && !testing) {
      throw new Error("Gmail bağdaştırıcı ayarları yalnızca testte değiştirilebilir.");
    }
    this.apiBase = opts.apiBase ?? GMAIL_API_BASE;
    this.liveEnabled = opts.liveEnabled ?? isLiveSendingPermitted;
    this.oauth = opts.oauth ?? getOAuthDeps();
  }

  async send(input: ProviderSendInput): Promise<ProviderResult> {
    // 1. Canlı gönderim kilidi: kapalıysa HİÇBİR G/Ç yapılmaz.
    if (!this.liveEnabled()) return rej("live_sending_disabled", true);
    if (input.signal.aborted) return rej("aborted_before_send", false);

    // 2. Girdi doğrulaması (ağ yok).
    const problem = validateRaw(input, this.opts.mailbox.address);
    if (problem) return rej(problem, true);

    // 3. İzin: gmail.send zorunlu (ayarlardan okunur; ağ yok).
    try {
      await requireScope(this.opts.db, this.opts.mailbox.id, "send");
    } catch (e) {
      if (e instanceof OAuthError)
        return rej(e.kind === "scope_missing" ? "scope_missing" : "not_connected", true);
      throw e;
    }

    // 4. Erişim belirteci, sonra gönderim (401'de tek kontrollü yenileme).
    let token = await this.token();
    if (typeof token !== "string") return token;
    let res = await this.post(input, token);
    if (res === "unauthorized") {
      forgetAccessToken(this.opts.mailbox.id);
      token = await this.token();
      if (typeof token !== "string") return token;
      res = await this.post(input, token);
      if (res === "unauthorized") return rej("unauthorized", false);
    }
    return res;
  }

  /** Erişim belirteci; alınamazsa (istek atılmadan) uygun `rejected` sonucu. */
  private async token(): Promise<string | ProviderResult> {
    try {
      return await getAccessToken(this.opts.db, this.oauth, this.opts.mailbox.id);
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      if (e.kind === "reauthorization_required" || e.kind === "not_connected") {
        return rej("reauthorization_required", true);
      }
      return rej("auth_unavailable", false); // geçici; iletinin gönderilmediği kesin
    }
  }

  private async post(
    input: ProviderSendInput,
    token: string,
  ): Promise<ProviderResult | "unauthorized"> {
    const body = JSON.stringify({ raw: Buffer.from(input.raw, "latin1").toString("base64url") });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let res: Response;
    try {
      res = await this.oauth.fetch(`${this.apiBase}${SEND_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      // İstek atılmış olabilir (bağlantı kopması, zaman aşımı, iptal): SONUÇ BELİRSİZ.
      return unk("network_or_timeout");
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return unk("response_read_failed");
    }
    if (text.length > MAX_BODY) text = "";
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    const now = this.oauth.now();

    if (res.status === 200) {
      const o = json as { id?: unknown; threadId?: unknown } | null;
      if (
        o &&
        typeof o.id === "string" &&
        ID_RE.test(o.id) &&
        typeof o.threadId === "string" &&
        ID_RE.test(o.threadId)
      ) {
        return {
          status: "accepted",
          providerMessageId: o.id,
          threadId: o.threadId,
          acceptedAt: now,
        };
      }
      return unk("bad_success_body"); // gönderilmiş olabilir; kimlikler alınamadı
    }
    if (res.status === 401) {
      // Yalnızca Google'ın kimlik doğrulama hatası olarak TANINAN 401, iletinin işlenmediğinin kanıtıdır.
      // Başka bir 401 (ara sunucu, boş/bozuk gövde...) doğrulanamaz: yeniden gönderim YOK, sonuç belirsiz.
      return isGoogleAuthError(json) ? "unauthorized" : unk("unauthorized_unverified");
    }
    if (res.status === 429)
      return rej("rate_limited", false, parseRetryAfter(res.headers.get("retry-after"), now));
    if (res.status === 400 || res.status === 403 || res.status === 404 || res.status === 413) {
      // Kesin ret yalnızca Google'ın belgelenmiş hata zarfı DOĞRULANIRSA geçerlidir. Bozuk, eksik veya
      // beklenmeyen biçim (ara sunucu HTML'i, boş gövde...) iletinin işlenmediğini kanıtlamaz: BELİRSİZ.
      const err = googleError(json, res.status);
      if (!err) return unk(`error_unverified_${res.status}`);
      const retry = parseRetryAfter(res.headers.get("retry-after"), now);
      if (res.status === 400) return rej("invalid_request", true);
      if (res.status === 404) return rej("not_found", true);
      if (res.status === 413) return rej("message_too_large", true);
      if (err.reason === "dailyLimitExceeded" || err.reason === "quotaExceeded")
        return rej("rate_limited_daily", false, retry);
      if (
        /^(rateLimitExceeded|userRateLimitExceeded)$/.test(err.reason) ||
        err.status === "RESOURCE_EXHAUSTED"
      )
        return rej("rate_limited", false, retry);
      return rej("forbidden", true);
    }
    // 5xx ve tanınmayan her durum: işlenmiş olabilir → BELİRSİZ (otomatik tekrar yok).
    return unk(`http_${res.status >= 500 ? "5xx" : "other"}`);
  }
}

/** Fabrika kapısı: canlı gönderim kapalıyken bağdaştırıcı HİÇ kurulmaz. */
export function getLiveProvider(
  db: Db,
  mailbox: { id: number; provider: string; address: string | null },
): MailProvider {
  if (!isLiveSendingPermitted() || mailbox.provider !== "gmail") {
    throw new ProviderUnavailableError(mailbox.provider);
  }
  return new GmailProvider({ db, mailbox });
}
