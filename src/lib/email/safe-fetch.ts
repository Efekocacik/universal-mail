import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

/**
 * Güvenli HTTP istemcisi. Taranan adresler (işletme web siteleri) güvenilmez girdidir; bu yüzden:
 *  - yalnızca http/https ve yaygın portlar,
 *  - iç ağ, geri döngü, bağlantı-yerel ve ayrılmış adreslere bağlanmayı BAĞLANTI ANINDA engeller (DNS yeniden bağlama saldırısına karşı),
 *  - sınırlı yönlendirme, zaman aşımı, yanıt boyutu ve açılmış (gzip/br) boyut sınırı.
 * `allowPrivate` yalnızca testler içindir; üretim kodu bunu asla açmaz.
 */
export type FetchErrorKind =
  | "bad_url"
  | "blocked_address"
  | "timeout"
  | "network"
  | "too_many_redirects"
  | "cross_site_redirect";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
  ) {
    super(message);
  }
  /** Geçici hata mı? (Yeniden denemeye değer.) */
  get retryable(): boolean {
    return this.kind === "timeout" || this.kind === "network";
  }
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Yönlendirme hedefi kabul edilir mi? Varsayılan: hepsi. Tarayıcı aynı site dışına çıkmayı reddeder. */
  allowRedirect?: (from: URL, to: URL) => boolean;
  /** Yalnızca testler: iç ağ adreslerine ve her porta izin ver. */
  allowPrivate?: boolean;
  accept?: string;
}

export interface FetchResult {
  /** Son (yönlendirmelerden sonraki) adres. */
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Bu istek için izlenen yönlendirme sayısı (her biri ayrı bir HTTP isteğidir). */
  hops?: number;
  /** İçerik türü HTML/metin değilse gövde indirilmez. */
  skippedBody: boolean;
  truncated: boolean;
}

export type FetchFn = (url: string, opts: FetchOptions) => Promise<FetchResult>;

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** İç ağ / ayrılmış adres mi? (IPv4, IPv6 ve IPv4-eşlemeli IPv6) */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1]!, 16);
      const lo = parseInt(hexMapped[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // fc00::/7
      /^fe[89ab]/.test(lower) || // fe80::/10
      lower.startsWith("ff") || // çok noktaya yayın
      lower.startsWith("2001:db8") ||
      lower.startsWith("64:ff9b:")
    );
  }
  return true; // bilinmeyen biçim: güvenli tarafta kal
}

function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error | null, a?: unknown) => void)(err);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return (callback as (e: Error | null) => void)(
          Object.assign(new Error(`Özel/iç ağ adresi engellendi: ${hostname}`), {
            code: "EBLOCKED",
          }),
        );
      }
      if ((options as { all?: boolean }).all)
        return (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      return (callback as (e: null, a: string, f: number) => void)(
        null,
        list[0]!.address,
        list[0]!.family,
      );
    });
  };
}

function textual(contentType: string): boolean {
  if (!contentType) return true;
  return /^(?:text\/|application\/(?:xhtml\+xml|xml)|application\/ld\+json)/i.test(contentType);
}

function decodeBody(buf: Buffer, contentType: string): string {
  let label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    const head = buf.subarray(0, 2048).toString("latin1");
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function once(
  url: URL,
  opts: Required<Pick<FetchOptions, "timeoutMs" | "maxBytes">> & FetchOptions,
  deadline: number,
): Promise<FetchResult & { location?: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError("timeout", "Zaman aşımı"));

    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(!!opts.allowPrivate),
        timeout: Math.min(remaining, opts.timeoutMs),
        headers: {
          "user-agent": opts.userAgent,
          accept: opts.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en,*;q=0.5",
          connection: "close",
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers))
          headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        const status = res.statusCode ?? 0;
        const contentType = headers["content-type"] ?? "";
        const finish = (body: string, skippedBody: boolean, truncated: boolean) =>
          resolve({
            url: url.toString(),
            status,
            headers,
            body,
            skippedBody,
            truncated,
            location: headers.location,
          });

        if ((status >= 300 && status < 400) || !textual(contentType)) {
          res.destroy();
          return finish("", !textual(contentType) && status < 300, false);
        }
        const enc = (headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const end = (truncated: boolean) => {
          if (done) return;
          done = true;
          res.destroy();
          finish(decodeBody(Buffer.concat(chunks), contentType), false, truncated);
        };
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - opts.maxBytes)));
            end(true);
          } else chunks.push(c);
        });
        stream.on("end", () => end(false));
        stream.on("error", (e) => {
          if (done) return;
          done = true;
          reject(new FetchError("network", `Yanıt okunamadı: ${(e as Error).message}`));
        });
        res.on("error", (e) => {
          if (done) return;
          done = true;
          reject(new FetchError("network", `Bağlantı koptu: ${e.message}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new FetchError("timeout", "Zaman aşımı")));
    req.on("error", (e) => {
      if (e instanceof FetchError) return reject(e);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBLOCKED") return reject(new FetchError("blocked_address", e.message));
      if (code === "ETIMEDOUT") return reject(new FetchError("timeout", "Zaman aşımı"));
      reject(new FetchError("network", `${code ?? "ağ hatası"}: ${e.message}`));
    });
    const killer = setTimeout(
      () => req.destroy(new FetchError("timeout", "Zaman aşımı")),
      remaining,
    );
    req.on("close", () => clearTimeout(killer));
    req.end();
  });
}

function checkUrl(url: URL, allowPrivate: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchError("bad_url", `Desteklenmeyen adres türü: ${url.protocol}`);
  if (url.username || url.password)
    throw new FetchError("bad_url", "Adreste kullanıcı bilgisi var.");
  if (!allowPrivate) {
    if (!ALLOWED_PORTS.has(url.port))
      throw new FetchError("blocked_address", `Port engellendi: ${url.port}`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateAddress(host))
      throw new FetchError("blocked_address", "İç ağ adresi engellendi.");
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    )
      throw new FetchError("blocked_address", "Yerel ad engellendi.");
  }
}

/** Yönlendirmeleri elle izleyen, sınırlı ve güvenli GET. HTTP durum kodları (404, 403...) hata fırlatmaz. */
export const safeFetch: FetchFn = async (rawUrl, options) => {
  const opts = { timeoutMs: 10_000, maxBytes: 1_000_000, maxRedirects: 3, ...options };
  const deadline = Date.now() + opts.timeoutMs;
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new FetchError("bad_url", `Geçersiz adres: ${rawUrl}`);
  }
  for (let hop = 0; ; hop++) {
    checkUrl(current, !!opts.allowPrivate);
    const res = await once(current, opts, deadline);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= opts.maxRedirects)
        throw new FetchError("too_many_redirects", "Çok fazla yönlendirme.");
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        throw new FetchError("bad_url", "Geçersiz yönlendirme adresi.");
      }
      if (opts.allowRedirect && !opts.allowRedirect(current, next))
        throw new FetchError("cross_site_redirect", `Başka siteye yönlendirme: ${next.hostname}`);
      next.hash = "";
      current = next;
      continue;
    }
    const { location: _location, ...rest } = res;
    void _location;
    return { ...rest, hops: hop };
  }
};
