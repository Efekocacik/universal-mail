import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChannelError,
  HttpEventSource,
  signChannelRequest,
} from "@/lib/unsubscribe/channel-protocol";
import * as channelReexports from "@/lib/unsubscribe/channel";
import { kidOfPublicKey, newClaims, signToken, type PublicKeyEntry } from "@/lib/unsubscribe/token";
import { KeyFileError, KeyFileLoader, normalizeOrigin, parseKeyFile } from "@/relay/key-file";
import { clientAddress, normalizeIp, parseTrustedProxies } from "@/relay/node-adapter";
import { FileReplayStore } from "@/relay/replay-store";
import {
  RelayConfigError,
  loadRelayConfig,
  rateLimitSubject,
  routeClass,
  startRelayServer,
  type RunningRelay,
} from "@/relay/server";

/**
 * Bağımsız aktarıcı sunucusu (src/relay; Aşama 15.7 dağıtımı). Gerçek Node HTTP sunucusu 127.0.0.1 üzerinde geçici
 * bir portta çalışır; gerçek alan adı/TLS YOKTUR. Kuyruk geçici dizindeki gerçek `FileSpool`dur.
 */

const ORIGIN = "https://cikis.example.test";
const TAG = "B".repeat(22);

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { privateKey, entry: { kid: kidOfPublicKey(x), x } as PublicKeyEntry };
}
const TOKEN_KEY = keypair();
const CHANNEL_KEY = keypair();
const STRANGER = keypair();

const mint = (now = Date.now()) =>
  signToken(
    newClaims({
      kid: TOKEN_KEY.entry.kid,
      campaignLeadId: 7,
      messageId: 8,
      recipientTag: TAG,
      now,
    }),
    TOKEN_KEY.privateKey,
  );

const keyFileJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    origin: ORIGIN,
    tokenKeys: [TOKEN_KEY.entry],
    channelKeys: [CHANNEL_KEY.entry],
    generatedAt: Date.now(),
    ...over,
  });

let dir: string;
let running: RunningRelay | null = null;
let logs: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-relay-"));
  logs = [];
});
afterEach(async () => {
  if (running) {
    running.server.closeAllConnections();
    await running.close();
    running = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const keysPath = () => path.join(dir, "keys.json");
const pendingDir = () => path.join(dir, "data", "spool", "pending");

async function start(env: Record<string, string> = {}): Promise<string> {
  const config = loadRelayConfig({
    RELAY_PUBLIC_ORIGIN: ORIGIN,
    RELAY_PORT: "0",
    RELAY_DATA_DIR: path.join(dir, "data"),
    RELAY_KEYS_FILE: keysPath(),
    ...env,
  });
  running = await startRelayServer(config, { log: (l) => logs.push(l), keyReloadMs: 0 });
  return `http://127.0.0.1:${running.address.port}`;
}

const FORM = "application/x-www-form-urlencoded";
const postForm = (base: string, token: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/u/${token}`, {
    method: "POST",
    headers: { "Content-Type": FORM, ...headers },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
  });
const postMultipart = (base: string, token: string) => {
  const fd = new FormData();
  fd.set("List-Unsubscribe", "One-Click");
  return fetch(`${base}/u/${token}`, { method: "POST", body: fd, redirect: "manual" });
};
const pendingFiles = () => fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json"));

describe("channel-protocol ayrımı", () => {
  it("channel.ts saf protokolü AYNEN yeniden dışa aktarır (aynı nesneler)", () => {
    expect(channelReexports.HttpEventSource).toBe(HttpEventSource);
    expect(channelReexports.ChannelError).toBe(ChannelError);
    expect(channelReexports.signChannelRequest).toBe(signChannelRequest);
  });
});

describe("aktarıcı sunucusu: gerçek HTTP gidiş-dönüş", () => {
  it("/healthz: anahtar yokken 503, geçerli anahtar dosyası yüklenince 200; sayı/derinlik açığa vermez", async () => {
    const base = await start();
    const r1 = await fetch(`${base}/healthz`);
    expect(r1.status).toBe(503);
    expect(await r1.json()).toEqual({ ok: false });
    // anahtar yokken /u/ ve /spool/ de 503 (sessizce kabul edilmez)
    expect((await postForm(base, mint())).status).toBe(503);
    expect(pendingFiles()).toHaveLength(0);

    fs.writeFileSync(keysPath(), keyFileJson());
    const r2 = await fetch(`${base}/healthz`);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true });
    expect(r2.headers.get("cache-control")).toBe("no-store");
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(405);

    // yalnızca belirteç anahtarı varsa (kanal anahtarı yok) sağlıklı DEĞİL
    fs.writeFileSync(keysPath(), keyFileJson({ channelKeys: [] }));
    fs.utimesSync(keysPath(), new Date(), new Date(Date.now() + 5_000));
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("POST urlencoded ve multipart → 200 ve her biri DAYANIKLI kuyruk dosyası; tekrar → yeni dosya yok", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start();
    const t1 = mint();
    const t2 = mint();
    const r1 = await postForm(base, t1);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("location")).toBeNull();
    expect((await postMultipart(base, t2)).status).toBe(200);
    const files = pendingFiles();
    expect(files).toHaveLength(2);
    const stored = files.map(
      (f) => JSON.parse(fs.readFileSync(path.join(pendingDir(), f), "utf8")) as { token: string },
    );
    expect(stored.map((e) => e.token).sort()).toEqual([t1, t2].sort());
    for (const f of files) {
      expect(fs.statSync(path.join(pendingDir(), f)).mode & 0o777).toBe(0o600);
    }
    // idempotent: aynı belirteç tekrar → 200, yeni dosya yok
    expect((await postForm(base, t1)).status).toBe(200);
    expect((await postMultipart(base, t2)).status).toBe(200);
    expect(pendingFiles()).toHaveLength(2);
    // GET durum değiştirmez
    const g = await fetch(`${base}/u/${mint()}`);
    expect(g.status).toBe(200);
    expect(pendingFiles()).toHaveLength(2);
  });

  it("bozuk belirteç 400 (multipart dahil, 415 DEĞİL); başka içerik türü 415; bilinmeyen yol 404", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start();
    expect((await postForm(base, "u2.a.b")).status).toBe(400);
    const mp = await fetch(`${base}/u/u2.a.b`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=x" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(mp.status).toBe(400);
    expect((await postMultipart(base, "u2.a.b")).status).toBe(400);
    const json = await fetch(`${base}/u/${mint()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
    expect((await fetch(`${base}/u/u2.a.b`)).status).toBe(400);
    for (const p of ["/", "/u", "/spool/other", "/favicon.ico", "/healthz/x"]) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
    expect(pendingFiles()).toHaveLength(0);
  });

  it("imzalı kanal: çek → onayla → kuyruk boş; imzasız/yabancı anahtarlı istek 401", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start();
    const t1 = mint();
    expect((await postForm(base, t1)).status).toBe(200);
    expect((await postMultipart(base, mint())).status).toBe(200);

    const src = new HttpEventSource({
      baseUrl: base,
      kid: CHANNEL_KEY.entry.kid,
      privateKey: CHANNEL_KEY.privateKey,
      allowLoopbackHttp: true,
    });
    expect((await src.getStats()).depth).toBe(2);
    const events = await src.pull(10);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.event as { token: string }).token)).toContain(t1);
    await src.ack(events.map((e) => e.id));
    expect(pendingFiles()).toHaveLength(0);
    expect(await src.getStats()).toEqual({ depth: 0, oldestAgeMs: null, corrupt: 0 });

    // imzasız
    const unsigned = await fetch(`${base}/spool/stats`);
    expect(unsigned.status).toBe(401);
    // dağıtılmamış (yabancı) kanal anahtarı
    const stranger = new HttpEventSource({
      baseUrl: base,
      kid: STRANGER.entry.kid,
      privateKey: STRANGER.privateKey,
      allowLoopbackHttp: true,
    });
    await expect(stranger.pull(10)).rejects.toMatchObject({ code: "http_error", status: 401 });
    // belirteç anahtarı kanal anahtarı YERİNE geçmez
    const tokenKeyAsChannel = new HttpEventSource({
      baseUrl: base,
      kid: TOKEN_KEY.entry.kid,
      privateKey: TOKEN_KEY.privateKey,
      allowLoopbackHttp: true,
    });
    await expect(tokenKeyAsChannel.getStats()).rejects.toMatchObject({ status: 401 });
  });

  it("günlük: yöntem, yol sınıfı ve durum; belirteç ve yol ASLA yazılmaz", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start();
    const t = mint();
    await postForm(base, t);
    await fetch(`${base}/u/${t}`);
    await fetch(`${base}/spool/stats`);
    await fetch(`${base}/secret-path-xyz`);
    const reqLines = logs.filter((l) => / (GET|POST|HEAD) /.test(l));
    expect(reqLines).toHaveLength(4);
    expect(reqLines[0]).toMatch(/ POST u 200 \d+ms$/);
    expect(reqLines[2]).toMatch(/ GET spool 401 \d+ms$/);
    expect(reqLines[3]).toMatch(/ GET other 404 \d+ms$/);
    const all = logs.join("\n");
    expect(all).not.toContain(t);
    expect(all).not.toContain(t.slice(3, 40));
    expect(all).not.toContain("/u/");
    expect(all).not.toContain("secret-path-xyz");
  });

  it("tekrar oynatma kaydı dosyada kalıcıdır: yeniden başlatmadan sonra aynı belirteç yeni olay üretmez", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    let base = await start();
    const t = mint();
    expect((await postForm(base, t)).status).toBe(200);
    expect(pendingFiles()).toHaveLength(1);
    running!.server.closeAllConnections();
    await running!.close();
    running = null;
    base = await start();
    expect((await postForm(base, t)).status).toBe(200);
    expect(pendingFiles()).toHaveLength(1); // kuyruk dosyası da yeniden başlatmada durur (K2)
  });

  it("Host başlığına güvenilmez; mutlak biçimli istek hedefi 400", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start();
    const port = running!.address.port;
    const status = (reqPath: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = http.request(
          { host: "127.0.0.1", port, path: reqPath, method: "GET", headers: { Host: host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on("error", reject);
        r.end();
      });
    expect(await status("/healthz", "evil.example")).toBe(200);
    expect(await status("http://evil.example/healthz", "evil.example")).toBe(400);
    expect(await status("//evil.example/healthz", "x")).toBe(400);
    expect(base).toContain("127.0.0.1");
  });
});

describe("hız sınırı ve güvenilir vekil başlığı (TB-5)", () => {
  it("gelen x-um-client kopyası silinir: sahte istemci anahtarıyla sınır atlatılamaz", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start({ RELAY_RATE_LIMIT_POST: "1", RELAY_TRUST_PROXY_HEADER: "" });
    expect((await postForm(base, mint(), { "X-UM-Client": "a" })).status).toBe(200);
    expect((await postForm(base, mint(), { "X-UM-Client": "b" })).status).toBe(429);
    // GET kovası ayrıdır (yönteme duyarlı)
    expect((await fetch(`${base}/u/${mint()}`)).status).toBe(200);
  });

  it("geri döngü soketinden gelen X-Real-IP dikkate alınır (ayrı kovalar); başlık kapatılınca tek kova", async () => {
    fs.writeFileSync(keysPath(), keyFileJson());
    const base = await start({ RELAY_RATE_LIMIT_POST: "1" });
    expect((await postForm(base, mint(), { "X-Real-IP": "198.51.100.1" })).status).toBe(200);
    expect((await postForm(base, mint(), { "X-Real-IP": "198.51.100.2" })).status).toBe(200);
    expect((await postForm(base, mint(), { "X-Real-IP": "198.51.100.1" })).status).toBe(429);
    // geçersiz başlık değeri → soket adresi
    expect((await postForm(base, mint(), { "X-Real-IP": "not-an-ip" })).status).toBe(200);
    expect((await postForm(base, mint(), { "X-Real-IP": "also-bad" })).status).toBe(429);
  });

  it("hız sınırı kimliği: IPv4 aynen; IPv6 /64 önekine indirgenir (adres döndürerek sınır atlatılamaz)", () => {
    expect(rateLimitSubject("198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitSubject("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubject("2001:DB8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(rateLimitSubject("2001:db8::5")).toBe("2001:db8:0:0::/64");
    expect(rateLimitSubject("2001:0db8:0000:0001::")).toBe("2001:db8:0:1::/64");
    expect(rateLimitSubject("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    // IPv4 eşlemeli (onaltılık) ve geri döngü: tek kovada toplanmaz.
    expect(rateLimitSubject("::ffff:c000:201")).toBe("::ffff:c000:201");
    expect(rateLimitSubject("::1")).toBe("::1");
    expect(rateLimitSubject("unknown")).toBe("unknown");
  });

  it("güvenilmeyen soketten gelen vekil başlığı YOK SAYILIR; güvenilir ağdan gelen kabul edilir", () => {
    const trust = { header: "x-real-ip", trusted: parseTrustedProxies("172.18.0.0/16, fd00::/8") };
    const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({
      headers,
      socket: { remoteAddress },
    });
    expect(clientAddress(req("203.0.113.5", { "x-real-ip": "198.51.100.9" }), trust)).toBe(
      "203.0.113.5",
    );
    expect(clientAddress(req("::ffff:203.0.113.5", { "x-real-ip": "1.2.3.4" }), trust)).toBe(
      "203.0.113.5",
    );
    expect(clientAddress(req("172.18.0.3", { "x-real-ip": "198.51.100.9" }), trust)).toBe(
      "198.51.100.9",
    );
    expect(clientAddress(req("fd00::1", { "x-real-ip": "2001:db8::1" }), trust)).toBe(
      "2001:db8::1",
    );
    expect(clientAddress(req("127.0.0.1", { "x-real-ip": "198.51.100.9" }), trust)).toBe(
      "198.51.100.9",
    );
    expect(clientAddress(req("::1", { "x-real-ip": "198.51.100.9" }), trust)).toBe("198.51.100.9");
    // virgüllü liste: vekile en yakın (en sağdaki) adres
    const xff = { header: "x-forwarded-for", trusted: parseTrustedProxies("") };
    expect(
      clientAddress(req("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" }), xff),
    ).toBe("198.51.100.7");
    // başlık devre dışı
    expect(
      clientAddress(req("127.0.0.1", { "x-real-ip": "198.51.100.9" }), {
        header: null,
        trusted: parseTrustedProxies(""),
      }),
    ).toBe("127.0.0.1");
    expect(normalizeIp("[::1]")).toBe("::1");
    expect(normalizeIp("x")).toBeNull();
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow();
    expect(() => parseTrustedProxies("nope")).toThrow();
  });
});

describe("anahtar dosyası doğrulama ve sıcak yeniden yükleme", () => {
  it("geçerli dosya ayrıştırılır; köken normalleştirilir", () => {
    const set = parseKeyFile(keyFileJson({ origin: `${ORIGIN}/` }), ORIGIN);
    expect(set.tokenKeys).toEqual([TOKEN_KEY.entry]);
    expect(set.channelKeys).toEqual([CHANNEL_KEY.entry]);
    expect(normalizeOrigin("https://A.example.test/")).toBe("https://a.example.test");
    for (const bad of [
      "http://a.example.test",
      "https://u:p@a.example.test",
      "https://a.example.test/x",
      "https://a.example.test/?q=1",
      "x",
    ]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });

  it("uyuşmayan kid, farklı köken, bozuk giriş, tekrar, sürüm, JSON → reddedilir (kodla)", () => {
    const code = (raw: string) => {
      try {
        parseKeyFile(raw, ORIGIN);
        return "ok";
      } catch (e) {
        return (e as KeyFileError).code;
      }
    };
    const wrongKid = { kid: STRANGER.entry.kid, x: TOKEN_KEY.entry.x };
    expect(code(keyFileJson({ tokenKeys: [wrongKid] }))).toBe("kid_mismatch");
    expect(code(keyFileJson({ channelKeys: [CHANNEL_KEY.entry, wrongKid] }))).toBe("kid_mismatch");
    expect(code(keyFileJson({ origin: "https://baska.example.test" }))).toBe("origin_mismatch");
    expect(code(keyFileJson({ origin: "http://cikis.example.test" }))).toBe("origin_mismatch");
    expect(code(keyFileJson({ origin: undefined }))).toBe("origin_mismatch");
    expect(code(keyFileJson({ tokenKeys: [{ kid: "ABC", x: TOKEN_KEY.entry.x }] }))).toBe(
      "bad_entry",
    );
    expect(code(keyFileJson({ tokenKeys: [{ kid: TOKEN_KEY.entry.kid, x: "short" }] }))).toBe(
      "bad_entry",
    );
    expect(code(keyFileJson({ tokenKeys: "x" }))).toBe("bad_entry");
    expect(code(keyFileJson({ tokenKeys: [TOKEN_KEY.entry, TOKEN_KEY.entry] }))).toBe(
      "duplicate_kid",
    );
    expect(code(keyFileJson({ tokenKeys: Array(51).fill(TOKEN_KEY.entry) }))).toBe("too_many");
    expect(code(keyFileJson({ v: 2 }))).toBe("bad_version");
    expect(code("{nope")).toBe("bad_json");
    expect(code("[]")).toBe("bad_json");
  });

  it("geçersiz yeni dosya son geçerli kümeyi bozmaz; hiç geçerli küme yoksa istisna; aralık sınırı uyulur", () => {
    let now = 1_000_000;
    const loader = new KeyFileLoader({
      path: keysPath(),
      origin: ORIGIN,
      minIntervalMs: 5_000,
      now: () => now,
      log: (l) => logs.push(l),
    });
    expect(() => loader.tokenKeys()).toThrow(KeyFileError);
    expect(loader.ready()).toBe(false);

    fs.writeFileSync(keysPath(), keyFileJson({ origin: "https://baska.example.test" }));
    now += 5_000;
    expect(() => loader.channelKeys()).toThrow(KeyFileError); // köken uyuşmuyor → yüklenmez

    fs.writeFileSync(keysPath(), keyFileJson());
    fs.utimesSync(keysPath(), new Date(), new Date(Date.now() + 10_000));
    now += 1_000; // aralık dolmadı: yeniden okunmaz
    expect(loader.ready()).toBe(false);
    now += 5_000;
    expect(loader.ready()).toBe(true);
    expect(loader.tokenKeys()).toEqual([TOKEN_KEY.entry]);

    // döndürme: yeni geçerli küme yüklenir
    fs.writeFileSync(keysPath(), keyFileJson({ tokenKeys: [STRANGER.entry, TOKEN_KEY.entry] }));
    fs.utimesSync(keysPath(), new Date(), new Date(Date.now() + 20_000));
    now += 5_000;
    expect(loader.tokenKeys()).toHaveLength(2);

    // bozuk dosya: son geçerli küme KORUNUR
    fs.writeFileSync(
      keysPath(),
      keyFileJson({ tokenKeys: [{ kid: "0".repeat(16), x: TOKEN_KEY.entry.x }] }),
    );
    fs.utimesSync(keysPath(), new Date(), new Date(Date.now() + 30_000));
    now += 5_000;
    expect(loader.tokenKeys()).toHaveLength(2);
    // dosya silinse de son geçerli küme korunur
    fs.rmSync(keysPath());
    now += 5_000;
    expect(loader.ready()).toBe(true);
    expect(logs.some((l) => l.includes("code=kid_mismatch"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN_KEY.entry.x);
  });
});

describe("yapılandırma ve yardımcılar", () => {
  it("ortam değişkenleri: varsayılanlar ve hatalar", () => {
    const c = loadRelayConfig({ RELAY_PUBLIC_ORIGIN: ORIGIN });
    expect(c).toMatchObject({
      origin: ORIGIN,
      host: "127.0.0.1",
      port: 8787,
      dataDir: "/var/lib/um-relay",
      keysFile: "/etc/um-relay/keys.json",
      maxPending: 100_000,
      sinkTimeoutMs: 10_000,
      rateLimitGet: 60,
      rateLimitPost: 300,
      rateWindowMs: 60_000,
    });
    expect(c.trust.header).toBe("x-real-ip");
    expect(() => loadRelayConfig({})).toThrow(RelayConfigError);
    expect(() => loadRelayConfig({ RELAY_PUBLIC_ORIGIN: "http://x.example.test" })).toThrow(
      RelayConfigError,
    );
    expect(() => loadRelayConfig({ RELAY_PUBLIC_ORIGIN: ORIGIN, RELAY_PORT: "70000" })).toThrow(
      RelayConfigError,
    );
    expect(() => loadRelayConfig({ RELAY_PUBLIC_ORIGIN: ORIGIN, RELAY_PORT: "abc" })).toThrow(
      RelayConfigError,
    );
    expect(() =>
      loadRelayConfig({ RELAY_PUBLIC_ORIGIN: ORIGIN, RELAY_TRUSTED_PROXIES: "bad" }),
    ).toThrow(RelayConfigError);
    expect(() =>
      loadRelayConfig({ RELAY_PUBLIC_ORIGIN: ORIGIN, RELAY_TRUST_PROXY_HEADER: "bad header" }),
    ).toThrow(RelayConfigError);
    expect(routeClass("/u/abc")).toBe("u");
    expect(routeClass("/spool/ack")).toBe("spool");
    expect(routeClass("/healthz")).toBe("healthz");
    expect(routeClass("/x")).toBe("other");
  });

  it("dosya tekrar oynatma kaydı: kalıcı, süresi dolanı açılışta atar, bozuk satırı yok sayar", () => {
    const file = path.join(dir, "replay.log");
    let now = 1_000_000;
    const a = new FileReplayStore({ file, now: () => now });
    a.remember("jtiA", now + 10_000);
    a.remember("jtiB", now + 1_000);
    a.remember("bad jti\n", now + 10_000);
    fs.appendFileSync(file, "garbage-line\n\n");
    expect(a.seen("jtiA")).toBe(true);
    now += 5_000;
    const b = new FileReplayStore({ file, now: () => now });
    expect(b.seen("jtiA")).toBe(true);
    expect(b.seen("jtiB")).toBe(false);
    expect(b.size).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(`jtiA ${1_000_000 + 10_000}\n`);
  });
});

describe("dağıtım paketi (npm run build:relay)", () => {
  it("tek dosyalık paket yalnızca Node yerleşiklerini kullanır, drizzle/libsql içermez ve çalışır", async () => {
    const out = path.join(dir, "bundle");
    await promisify(execFile)(
      process.execPath,
      ["scripts/build-bundles.mjs", "--relay", `--outdir=${out}`],
      { cwd: process.cwd() },
    );
    const bundle = fs.readFileSync(path.join(out, "relay.cjs"), "utf8");
    expect(bundle).not.toMatch(/drizzle|libsql|@\/lib\/db/);
    const requires = new Set([...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]));
    for (const r of requires) expect(r, r).toMatch(/^node:/);

    // paketi gerçek süreç olarak başlat: anahtar yokken /healthz 503
    const child = spawn(process.execPath, [path.join(out, "relay.cjs")], {
      env: {
        PATH: process.env.PATH,
        RELAY_PUBLIC_ORIGIN: ORIGIN,
        RELAY_PORT: "0",
        RELAY_DATA_DIR: path.join(dir, "bdata"),
        RELAY_KEYS_FILE: path.join(dir, "none.json"),
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buf = "";
        child.stdout.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /listening on [^ ]+:(\d+)/.exec(buf);
          if (m) resolve(Number(m[1]));
        });
        child.on("exit", (c) => reject(new Error(`exit ${c}`)));
        setTimeout(() => reject(new Error("timeout")), 10_000);
      });
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  });
});
