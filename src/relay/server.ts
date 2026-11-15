import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { createSpoolPullHandler } from "@/lib/unsubscribe/channel-server";
import { DEFAULT_SINK_TIMEOUT_MS, createRelayHandler } from "@/lib/unsubscribe/relay";
import { FileSpool, SPOOL_DEFAULT_MAX_PENDING } from "@/lib/unsubscribe/spool";
import {
  JSON_RESPONSE_HEADERS as JSON_H,
  MethodAwareRateLimiter,
  PLAIN_HEADERS as PLAIN,
  RelayConfigError,
  intEnv,
  rateLimitSubjectWith,
  routeClass,
  type RelayEnv,
} from "./common";
import { KeyFileLoader, normalizeOrigin } from "./key-file";
import {
  CLIENT_HEADER,
  createNodeListener,
  parseTrustedProxies,
  type ProxyTrust,
} from "./node-adapter";
import { FileReplayStore } from "./replay-store";

export { MethodAwareRateLimiter, RelayConfigError, routeClass, type RelayEnv } from "./common";

/**
 * Bağımsız HTTPS abonelikten çıkış AKTARICISI sunucusu (Aşama 15.7 dağıtımı; docs/09 Bölüm 3, K1–K11).
 *
 * Tek süreç, `node:http`; TLS önündeki ters vekilde (Caddy) sonlanır (deploy/relay/). Uygulamanın kendisi (Next)
 * aktarıcıyı barındıramaz: yalnızca 127.0.0.1'e bağlanır ve yabancı Host'u reddeder. Sunucu YÖNETMEK istemeyenler için
 * önerilen eşdeğer: Cloudflare Worker + D1 (./worker.ts, deploy/cloudflare-worker/); yollar ve protokol aynıdır.
 *
 * Yollar:
 *  - `/u/<belirteç>` (GET, HEAD, POST) → RFC 8058 işleyicisi (relay.ts); olaylar DAYANIKLI `FileSpool`a yazılır.
 *  - `/spool/events|ack|stats` → imzalı çekme/onay uçları (channel-protocol.ts); yalnızca uygulamanın kanal anahtarı.
 *  - `/healthz` (GET, HEAD) → en az bir belirteç + bir kanal anahtarı yüklü VE kuyruk dizini yazılabilir ise 200,
 *    aksi halde 503. Sayı/yaş/derinlik AÇIĞA VERİLMEZ.
 *  - Diğer her şey → 404.
 *
 * Bu sunucu GERÇEK GÖNDERİM yapmaz ve hiçbir canlı kapıyı açmaz; yalnızca alıcıların çıkış tıklamalarını kaydeder.
 * Uygulama, olayları kendi anahtarlarıyla yeniden doğrular (aktarıcıya güvenilmez). Günlüğe belirteç/yol YAZILMAZ.
 *
 * Ortam değişkenleri: bkz. `loadRelayConfig` ve deploy/relay/README.md.
 */

export interface RelayConfig {
  /** Normalleştirilmiş genel köken (ör. `https://cikis.firma.com`); istek URL'leri bundan kurulur. */
  origin: string;
  host: string;
  port: number;
  dataDir: string;
  keysFile: string;
  maxPending: number;
  sinkTimeoutMs: number;
  rateLimitGet: number;
  rateLimitPost: number;
  rateWindowMs: number;
  trust: ProxyTrust;
}

/** Ortam değişkenlerinden yapılandırma; eksik/geçersiz değerde `RelayConfigError`. */
export function loadRelayConfig(env: RelayEnv = process.env): RelayConfig {
  const origin = normalizeOrigin(env.RELAY_PUBLIC_ORIGIN?.trim() ?? "");
  if (!origin) {
    throw new RelayConfigError(
      "RELAY_PUBLIC_ORIGIN zorunlu: https://ana.makine biçiminde olmalı (yol, sorgu, kimlik bilgisi yok).",
    );
  }
  const header = (env.RELAY_TRUST_PROXY_HEADER ?? "x-real-ip").trim().toLowerCase();
  if (header && !/^[a-z0-9-]{1,64}$/.test(header)) {
    throw new RelayConfigError("RELAY_TRUST_PROXY_HEADER geçerli bir başlık adı olmalı.");
  }
  let trusted;
  try {
    trusted = parseTrustedProxies(env.RELAY_TRUSTED_PROXIES);
  } catch (e) {
    throw new RelayConfigError((e as Error).message);
  }
  return {
    origin,
    host: env.RELAY_HOST?.trim() || "127.0.0.1",
    port: intEnv(env, "RELAY_PORT", 8787, 0, 65_535),
    dataDir: env.RELAY_DATA_DIR?.trim() || "/var/lib/um-relay",
    keysFile: env.RELAY_KEYS_FILE?.trim() || "/etc/um-relay/keys.json",
    maxPending: intEnv(env, "RELAY_MAX_PENDING", SPOOL_DEFAULT_MAX_PENDING, 1, 10_000_000),
    sinkTimeoutMs: intEnv(env, "RELAY_SINK_TIMEOUT_MS", DEFAULT_SINK_TIMEOUT_MS, 100, 120_000),
    rateLimitGet: intEnv(env, "RELAY_RATE_LIMIT_GET", 60, 1, 1_000_000),
    rateLimitPost: intEnv(env, "RELAY_RATE_LIMIT_POST", 300, 1, 1_000_000),
    rateWindowMs: intEnv(env, "RELAY_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000),
    trust: { header: header || null, trusted },
  };
}

/** Hız sınırı için istemci kimliği (IPv6 → /64 öneki); bkz. `rateLimitSubjectWith` (./common). */
export function rateLimitSubject(ip: string): string {
  return rateLimitSubjectWith(ip, net.isIPv6);
}

/** Hız sınırı anahtarı: yöntem + bağdaştırıcının koyduğu güvenilir istemci adresi (gelen kopya silinmiştir). */
export function relayClientKey(req: Request): string {
  const method = req.method.toUpperCase() === "POST" ? "POST" : "GET";
  return `${method}:${rateLimitSubject(req.headers.get(CLIENT_HEADER) ?? "unknown")}`;
}

export interface RelayApp {
  /** Web düzeyinde yönlendirici (testlerde doğrudan çağrılabilir). */
  handle: (req: Request) => Promise<Response>;
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  keyFile: KeyFileLoader;
  spool: FileSpool;
  healthy: () => boolean;
}

export interface RelayDeps {
  now?: () => number;
  log?: (line: string) => void;
  /** Anahtar dosyası yeniden denetim aralığı (varsayılan 5 sn). */
  keyReloadMs?: number;
}

export function createRelayApp(config: RelayConfig, deps: RelayDeps = {}): RelayApp {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  const spoolDir = path.join(config.dataDir, "spool");
  const spool = new FileSpool({ dir: spoolDir, maxPending: config.maxPending, now });
  const keyFile = new KeyFileLoader({
    path: config.keysFile,
    origin: config.origin,
    minIntervalMs: deps.keyReloadMs,
    now,
    log,
  });
  keyFile.refresh(true);
  const replay = new FileReplayStore({ file: path.join(config.dataDir, "replay.log"), now });

  const relay = createRelayHandler({
    keys: () => keyFile.tokenKeys(),
    sink: spool,
    replay,
    limiter: new MethodAwareRateLimiter(
      config.rateLimitGet,
      config.rateLimitPost,
      config.rateWindowMs,
    ),
    clientKey: relayClientKey,
    sinkTimeoutMs: config.sinkTimeoutMs,
    now,
  });
  const pull = createSpoolPullHandler({ spool, keys: () => keyFile.channelKeys(), now });

  const healthy = (): boolean => {
    if (!keyFile.ready()) return false;
    try {
      fs.accessSync(path.join(spoolDir, "pending"), fs.constants.W_OK);
      fs.accessSync(path.join(spoolDir, "tmp"), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const handle = async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();
    if (pathname.startsWith("/u/")) return relay(req);
    if (/^\/spool\/(events|ack|stats)$/.test(pathname)) return pull(req);
    if (pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { ...PLAIN, Allow: "GET, HEAD" },
        });
      }
      const ok = healthy();
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 503, headers: JSON_H });
    }
    return new Response("Not found", { status: 404, headers: PLAIN });
  };

  const listener = createNodeListener(handle, {
    origin: config.origin,
    trust: config.trust,
    onResponse: ({ method, pathname, status, ms }) =>
      log(`${new Date(now()).toISOString()} ${method} ${routeClass(pathname)} ${status} ${ms}ms`),
  });

  return { handle, listener, keyFile, spool, healthy };
}

export interface RunningRelay {
  server: http.Server;
  app: RelayApp;
  /** Dinlenen adres (testte port 0 ile kullanılır). */
  address: AddressInfo;
  close: () => Promise<void>;
}

/** Sunucuyu başlatır; zaman aşımları: istek 15 sn, başlık 10 sn, canlı tutma 5 sn. */
export async function startRelayServer(
  config: RelayConfig,
  deps: RelayDeps = {},
): Promise<RunningRelay> {
  const app = createRelayApp(config, deps);
  const server = http.createServer(app.listener);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  return { server, app, address: server.address() as AddressInfo, close };
}
