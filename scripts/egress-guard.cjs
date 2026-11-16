/**
 * Faz 6 (paket G, NFR-01): ağ çıkışı bekçisi. Bir Node sürecine `NODE_OPTIONS=--require <bu dosya>` ile yüklenir ve
 * süreçten bu bilgisayar DIŞINA yapılan her bağlantı denemesini kaydeder (isteğe bağlı olarak engeller). Uygulama
 * kodunu değiştirmez; yalnızca gizlilik denetiminde (`e2e/privacy.spec.ts`) ve testte (`tests/egress-guard.test.ts`)
 * kullanılır. Paketlenmiş uygulamaya girmez.
 *
 * Ortam:
 *  - UM_EGRESS_LOG   : JSONL kayıt dosyası (her satır `{t, proc, kind, host, port}`). Yoksa kayıt yazılmaz.
 *  - UM_EGRESS_MODE  : `record` (varsayılan, yalnızca kaydeder) veya `block` (yerel olmayan denemeyi hata ile bitirir:
 *                      bağlantı ECONNREFUSED, DNS ENOTFOUND). Gerçek ağa hiç çıkılmaz.
 *  - UM_EGRESS_PROC  : kayıtlardaki süreç adı (ör. `server`, `worker`, `migrate`).
 *
 * Kapsam: `net.Socket.prototype.connect` (http, https, tls ve undici `fetch` buradan geçer), `dns.lookup`,
 * `dns.promises.lookup`, `dns.resolve*`/`reverse` (modül işlevleri ve `Resolver` sınıfları), `dgram` gönderimi.
 * İzinli: 127.0.0.0/8, ::1, localhost ve yerel soketler (Unix soketi / Windows adlandırılmış kanalı).
 */
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- düz CJS: `node --require` ile, derlenmeden yüklenir */

const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");

const LOG = process.env.UM_EGRESS_LOG || "";
const BLOCK = process.env.UM_EGRESS_MODE === "block";
const PROC = process.env.UM_EGRESS_PROC || `pid-${process.pid}`;
const MARK = Symbol.for("um.egressGuard");

function isLoopback(host) {
  if (host === undefined || host === null || host === "") return true; // varsayılan: localhost
  const h = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1" ||
    /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

function record(kind, host, port) {
  if (!LOG) return;
  try {
    fs.appendFileSync(
      LOG,
      `${JSON.stringify({ t: Date.now(), proc: PROC, kind, host: String(host), port: port ?? null })}\n`,
    );
  } catch {
    // Kayıt yazılamasa da süreç çalışmaya devam eder.
  }
}

function egressError(code, kind, host) {
  const e = new Error(`[egress-guard] ${kind} ${host} engellendi (${code})`);
  e.code = code;
  e.errno = code === "ENOTFOUND" ? -3008 : -61;
  e.syscall = kind === "connect" ? "connect" : "getaddrinfo";
  e.hostname = host;
  return e;
}

if (!globalThis[MARK]) {
  globalThis[MARK] = { block: BLOCK, log: LOG };

  /* --------------------------- TCP / TLS / fetch --------------------------- */
  const originalConnect = net.Socket.prototype.connect;
  /** `socket.connect` bağımsız değişkenlerinden {host, port, path}. */
  function target(args) {
    let a0 = args[0];
    // net.connect() iç çağrısı normalleştirilmiş diziyi geçer: [options, cb].
    if (Array.isArray(a0)) a0 = a0[0];
    if (a0 !== null && typeof a0 === "object") {
      return { host: a0.host, port: a0.port, path: a0.path };
    }
    if (typeof a0 === "string" && !/^\d+$/.test(a0)) return { path: a0 };
    return { host: typeof args[1] === "string" ? args[1] : undefined, port: a0 };
  }
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = target(args);
    if (t.path === undefined && !isLoopback(t.host)) {
      record("connect", t.host, t.port);
      if (BLOCK) {
        const err = egressError("ECONNREFUSED", "connect", t.host);
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return originalConnect.apply(this, args);
  };

  /* ---------------------------------- DNS ---------------------------------- */
  // IP sabitinin "çözümlenmesi" ağa çıkmaz (Node yanıtı yerelde üretir; ör. UDP soketinin 0.0.0.0'a örtük bağlanması).
  // O IP'ye yapılacak asıl bağlantı `connect`/`send` sırasında yakalanır.
  const needsDns = (hostname) => !isLoopback(hostname) && net.isIP(String(hostname)) === 0;
  const originalLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (needsDns(hostname)) {
      record("dns.lookup", hostname, null);
      if (BLOCK) {
        const cb = typeof options === "function" ? options : callback;
        process.nextTick(() => cb(egressError("ENOTFOUND", "dns.lookup", hostname)));
        return {};
      }
    }
    return originalLookup.call(this, hostname, options, callback);
  };
  const originalPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromiseLookup(hostname, options) {
    if (needsDns(hostname)) {
      record("dns.lookup", hostname, null);
      if (BLOCK) return Promise.reject(egressError("ENOTFOUND", "dns.lookup", hostname));
    }
    return originalPromiseLookup.call(this, hostname, options);
  };

  const RESOLVERS = [
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ];
  /** Geri çağırmalı (`dns.resolveMx(name, cb)`) veya söz dönen (`dns.promises.resolveMx(name)`) çözümleyici. */
  function wrapResolve(owner, name, promised) {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function guardedResolve(hostname, ...rest) {
      // Çözümleyici her zaman DNS sunucusuna (bu bilgisayar dışına) gider; ad yerel olsa bile kaydedilir.
      record(`dns.${name}`, hostname, null);
      if (BLOCK) {
        const err = egressError("ENOTFOUND", `dns.${name}`, hostname);
        if (promised) return Promise.reject(err);
        const cb = rest.at(-1);
        if (typeof cb === "function") process.nextTick(() => cb(err));
        return undefined;
      }
      return original.call(this, hostname, ...rest);
    };
  }
  for (const n of RESOLVERS) {
    wrapResolve(dns, n, false);
    wrapResolve(dns.promises, n, true);
    wrapResolve(dns.Resolver.prototype, n, false);
    wrapResolve(dns.promises.Resolver.prototype, n, true);
  }

  /* ---------------------------------- UDP ---------------------------------- */
  const originalSend = dgram.Socket.prototype.send;
  /**
   * `send(msg[, offset, length][, port][, address][, callback])` bağımsız değişkenlerinden hedef {address, port}.
   * Node'un kendi ayrıştırmasıyla aynı sırayla: ileti (ilk bağımsız değişken) HİÇBİR ZAMAN adres sayılmaz ve kaydedilmez.
   * Bağlı (connected) sokette adres verilmez; hedef `remoteAddress()`tır. Adressiz bağlı olmayan gönderim Node'da
   * 127.0.0.1 / ::1'e gider (yerel).
   */
  function udpTarget(socket, args) {
    let remote = null;
    try {
      remote = socket.remoteAddress(); // bağlı değilse ERR_SOCKET_DGRAM_NOT_CONNECTED fırlatır
    } catch {
      remote = null;
    }
    if (remote) return { address: remote.address, port: remote.port ?? null };
    const rest = args.slice(1);
    // [offset, length, port, address?] ya da [port, address?]
    const withRange =
      typeof rest[0] === "number" &&
      typeof rest[1] === "number" &&
      rest.length >= 3 &&
      typeof rest[2] !== "function";
    const port = withRange ? rest[2] : rest[0];
    const address = withRange ? rest[3] : rest[1];
    return {
      address: typeof address === "string" ? address : undefined,
      port: typeof port === "number" || typeof port === "string" ? Number(port) : null,
    };
  }
  dgram.Socket.prototype.send = function guardedSend(...args) {
    const { address, port } = udpTarget(this, args);
    if (!isLoopback(address)) {
      record("udp", address, port);
      if (BLOCK) {
        const cb = args.at(-1);
        if (typeof cb === "function")
          process.nextTick(() => cb(egressError("ECONNREFUSED", "udp", address)));
        return undefined;
      }
    }
    return originalSend.apply(this, args);
  };

  // ESM `import { lookup } from "node:dns"` gibi adlandırılmış içe aktarımlar da yamalı işlevleri görsün.
  try {
    require("node:module").syncBuiltinESMExports();
  } catch {
    // eski Node: yalnızca CJS yolları yamalıdır
  }
}

module.exports = { isLoopback };
