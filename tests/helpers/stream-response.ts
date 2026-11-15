/**
 * Gövde sınırı testleri için akışlı `Response`. `new Response(string | Uint8Array)` undici'nin bayt akışını kullanır:
 * okuyucu sınırı aşıp akışı iptal edince undici'nin sıradaki `close()` çağrısı bazı Node 24 sürümlerinde
 * "ReadableStream is already closed" işlenmemiş hatası verir (yerelde sessiz, CI'da çalıştırmayı düşürür).
 * Burada akışı testin kendisi (bayt olmayan varsayılan denetleyiciyle) üretir; iptal hiçbir sürümde hata bırakmaz.
 */
export function streamedResponse(
  body: string | Uint8Array,
  init?: ResponseInit,
  chunkSize = 16 * 1024,
): Response {
  return new Response(byteStream(body, chunkSize), init);
}

/**
 * Aynı akış, istek gövdesi olarak. `FormData`/`Blob` gövdeli `Request` da undici'nin yineleyici akışını kullanır ve
 * okuyucu iptalinden sonra bekleyen `enqueue` aynı işlenmemiş hatayı bırakabilir.
 */
export function streamedRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string> },
  body: string | Uint8Array,
  chunkSize = 64 * 1024,
): Request {
  return new Request(url, {
    ...init,
    body: byteStream(body, chunkSize),
    duplex: "half",
  } as RequestInit);
}

function byteStream(body: string | Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
