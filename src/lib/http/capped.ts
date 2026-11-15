/**
 * Dış servis yanıt gövdesini BAYT sayarak okuma (sicil, Claude, Hunter, Snov istemcilerinin ortak katmanı). Bozuk veya
 * düşmanca bir uç (araya giren portal, hatalı kenar sunucusu) işçi belleğine sınırsız veri dolduramaz: `Content-Length`
 * sınırı aşıyorsa gövde hiç okunmaz, akış sınırı aşar aşmaz iptal edilir.
 *
 * Bu modülü kullanan istemciler `redirect: "error"` ile istek atar: yönlendirme izlenmez, böylece `x-api-key` /
 * `X-API-KEY` gibi özel anahtar başlıkları (fetch yalnızca Authorization ve Cookie'yi ayıklar) başka bir ana makineye
 * taşınamaz.
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Yanıt gövdesi ${maxBytes} baytı aşıyor.`);
    this.name = "BodyTooLargeError";
  }
}

/** Akış okunabilir gövdenin asgari biçimi (gerçek `Response` bunu karşılar). */
export interface StreamedBody {
  headers?: { get(name: string): string | null } | null;
  body?: ReadableStream<Uint8Array> | null;
}

/** Varsayılan JSON yanıt sınırı: bu istemcilerin yanıtları birkaç KB'tır; 1 MB çok geniş bir pay bırakır. */
export const DEFAULT_JSON_MAX_BYTES = 1024 * 1024;

export async function readCappedText(res: StreamedBody, maxBytes: number): Promise<string> {
  const declared = Number(res.headers?.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * JSON gövdeyi sınırlı okur. Gerçek `Response` (akış `body` alanı tanımlı; boş gövdede `null`) bayt sınırıyla okunur.
 * Akışı olmayan nesneler (birim testlerindeki `{ status, json }` sahteleri) yalnızca `json()` ile okunur; üretimde
 * `fetch` her zaman akışlı `Response` döndürür. Gövde boşsa veya JSON değilse `SyntaxError` fırlatır (çağıran eşler).
 */
export async function readJsonCapped(
  res: StreamedBody & { json(): Promise<unknown> },
  maxBytes: number = DEFAULT_JSON_MAX_BYTES,
): Promise<unknown> {
  if (res.body === undefined) return res.json();
  const text = await readCappedText(res, maxBytes);
  return JSON.parse(text) as unknown;
}
