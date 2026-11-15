import type { UnsubscribeEventSource } from "./ingest";
import type { SpoolStats } from "./spool-core";
import { b64urlDecode, utf8Encode, type PublicKeyEntry } from "./token-core";
import { ed25519Verify, kidOfPublicKeyWeb, sha256Hex } from "./web-crypto";

/**
 * Aktarıcı ↔ uygulama KANALININ aktarıcı tarafı (Aşama 15.7; docs/09 K9): imzalı `/spool/events|ack|stats` uçları.
 *
 * Çalışma ortamından BAĞIMSIZDIR: yalnızca web standardı `Request`/`Response` ve WebCrypto (./web-crypto). Bu yüzden
 * hem VPS aktarıcısında (Node, src/relay/server.ts) hem Cloudflare Worker'da (src/relay/worker.ts) aynen çalışır.
 * Uygulama tarafı (imzalama, `HttpEventSource`) `./channel-protocol` içindedir ve buradakileri yeniden dışa aktarır.
 *
 * İmza girdisi (değişmez sözleşme): `um-chan-v1\n<YÖNTEM>\n<yol+sorgu>\n<ts>\n<sha256(gövde) hex>` (UTF-8).
 * Güvenlik modeli için bkz. ./channel-protocol (paylaşılan sır yok; aktarıcı yalnızca GENEL kanal anahtarını bilir).
 */

const SIGN_PREFIX = "um-chan-v1";
export const CHANNEL_SKEW_MS = 5 * 60_000;
export const MAX_ACK_BODY = 64 * 1024;
const ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;

/** İmzalanan metin (gövde özeti ayrıca hesaplanır). */
export function channelSigningText(
  method: string,
  pathWithQuery: string,
  ts: number,
  bodyHashHex: string,
): string {
  return `${SIGN_PREFIX}\n${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${bodyHashHex}`;
}

export interface ChannelRequestParts {
  method: string;
  pathWithQuery: string;
  headers: Headers;
  body: string;
}

/**
 * İmza başlıklarının biçim ve zaman denetimi (imzadan ÖNCE, kripto gerektirmez). Geçerliyse kid, ts ve ham imza
 * metni; değilse null. Node ve WebCrypto doğrulayıcıları bunu ORTAK kullanır.
 */
export function channelPrecheck(
  headers: Headers,
  now: number,
): { kid: string; ts: number; sigB64: string } | null {
  const kid = headers.get("x-um-kid") ?? "";
  const tsRaw = headers.get("x-um-ts") ?? "";
  const sigB64 = headers.get("x-um-sig") ?? "";
  if (!/^[0-9a-f]{16}$/.test(kid) || !/^[0-9]{10,16}$/.test(tsRaw)) return null;
  if (!/^[A-Za-z0-9_-]{86}$/.test(sigB64)) return null;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > CHANNEL_SKEW_MS) return null;
  return { kid, ts, sigB64 };
}

/** İmzalı kanal isteğini WebCrypto ile doğrular (./channel-protocol `verifyChannelRequest` ile aynı kurallar). */
export async function verifyChannelRequestWeb(
  req: ChannelRequestParts,
  keys: readonly PublicKeyEntry[],
  now: number,
): Promise<boolean> {
  const pre = channelPrecheck(req.headers, now);
  if (!pre) return false;
  const entry = keys.find((k) => k.kid === pre.kid);
  if (!entry) return false;
  try {
    if ((await kidOfPublicKeyWeb(entry.x)) !== entry.kid) return false;
    const sig = b64urlDecode(pre.sigB64);
    if (!sig || sig.length !== 64) return false;
    const bodyHash = await sha256Hex(utf8Encode(req.body));
    const message = utf8Encode(channelSigningText(req.method, req.pathWithQuery, pre.ts, bodyHash));
    return await ed25519Verify(entry.x, message, sig);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Aktarıcı tarafı: imzalı çekme/onay uçları                                                       */

/** Aktarıcı kuyruğu: dosya (`FileSpool`) ya da D1 (`D1Spool`); `stats` eşzamansız olabilir. */
export interface SpoolPort extends UnsubscribeEventSource {
  stats(): SpoolStats | Promise<SpoolStats>;
}

export type ChannelVerifier = (
  req: ChannelRequestParts,
  keys: readonly PublicKeyEntry[],
  now: number,
) => boolean | Promise<boolean>;

export interface PullHandlerOptions {
  spool: SpoolPort;
  /** Uygulamanın GENEL kanal anahtarları (aktarıcı yapılandırması). */
  keys: () => readonly PublicKeyEntry[] | Promise<readonly PublicKeyEntry[]>;
  now?: () => number;
  /** İmza doğrulayıcı; varsayılan WebCrypto (`verifyChannelRequestWeb`). */
  verify?: ChannelVerifier;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * Gövdeyi en çok `max` bayt okur (bayt sayısı OKURKEN denetlenir; büyük bir gövde belleğe alınmaz); aşılırsa null.
 * Metin `Request#text()` ile aynı biçimde (UTF-8, geçersiz bayt U+FFFD) çözülür.
 */
async function readCappedBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** `/spool/events`, `/spool/ack`, `/spool/stats`. Önce kimlik doğrulama; başarısızsa her durumda tek tip 401. */
export function createSpoolPullHandler(
  opts: PullHandlerOptions,
): (req: Request) => Promise<Response> {
  const clock = opts.now ?? Date.now;
  const verify = opts.verify ?? verifyChannelRequestWeb;
  return async (req) => {
    const url = new URL(req.url);
    const route = /^\/spool\/(events|ack|stats)$/.exec(url.pathname)?.[1];
    if (!route) return reply(404, { error: "not_found" });
    const method = req.method.toUpperCase();
    const expected = route === "ack" ? "POST" : "GET";
    if (method !== expected) return reply(405, { error: "method_not_allowed" });

    let body = "";
    if (method === "POST") {
      const len = req.headers.get("content-length");
      if (len !== null && (!/^\d{1,9}$/.test(len) || Number(len) > MAX_ACK_BODY)) {
        return reply(413, { error: "too_large" });
      }
      const text = await readCappedBody(req, MAX_ACK_BODY);
      if (text === null) return reply(413, { error: "too_large" });
      body = text;
    }
    let keys: readonly PublicKeyEntry[];
    try {
      keys = await opts.keys();
    } catch {
      return reply(503, { error: "unavailable" });
    }
    let ok = false;
    try {
      ok = await verify(
        { method, pathWithQuery: `${url.pathname}${url.search}`, headers: req.headers, body },
        keys,
        clock(),
      );
    } catch {
      ok = false;
    }
    if (!ok) return reply(401, { error: "unauthorized" });

    try {
      if (route === "stats") return reply(200, await opts.spool.stats());
      if (route === "events") {
        const raw = url.searchParams.get("limit") ?? "100";
        const limit = /^\d{1,3}$/.test(raw) ? Math.min(Math.max(Number(raw), 1), 500) : 100;
        return reply(200, { events: await opts.spool.pull(limit) });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return reply(400, { error: "bad_request" });
      }
      const ids = (parsed as { ids?: unknown } | null)?.ids;
      if (
        !Array.isArray(ids) ||
        ids.length > 500 ||
        !ids.every((i) => typeof i === "string" && ID_RE.test(i))
      ) {
        return reply(400, { error: "bad_request" });
      }
      await opts.spool.ack(ids as string[]);
      return reply(200, { acked: ids.length });
    } catch {
      return reply(503, { error: "unavailable" });
    }
  };
}
