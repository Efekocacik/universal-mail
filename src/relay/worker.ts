import { createSpoolPullHandler } from "@/lib/unsubscribe/channel-server";
import { DEFAULT_SINK_TIMEOUT_MS, createRelayHandler } from "@/lib/unsubscribe/relay";
import type { PublicKeyEntry } from "@/lib/unsubscribe/token-core";
import {
  JSON_RESPONSE_HEADERS,
  MethodAwareRateLimiter,
  PLAIN_HEADERS,
  RelayConfigError,
  intEnv,
  isIPv4Text,
  isIPv6Text,
  rateLimitSubjectWith,
  routeClass,
} from "./common";
import { D1ReplayStore, D1Spool, WORKER_DEFAULT_MAX_PENDING } from "./d1-spool";
import type { D1Database } from "./d1-types";
import { KeyFileError, normalizeOrigin, parseKeySetWeb, type RelayKeySet } from "./key-set";

/**
 * Cloudflare Worker abonelikten çıkış AKTARICISI (VPS'siz önerilen yol; deploy/cloudflare-worker/README.md).
 *
 * VPS aktarıcısıyla (./server.ts) AYNI yollar ve protokol; uygulama ikisini ayırt etmez:
 *  - `/u/<belirteç>` (GET, HEAD, POST) → RFC 8058 işleyicisi (relay.ts); olaylar DAYANIKLI D1 kuyruğuna yazılır,
 *    200 ancak kayıt onaylandıktan SONRA verilir.
 *  - `/spool/events|ack|stats` → imzalı çekme/onay uçları (channel-server.ts); yalnızca uygulamanın kanal anahtarı.
 *  - `/healthz` (GET, HEAD) → en az bir belirteç + bir kanal anahtarı yüklü VE D1'e ulaşılıyor ve şema uygulanmış
 *    ise 200, aksi halde 503. Sayı/yaş/derinlik AÇIĞA VERİLMEZ.
 *  - Diğer her şey → 404.
 *
 * Ortam (wrangler.toml / panel):
 *  - `DB` (D1 bağlaması, zorunlu), `RELAY_KEYS` (GİZLİ DEĞİŞKEN: uygulamanın "Anahtar dosyasını indir" ile verdiği
 *    relay-keys.json İÇERİĞİ; yalnızca GENEL anahtarlar).
 *  - İsteğe bağlı: `RELAY_PUBLIC_ORIGIN` (boşsa isteğin kendi https kökeni, ör. https://um-relay.<hesap>.workers.dev),
 *    `RELAY_MAX_PENDING` (varsayılan 10000), `RELAY_RATE_LIMIT_GET` (60), `RELAY_RATE_LIMIT_POST` (300),
 *    `RELAY_RATE_WINDOW_MS` (60000), `RELAY_SINK_TIMEOUT_MS` (10000).
 *
 * Güvenlik: aktarıcıda GİZLİ ANAHTAR YOKTUR (yalnızca genel anahtarlar); uygulama her olayı kendi anahtarlarıyla
 * yeniden doğrular. Hız sınırı istemci adresi YALNIZCA Cloudflare'in koyduğu `CF-Connecting-IP` başlığından alınır
 * (`X-Forwarded-For` vb. yok sayılır). Günlüğe belirteç/yol YAZILMAZ (yalnızca yöntem, yol sınıfı, durum).
 * SINIR (dürüstlük): bellek içi hız sınırı her Worker örneğine (isolate) ayrıdır; dağıtık bir saldırıya karşı tam
 * koruma DEĞİLDİR. Geçersiz belirteç kuyruğa/D1'e hiç yazılmaz; GET hiçbir veritabanı işlemi yapmaz.
 *
 * Kripto yalnızca WebCrypto'dur (Ed25519, SHA-256): `nodejs_compat` bayrağı ve `node:` modülü GEREKMEZ.
 */

export interface WorkerEnv {
  DB?: D1Database;
  RELAY_KEYS?: string;
  RELAY_PUBLIC_ORIGIN?: string;
  RELAY_MAX_PENDING?: string;
  RELAY_RATE_LIMIT_GET?: string;
  RELAY_RATE_LIMIT_POST?: string;
  RELAY_RATE_WINDOW_MS?: string;
  RELAY_SINK_TIMEOUT_MS?: string;
}

/** Cloudflare `ExecutionContext`in kullanılan alt kümesi (kullanılmıyor; imza uyumu için). */
export interface WorkerContext {
  waitUntil?(p: Promise<unknown>): void;
}

export interface WorkerConfig {
  /** Sabit köken (`RELAY_PUBLIC_ORIGIN`); null → isteğin kendi kökeni. */
  origin: string | null;
  maxPending: number;
  sinkTimeoutMs: number;
  rateLimitGet: number;
  rateLimitPost: number;
  rateWindowMs: number;
}

/** Ortamdan yapılandırma; geçersiz değerde `RelayConfigError`. */
export function loadWorkerConfig(env: WorkerEnv): WorkerConfig {
  const rawOrigin = env.RELAY_PUBLIC_ORIGIN?.trim() ?? "";
  const origin = rawOrigin ? normalizeOrigin(rawOrigin) : null;
  if (rawOrigin && !origin) {
    throw new RelayConfigError(
      "RELAY_PUBLIC_ORIGIN https://ana.makine biçiminde olmalı (yol, sorgu, kimlik bilgisi yok).",
    );
  }
  const e = env as Record<string, string | undefined>;
  return {
    origin,
    maxPending: intEnv(e, "RELAY_MAX_PENDING", WORKER_DEFAULT_MAX_PENDING, 1, 10_000_000),
    sinkTimeoutMs: intEnv(e, "RELAY_SINK_TIMEOUT_MS", DEFAULT_SINK_TIMEOUT_MS, 100, 120_000),
    rateLimitGet: intEnv(e, "RELAY_RATE_LIMIT_GET", 60, 1, 1_000_000),
    rateLimitPost: intEnv(e, "RELAY_RATE_LIMIT_POST", 300, 1, 1_000_000),
    rateWindowMs: intEnv(e, "RELAY_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000),
  };
}

/**
 * Hız sınırı anahtarı: yöntem + `CF-Connecting-IP` (Cloudflare kenarı koyar, istemci değiştiremez). Başlık yoksa veya
 * geçerli bir IP değilse tek ortak "unknown" kovası. IPv6 → /64 öneki.
 */
export function workerClientKey(req: Request): string {
  const method = req.method.toUpperCase() === "POST" ? "POST" : "GET";
  const ip = (req.headers.get("cf-connecting-ip") ?? "").trim();
  const subject =
    isIPv4Text(ip) || isIPv6Text(ip) ? rateLimitSubjectWith(ip, isIPv6Text) : "unknown";
  return `${method}:${subject}`;
}

export interface WorkerDeps {
  now?: () => number;
  log?: (line: string) => void;
  randomHex16?: () => string;
  /** D1 sağlık sonucunun önbellek süresi (ms; varsayılan 10 sn; testte 0). */
  healthCacheMs?: number;
}

export interface WorkerApp {
  handle(req: Request): Promise<Response>;
}

const plain = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...PLAIN_HEADERS, ...extra } });
const unavailable = () => plain(503, "Unavailable", { "Retry-After": "60" });

/** Köken başına en çok bu kadar işleyici kümesi tutulur (yalnızca yönlendirilen ana makineler gelir). */
const MAX_ORIGINS = 8;

export function createWorkerApp(env: WorkerEnv, deps: WorkerDeps = {}): WorkerApp {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const healthCacheMs = deps.healthCacheMs ?? 10_000;
  const logged = new Set<string>();
  const logOnce = (line: string) => {
    if (logged.has(line)) return;
    logged.add(line);
    log(line);
  };

  let config: WorkerConfig | null = null;
  try {
    config = loadWorkerConfig(env);
  } catch (e) {
    // İleti yalnızca değişken adını ve kuralı içerir (değer yazılmaz).
    logOnce(`config rejected: ${e instanceof RelayConfigError ? e.message : "error"}`);
  }
  const db = env.DB && typeof env.DB.prepare === "function" ? env.DB : null;
  if (!db) logOnce("D1 binding DB missing");
  const rawKeys = typeof env.RELAY_KEYS === "string" ? env.RELAY_KEYS.trim() : "";
  if (!rawKeys) logOnce("keys missing (RELAY_KEYS)");

  const spool = db
    ? new D1Spool({
        db,
        maxPending: config?.maxPending,
        now,
        randomHex16: deps.randomHex16,
      })
    : null;
  const replay = db ? new D1ReplayStore(db, now) : null;
  const limiter = config
    ? new MethodAwareRateLimiter(config.rateLimitGet, config.rateLimitPost, config.rateWindowMs)
    : null;

  /** Köken → doğrulanmış anahtar kümesi (geçersizse null; yalnızca hata kodu günlüğe yazılır). */
  const keySets = new Map<string, Promise<RelayKeySet | null>>();
  const keySet = (origin: string): Promise<RelayKeySet | null> => {
    if (!rawKeys) return Promise.resolve(null);
    let p = keySets.get(origin);
    if (!p) {
      p = parseKeySetWeb(rawKeys, origin).then(
        (set) => {
          logOnce(`keys loaded token=${set.tokenKeys.length} channel=${set.channelKeys.length}`);
          return set;
        },
        (e: unknown) => {
          logOnce(`keys rejected code=${e instanceof KeyFileError ? e.code : "bad_json"}`);
          return null;
        },
      );
      if (keySets.size >= MAX_ORIGINS) keySets.delete(keySets.keys().next().value!);
      keySets.set(origin, p);
    }
    return p;
  };
  const requireKeys = async (
    origin: string,
    pick: (s: RelayKeySet) => PublicKeyEntry[],
  ): Promise<PublicKeyEntry[]> => {
    const set = await keySet(origin);
    if (!set) throw new KeyFileError("unavailable");
    return pick(set);
  };

  interface Handlers {
    relay: (req: Request) => Promise<Response>;
    pull: (req: Request) => Promise<Response>;
  }
  const handlers = new Map<string, Handlers>();
  const handlersFor = (origin: string): Handlers | null => {
    if (!spool || !replay || !limiter || !config) return null;
    let h = handlers.get(origin);
    if (!h) {
      h = {
        relay: createRelayHandler({
          keys: () => requireKeys(origin, (s) => s.tokenKeys),
          sink: spool,
          replay,
          limiter,
          clientKey: workerClientKey,
          sinkTimeoutMs: config.sinkTimeoutMs,
          now,
        }),
        pull: createSpoolPullHandler({
          spool,
          keys: () => requireKeys(origin, (s) => s.channelKeys),
          now,
        }),
      };
      if (handlers.size >= MAX_ORIGINS) handlers.delete(handlers.keys().next().value!);
      handlers.set(origin, h);
    }
    return h;
  };

  let dbHealth: { at: number; ok: boolean } | null = null;
  const dbReachable = async (): Promise<boolean> => {
    if (!spool) return false;
    const t = now();
    if (dbHealth && healthCacheMs > 0 && t - dbHealth.at < healthCacheMs) return dbHealth.ok;
    const ok = await spool.reachable();
    dbHealth = { at: t, ok };
    return ok;
  };
  const healthy = async (origin: string | null): Promise<boolean> => {
    if (!config || !origin) return false;
    const set = await keySet(origin);
    if (!set || set.tokenKeys.length === 0 || set.channelKeys.length === 0) return false;
    return dbReachable();
  };

  const route = async (req: Request, url: URL, method: string): Promise<Response> => {
    const { pathname } = url;
    const origin = config ? (config.origin ?? normalizeOrigin(url.origin)) : null;
    if (pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") {
        return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
      }
      const ok = await healthy(origin);
      return new Response(JSON.stringify({ ok }), {
        status: ok ? 200 : 503,
        headers: JSON_RESPONSE_HEADERS,
      });
    }
    const isRelay = pathname.startsWith("/u/");
    const isPull = /^\/spool\/(events|ack|stats)$/.test(pathname);
    if (!isRelay && !isPull) return plain(404, "Not found");
    const h = origin ? handlersFor(origin) : null;
    if (!h) return unavailable();
    return isRelay ? h.relay(req) : h.pull(req);
  };

  const handle = async (req: Request): Promise<Response> => {
    const started = now();
    const method = req.method.toUpperCase();
    let pathname = "";
    let out: Response;
    try {
      const url = new URL(req.url);
      pathname = url.pathname;
      out = await route(req, url, method);
    } catch {
      out = plain(500, "Internal error");
    }
    if (method === "HEAD" && out.body) {
      await out.body.cancel().catch(() => undefined);
      out = new Response(null, { status: out.status, headers: out.headers });
    }
    log(
      `${new Date(now()).toISOString()} ${method} ${routeClass(pathname)} ${out.status} ${now() - started}ms`,
    );
    return out;
  };

  return { handle };
}

/* ---------------------------------------------------------------------------------------------- */
/* Worker girişi                                                                                   */

/**
 * Uygulama örneği isolate başına bir kez kurulur (hız sınırı sayaçları ve anahtar önbelleği istekler arasında
 * korunur). Ortam değişirse (yeni gizli değer = yeni dağıtım) yeniden kurulur.
 */
let cached: { db: unknown; fingerprint: string; app: WorkerApp } | null = null;

function appFor(env: WorkerEnv): WorkerApp {
  const fingerprint = JSON.stringify([
    env.RELAY_KEYS ?? null,
    env.RELAY_PUBLIC_ORIGIN ?? null,
    env.RELAY_MAX_PENDING ?? null,
    env.RELAY_RATE_LIMIT_GET ?? null,
    env.RELAY_RATE_LIMIT_POST ?? null,
    env.RELAY_RATE_WINDOW_MS ?? null,
    env.RELAY_SINK_TIMEOUT_MS ?? null,
  ]);
  if (!cached || cached.db !== env.DB || cached.fingerprint !== fingerprint) {
    cached = { db: env.DB, fingerprint, app: createWorkerApp(env) };
  }
  return cached.app;
}

const worker = {
  fetch(req: Request, env: WorkerEnv, _ctx?: WorkerContext): Promise<Response> {
    return appFor(env).handle(req);
  },
};

export default worker;
