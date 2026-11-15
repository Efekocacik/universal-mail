import { RegistryProviderError } from "./types";

/**
 * Sicil istemcilerinin ortak HTTP katmanı. Hedef ana makineler KODDA SABİTTİR (kullanıcı URL vermez → SSRF yüzeyi yok);
 * kullanıcı metni (yer adı, kodlar) yalnızca `URLSearchParams` ile kodlanmış sorgu değeridir. Yönlendirme izlenmez
 * (`redirect: "error"`): yetki başlığı başka bir ana makineye taşınamaz. Anahtar hiçbir hata metnine/günlüğe yazılmaz.
 */
export type FetchImpl = typeof fetch;

export interface HttpDeps {
  fetchImpl?: FetchImpl;
  /** Ardışık istekler arası en az bekleme (ms); sağlayıcı hız sınırına saygı. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** İstek başına zaman aşımı (ms). */
  timeoutMs?: number;
}

/** 429 `Retry-After` en çok bu kadar beklenir (sözleşme: 60 sn). */
export const RETRY_AFTER_CAP_MS = 60_000;
/** Yanıt gövdesi üst sınırı: 100 kayıtlık sayfa birkaç yüz KB'tır; bunun çok üstü bozuk/beklenmedik yanıttır. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `Retry-After` (saniye veya HTTP tarihi) → ms, `RETRY_AFTER_CAP_MS` ile sınırlı; çözülemezse null. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = Math.max(0, at - now);
  }
  return ms === null ? null : Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Aralık bekçisi: istemci örneği başına son istek zamanını tutar. */
export function createSpacer(deps: HttpDeps) {
  let last = -Infinity;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  return async () => {
    const wait = last + (deps.minIntervalMs ?? 0) - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };
}

/**
 * GET + JSON. Durum eşlemesi: 401/403 → AUTH, 429 → RATE (Retry-After), `emptyOn404` ise 404 → null (sicil API'leri
 * sonuç yokken 404 döner), diğer 4xx → BAD_RESPONSE, 5xx/ağ/zaman aşımı → UPSTREAM, JSON değil → BAD_RESPONSE.
 */
export async function getJson(
  url: URL,
  headers: Record<string, string>,
  deps: HttpDeps & { signal?: AbortSignal; emptyOn404?: boolean },
): Promise<unknown | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? 20_000);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal,
    });
  } catch (e) {
    if (deps.signal?.aborted) throw e;
    throw new RegistryProviderError(
      "REGISTRY_UPSTREAM",
      `Sicil hizmetine ulaşılamadı (${(e as Error)?.name ?? "hata"}).`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new RegistryProviderError(
      "REGISTRY_AUTH",
      `Sicil anahtarı reddedildi (HTTP ${res.status}).`,
    );
  if (res.status === 429)
    throw new RegistryProviderError(
      "REGISTRY_RATE",
      "Sicil hız sınırı aşıldı (HTTP 429).",
      parseRetryAfter(res.headers.get("retry-after"), (deps.now ?? Date.now)()),
    );
  if (res.status === 404 && deps.emptyOn404) return null;
  if (res.status >= 500)
    throw new RegistryProviderError(
      "REGISTRY_UPSTREAM",
      `Sicil hizmeti hata verdi (HTTP ${res.status}).`,
    );
  if (!res.ok)
    throw new RegistryProviderError(
      "REGISTRY_BAD_RESPONSE",
      `Sicil isteği reddedildi (HTTP ${res.status}).`,
    );
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES)
    throw new RegistryProviderError("REGISTRY_BAD_RESPONSE", "Sicil yanıtı beklenenden büyük.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RegistryProviderError("REGISTRY_BAD_RESPONSE", "Sicil yanıtı JSON değil.");
  }
}

/** 'YYYY-MM-DD' geçerli bir takvim günü mü? */
export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Boş/yalnız boşluk → null; uzunluk sınırı (veritabanı CHECK'leriyle aynı). */
export function clip(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const v = s.trim().replace(/\s+/g, " ");
  return v ? v.slice(0, max) : null;
}
