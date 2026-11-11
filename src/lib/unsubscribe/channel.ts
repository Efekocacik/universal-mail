import crypto from "node:crypto";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { channelKeySecretName, deleteSecret, getSecret, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import type { UnsubscribeEventSource } from "./ingest";
import type { SpoolStats } from "./spool";
import { kidOfPublicKey, publicKeyObject, type PublicKeyEntry } from "./token";

/**
 * Aktarıcı ↔ uygulama KANALI (Aşama 15.7; docs/09 K9). Uygulama, aktarıcıdaki kuyruktan olayları ÇEKER ve onaylar.
 *
 * Güvenlik modeli:
 *  - Her istek uygulamanın Ed25519 kanal anahtarıyla İMZALANIR (yöntem, yol+sorgu, zaman, gövde özeti). Aktarıcı yalnızca
 *    GENEL anahtarı bilir: ele geçirilse bile uygulama adına olay çekemez/onaylayamaz. Paylaşılan sır YOKTUR.
 *  - Zaman damgası ±5 dk içinde olmalı; imza geçersiz/eksikse tek tip 401 (neden sızdırılmaz).
 *  - Onay (`ack`) idempotenttir; tekrar oynatılan imzalı istek yeni bir zarar doğurmaz (aynı kimlikleri siler).
 *  - Aktarıcı olayları geciktirebilir/atlayabilir (erişilebilirlik); bu katman bunu çözmez, kuyruk derinliği/yaş izlemesi
 *    (`getStats`) bunu görünür kılar (K11). Olay içeriği uygulamada ayrıca imzayla yeniden doğrulanır.
 *  - Aktarıcı yanıtları sıkı doğrulanır (boyut, şekil, kimlik biçimi); bozuk yanıt hata sayılır, olay işlenmez.
 */

const SIGN_PREFIX = "um-chan-v1";
export const CHANNEL_SKEW_MS = 5 * 60_000;
const MAX_ACK_BODY = 64 * 1024;
const MAX_RESPONSE = 1_500_000;
const ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;

/* ---------------------------------------------------------------------------------------------- */
/* İmza                                                                                            */

export function channelSigningInput(
  method: string,
  pathWithQuery: string,
  ts: number,
  body: string,
): Buffer {
  const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return Buffer.from(
    `${SIGN_PREFIX}\n${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${bodyHash}`,
    "utf8",
  );
}

export function signChannelRequest(
  kid: string,
  privateKey: crypto.KeyObject,
  method: string,
  pathWithQuery: string,
  body: string,
  now: number,
): Record<string, string> {
  const sig = crypto.sign(null, channelSigningInput(method, pathWithQuery, now, body), privateKey);
  return { "X-UM-Kid": kid, "X-UM-Ts": String(now), "X-UM-Sig": sig.toString("base64url") };
}

export function verifyChannelRequest(
  req: { method: string; pathWithQuery: string; headers: Headers; body: string },
  keys: readonly PublicKeyEntry[],
  now: number,
): boolean {
  const kid = req.headers.get("x-um-kid") ?? "";
  const tsRaw = req.headers.get("x-um-ts") ?? "";
  const sigB64 = req.headers.get("x-um-sig") ?? "";
  if (!/^[0-9a-f]{16}$/.test(kid) || !/^[0-9]{10,16}$/.test(tsRaw)) return false;
  if (!/^[A-Za-z0-9_-]{86}$/.test(sigB64)) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > CHANNEL_SKEW_MS) return false;
  const entry = keys.find((k) => k.kid === kid);
  if (!entry) return false;
  try {
    if (kidOfPublicKey(entry.x) !== entry.kid) return false;
    return crypto.verify(
      null,
      channelSigningInput(req.method, req.pathWithQuery, ts, req.body),
      publicKeyObject(entry.x),
      Buffer.from(sigB64, "base64url"),
    );
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Aktarıcı tarafı: imzalı çekme/onay uçları                                                       */

export interface SpoolPort extends UnsubscribeEventSource {
  stats(): SpoolStats;
}

export interface PullHandlerOptions {
  spool: SpoolPort;
  /** Uygulamanın GENEL kanal anahtarları (aktarıcı yapılandırması). */
  keys: () => readonly PublicKeyEntry[] | Promise<readonly PublicKeyEntry[]>;
  now?: () => number;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** `/spool/events`, `/spool/ack`, `/spool/stats`. Önce kimlik doğrulama; başarısızsa her durumda tek tip 401. */
export function createSpoolPullHandler(
  opts: PullHandlerOptions,
): (req: Request) => Promise<Response> {
  const clock = opts.now ?? Date.now;
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
      body = await req.text();
      if (body.length > MAX_ACK_BODY) return reply(413, { error: "too_large" });
    }
    let keys: readonly PublicKeyEntry[];
    try {
      keys = await opts.keys();
    } catch {
      return reply(503, { error: "unavailable" });
    }
    const ok = verifyChannelRequest(
      { method, pathWithQuery: `${url.pathname}${url.search}`, headers: req.headers, body },
      keys,
      clock(),
    );
    if (!ok) return reply(401, { error: "unauthorized" });

    try {
      if (route === "stats") return reply(200, opts.spool.stats());
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

/* ---------------------------------------------------------------------------------------------- */
/* Uygulama tarafı: HTTP olay kaynağı                                                              */

export class ChannelError extends Error {
  constructor(
    readonly code: "insecure_url" | "http_error" | "bad_response" | "network" | "timeout",
    readonly status?: number,
  ) {
    super(code);
    this.name = "ChannelError";
  }
}

export interface HttpEventSourceOptions {
  /** Aktarıcı kökü (ör. `https://cikis.firma.example`); `/spool/*` altına istek atılır. */
  baseUrl: string;
  kid: string;
  privateKey: crypto.KeyObject;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Yalnızca testte: 127.0.0.1 üzerindeki http kabul edilir. */
  allowLoopbackHttp?: boolean;
}

export class HttpEventSource implements UnsubscribeEventSource {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly o: HttpEventSourceOptions) {
    const u = new URL(o.baseUrl);
    const loopbackOk =
      o.allowLoopbackHttp === true &&
      process.env.NODE_ENV === "test" &&
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1";
    if (!loopbackOk && (u.protocol !== "https:" || u.username || u.password)) {
      throw new ChannelError("insecure_url");
    }
    this.base = `${u.origin}`;
    this.doFetch = o.fetch ?? fetch;
    this.clock = o.now ?? Date.now;
  }

  private async call(method: "GET" | "POST", pathWithQuery: string, body = ""): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...signChannelRequest(
        this.o.kid,
        this.o.privateKey,
        method,
        pathWithQuery,
        body,
        this.clock(),
      ),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    };
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${pathWithQuery}`, {
        method,
        headers,
        ...(method === "POST" ? { body } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ChannelError((e as Error)?.name === "TimeoutError" ? "timeout" : "network");
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ChannelError("network");
    }
    if (res.status !== 200) throw new ChannelError("http_error", res.status);
    if (text.length > MAX_RESPONSE) throw new ChannelError("bad_response");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ChannelError("bad_response");
    }
  }

  async pull(limit: number): Promise<{ id: string; event: unknown }[]> {
    const n = Math.max(1, Math.min(Math.floor(limit), 500));
    const r = (await this.call("GET", `/spool/events?limit=${n}`)) as { events?: unknown } | null;
    const events = r?.events;
    if (!Array.isArray(events) || events.length > n) throw new ChannelError("bad_response");
    const out: { id: string; event: unknown }[] = [];
    for (const e of events) {
      const id = (e as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !ID_RE.test(id) || !("event" in (e as object))) {
        throw new ChannelError("bad_response");
      }
      out.push({ id, event: (e as { event: unknown }).event });
    }
    return out;
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += 500) {
      const r = (await this.call(
        "POST",
        "/spool/ack",
        JSON.stringify({ ids: ids.slice(i, i + 500) }),
      )) as { acked?: unknown } | null;
      if (typeof r?.acked !== "number") throw new ChannelError("bad_response");
    }
  }

  async getStats(): Promise<SpoolStats> {
    const r = (await this.call("GET", "/spool/stats")) as Partial<SpoolStats> | null;
    if (
      !r ||
      typeof r.depth !== "number" ||
      !Number.isSafeInteger(r.depth) ||
      r.depth < 0 ||
      (r.oldestAgeMs !== null && typeof r.oldestAgeMs !== "number") ||
      typeof r.corrupt !== "number"
    ) {
      throw new ChannelError("bad_response");
    }
    return { depth: r.depth, oldestAgeMs: r.oldestAgeMs ?? null, corrupt: r.corrupt };
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Kanal anahtarları (uygulama)                                                                    */

export async function ensureChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (cur) return { kid: cur.kid };
  return rotateChannelKey(db, now);
}

/** Yeni kanal anahtarı etkin olur; eskisi iptal edilene kadar aktarıcıda geçerli kalabilir (kesintisiz döndürme). */
export async function rotateChannelKey(db: Db, now = Date.now()): Promise<{ kid: string }> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  const kid = kidOfPublicKey(x);
  await setSecret(
    channelKeySecretName(kid),
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  );
  await setSetting(db, "mail.unsubscribeChannel", {
    current: kid,
    keys: [...reg.keys, { kid, x, createdAt: now, revokedAt: null }],
  });
  await audit(
    db,
    "unsubscribe.channel_key_created",
    "unsubscribe_channel_key",
    kid,
    undefined,
    now,
  );
  return { kid };
}

export async function revokeChannelKey(db: Db, kid: string, now = Date.now()): Promise<boolean> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  if (!reg.keys.some((k) => k.kid === kid && k.revokedAt === null)) return false;
  await setSetting(db, "mail.unsubscribeChannel", {
    current: reg.current === kid ? null : reg.current,
    keys: reg.keys.map((k) => (k.kid === kid ? { ...k, revokedAt: now } : k)),
  });
  await deleteSecret(channelKeySecretName(kid));
  await audit(
    db,
    "unsubscribe.channel_key_revoked",
    "unsubscribe_channel_key",
    kid,
    undefined,
    now,
  );
  return true;
}

/** Aktarıcıya verilecek GENEL kanal anahtarları (iptal edilenler hariç). */
export async function exportChannelPublicKeys(db: Db): Promise<PublicKeyEntry[]> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  return reg.keys.filter((k) => k.revokedAt === null).map((k) => ({ kid: k.kid, x: k.x }));
}

/** Etkin kanal anahtarıyla imzalayıcı; yoksa null. */
export async function getChannelSigner(
  db: Db,
): Promise<{ kid: string; privateKey: crypto.KeyObject } | null> {
  const reg = await getSetting(db, "mail.unsubscribeChannel");
  const cur = reg.keys.find((k) => k.kid === reg.current && k.revokedAt === null);
  if (!cur) return null;
  const pkcs8 = await getSecret(channelKeySecretName(cur.kid));
  if (!pkcs8) return null;
  return {
    kid: cur.kid,
    privateKey: crypto.createPrivateKey({
      key: Buffer.from(pkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
  };
}
