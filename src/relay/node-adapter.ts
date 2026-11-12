import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { Readable } from "node:stream";

/**
 * Node `http` ↔ web standardı `Request`/`Response` köprüsü (aktarıcı sunucusu).
 *
 * Güvenlik kuralları:
 *  - İstek URL'si ASLA `Host` başlığından kurulmaz: `new URL(req.url, RELAY_PUBLIC_ORIGIN)`. Mutlak biçimli istek
 *    hedefi (`GET http://başka/...`) veya `/` ile başlamayan hedef 400 alır.
 *  - Bağlantı (hop-by-hop) başlıkları atılır.
 *  - İstemci adresi `x-um-client` başlığıyla işleyiciye iletilir; gelen istekteki `x-um-client` kopyası HER ZAMAN
 *    silinir (sahte istemci anahtarıyla hız sınırı atlatılamaz, TB-5). Güvenilir vekil başlığı (ör. `x-real-ip`)
 *    YALNIZCA soket geri döngü (loopback) ya da `RELAY_TRUSTED_PROXIES` içindeyse dikkate alınır.
 *  - Günlüğe yol/belirteç YAZILMAZ; yalnızca yöntem, yol sınıfı ve durum (bkz. server.ts).
 */

export const CLIENT_HEADER = "x-um-client";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
]);

export interface ProxyTrust {
  /** Küçük harfli başlık adı (ör. `x-real-ip`); null/boş: vekil başlığı hiç kullanılmaz. */
  header: string | null;
  /** Ek güvenilir vekil ağları (geri döngü her zaman güvenilirdir). */
  trusted: net.BlockList;
}

/** `10.0.0.0/8, fd00::/8, 172.18.0.2` biçimli listeyi `BlockList`e çevirir; geçersiz girişte istisna. */
export function parseTrustedProxies(raw: string | undefined): net.BlockList {
  const list = new net.BlockList();
  for (const item of (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [addr, bitsRaw] = item.split("/");
    const type = net.isIP(addr ?? "");
    if (type === 0) throw new Error(`Geçersiz güvenilir vekil adresi: ${item}`);
    const family = type === 4 ? "ipv4" : "ipv6";
    if (bitsRaw === undefined) {
      list.addAddress(addr!, family);
      continue;
    }
    const bits = Number(bitsRaw);
    if (!/^\d{1,3}$/.test(bitsRaw) || bits > (type === 4 ? 32 : 128)) {
      throw new Error(`Geçersiz güvenilir vekil ağı: ${item}`);
    }
    list.addSubnet(addr!, bits, family);
  }
  return list;
}

/** IPv4 eşlemeli IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`; geçersizse null. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return net.isIP(ip) ? ip.toLowerCase() : null;
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
}

function isTrustedSocket(ip: string, trust: ProxyTrust): boolean {
  if (isLoopback(ip)) return true;
  return trust.trusted.check(ip, net.isIPv4(ip) ? "ipv4" : "ipv6");
}

/**
 * İstemcinin hız sınırı anahtarı olarak kullanılacak adresi. Soket güvenilir vekil değilse başlık YOK SAYILIR.
 * Başlıkta virgüllü liste varsa (X-Forwarded-For) EN SAĞDAKİ (vekile en yakın) geçerli adres alınır.
 */
export function clientAddress(
  req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } },
  trust: ProxyTrust,
): string {
  const sock = normalizeIp(req.socket.remoteAddress) ?? "unknown";
  if (!trust.header || sock === "unknown" || !isTrustedSocket(sock, trust)) return sock;
  const raw = req.headers[trust.header];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (!value) return sock;
  const parts = value.split(",");
  return normalizeIp(parts[parts.length - 1]) ?? sock;
}

export class BadRequestTarget extends Error {
  constructor() {
    super("bad_request_target");
    this.name = "BadRequestTarget";
  }
}

/** Node isteğini web `Request`ine çevirir. URL her zaman `origin` üzerinden kurulur. */
export function toWebRequest(req: IncomingMessage, origin: string, trust: ProxyTrust): Request {
  const target = req.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) throw new BadRequestTarget();
  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    throw new BadRequestTarget();
  }
  if (url.origin !== origin) throw new BadRequestTarget();

  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || name.startsWith("proxy-") || name === CLIENT_HEADER) continue;
    try {
      headers.append(name, raw[i + 1]!);
    } catch {
      /* geçersiz başlık değeri: atlanır */
    }
  }
  headers.set(CLIENT_HEADER, clientAddress(req, trust));

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

/** Web `Response`unu Node yanıtına yazar; HEAD için gövde gönderilmez. */
export async function writeWebResponse(
  res: ServerResponse,
  out: Response,
  method: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  out.headers.forEach((v, k) => {
    headers[k] = v;
  });
  if (method.toUpperCase() === "HEAD") {
    await out.body?.cancel().catch(() => undefined);
    res.writeHead(out.status, headers);
    res.end();
    return;
  }
  const body = Buffer.from(await out.arrayBuffer());
  headers["content-length"] = String(body.byteLength);
  res.writeHead(out.status, headers);
  res.end(body);
}

export interface NodeListenerOptions {
  origin: string;
  trust: ProxyTrust;
  /** Her yanıttan sonra çağrılır (günlük): yalnızca yöntem, yol, durum, süre — çağıran yolu SINIFLANDIRIR. */
  onResponse?: (info: { method: string; pathname: string; status: number; ms: number }) => void;
}

/** `http.createServer` dinleyicisi: web işleyicisini Node'a bağlar. Beklenmeyen hata → 500 (ayrıntı sızdırılmaz). */
export function createNodeListener(
  handler: (req: Request) => Promise<Response>,
  o: NodeListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    let pathname = "";
    const done = (status: number) =>
      o.onResponse?.({ method, pathname, status, ms: Date.now() - started });
    void (async () => {
      let out: Response;
      try {
        const request = toWebRequest(req, o.origin, o.trust);
        pathname = new URL(request.url).pathname;
        out = await handler(request);
      } catch (e) {
        const bad = e instanceof BadRequestTarget;
        out = new Response(bad ? "Bad request" : "Internal error", {
          status: bad ? 400 : 500,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      try {
        await writeWebResponse(res, out, method);
      } catch {
        res.destroy();
      }
      done(out.status);
    })();
  };
}
