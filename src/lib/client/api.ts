import { codeForStatus } from "@/lib/api/error-codes";
import { getLocale, t, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Tarayıcı tarafı API istemcisi.
 *
 * Hata dili (Faz 4, 10a-3): sunucu her hatada kararlı bir makine kodu (`code`, ör. `BUDGET_BLOCKED`) ve Türkçe bir
 * açıklama (`error`) gönderir. `ApiError.message` kullanıcıya gösterilecek metindir:
 *   - Türkçe arayüzde sunucunun açıklaması (en ayrıntılı metin), yoksa `apiError.<KOD>`;
 *   - İngilizce arayüzde `apiError.<KOD>` çevirisi, o kod için çeviri yoksa genel İngilizce metin (Türkçe sunucu metni
 *     İngilizce kullanıcıya gösterilmez). Sunucunun asıl metni `serverMessage`'da durur (tanılama için).
 * Böylece mevcut `toast.error(e.message)` çağrıları da kendiliğinden yerelleşir.
 */
export class ApiError extends Error {
  readonly serverMessage: string | undefined;
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.serverMessage = typeof body?.error === "string" ? body.error : undefined;
  }
}

const hasKey = (key: string): key is TrKey => Object.prototype.hasOwnProperty.call(tr, key);

/** Yanıt gövdesindeki sayı/metin alanları çeviri parametresi olarak kullanılır (ör. `{status}`). */
function paramsOf(body: Record<string, unknown>, status: number): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(body))
    if (k !== "error" && (typeof v === "number" || (typeof v === "string" && v.length <= 80)))
      out[k] = v;
  out.status = status;
  return out;
}

/** Hata kodu + gövde → etkin dilde kullanıcı metni (saf; test edilir). */
export function localizeApiError(
  status: number,
  body: Record<string, unknown>,
  locale = getLocale(),
): { message: string; code: string } {
  const code = typeof body.code === "string" && body.code ? body.code : codeForStatus(status);
  const server = typeof body.error === "string" && body.error.trim() ? body.error : undefined;
  const key = `apiError.${code}`;
  const params = paramsOf(body, status);
  if (locale === "tr") {
    if (server) return { message: server, code };
    return { message: hasKey(key) ? t(key, params, "tr") : t("apiError.HTTP", params, "tr"), code };
  }
  return {
    message: hasKey(key) ? t(key, params, locale) : t("apiError.generic", {}, locale),
    code,
  };
}

/**
 * Herhangi bir hatayı kullanıcıya gösterilecek metne çevirir: API hataları zaten yerelleşmiştir; ağ hatası (sunucuya
 * ulaşılamadı) için açık bir metin; diğer beklenmeyen hatalarda Türkçede kendi iletisi, İngilizcede genel metin.
 */
export function errorText(e: unknown, locale = getLocale()): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return t("apiError.NETWORK", {}, locale);
  if (locale === "tr" && e instanceof Error && e.message) return e.message;
  return t("apiError.generic", {}, locale);
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* gövde yok */
  }
  if (!res.ok) {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const { message } = localizeApiError(res.status, body);
    // `code` yalnızca sunucu gönderdiyse taşınır (mevcut dallanmalar `e.code === "..."` ile çalışır).
    throw new ApiError(
      message,
      res.status,
      typeof body.code === "string" ? body.code : undefined,
      body,
    );
  }
  return data as T;
}

/** Süzgeç nesnesini URL parametrelerine çevirir. */
export function toSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) sp.set(k, v.join(","));
    } else if (typeof v === "boolean") {
      sp.set(k, v ? "1" : "0");
    } else {
      sp.set(k, String(v));
    }
  }
  return sp;
}
