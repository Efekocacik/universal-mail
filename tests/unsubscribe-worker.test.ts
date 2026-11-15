import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/client";
import { suppressions } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import {
  ensureChannelKey,
  exportChannelPublicKeys,
  getChannelSigner,
} from "@/lib/unsubscribe/channel";
import {
  isOneClickEndpointVerified,
  setUnsubscribeBaseUrl,
  verifyOneClickEndpoint,
} from "@/lib/unsubscribe/endpoint";
import { drainUnsubscribeEvents } from "@/lib/unsubscribe/ingest";
import {
  buildUnsubscribeUrl,
  ensureSigningKey,
  exportRelayKeySet,
  mintUnsubscribeToken,
} from "@/lib/unsubscribe/keys";
import {
  HttpEventSource,
  signChannelRequest,
  verifyChannelRequest,
} from "@/lib/unsubscribe/channel-protocol";
import { verifyChannelRequestWeb } from "@/lib/unsubscribe/channel-server";
import { isSafeLiveUnsubscribeUrl } from "@/lib/mail/footer";
import type { UnsubscribeEvent } from "@/lib/unsubscribe/relay";
import { SpoolError } from "@/lib/unsubscribe/spool-core";
import {
  SIGN_DOMAIN,
  kidOfPublicKey,
  newClaims,
  signToken,
  verifyToken,
  type PublicKeyEntry,
} from "@/lib/unsubscribe/token";
import { b64urlDecode, b64urlEncode } from "@/lib/unsubscribe/token-core";
import { kidOfPublicKeyWeb, verifyTokenWeb } from "@/lib/unsubscribe/web-crypto";
import { isIPv4Text, isIPv6Text } from "@/relay/common";
import { D1ReplayStore, D1Spool, WORKER_DEFAULT_MAX_PENDING } from "@/relay/d1-spool";
import { KeyFileError, parseKeyFile } from "@/relay/key-file";
import { parseKeySetWeb } from "@/relay/key-set";
import worker, {
  createWorkerApp,
  loadWorkerConfig,
  workerClientKey,
  type WorkerEnv,
} from "@/relay/worker";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { FakeD1 } from "./helpers/fake-d1";
import { NOW, seedSent, type Sent } from "./helpers/inbound-fixture";
import { runSinkContract, type SinkHarness } from "./helpers/sink-contract";

/**
 * Cloudflare Worker çıkış aktarıcısı (src/relay/worker.ts + D1). Worker'ın `fetch` işleyicisi süreç içinde, D1 ise
 * gerçek SQLite üzerindeki taklitle (tests/helpers/fake-d1.ts) çalıştırılır; gerçek Cloudflare hesabına/ağa İSTEK
 * ATILMAZ. Adres yalnızca yer tutucudur (um-relay.hesap.workers.dev).
 */

const ORIGIN = "https://um-relay.hesap.workers.dev";
const TAG = "B".repeat(22);

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { privateKey, entry: { kid: kidOfPublicKey(x), x } as PublicKeyEntry };
}
const TOKEN_KEY = keypair();
const CHANNEL_KEY = keypair();
const STRANGER = keypair();

const mint = (now = Date.now(), over: Partial<Parameters<typeof newClaims>[0]> = {}) =>
  signToken(
    newClaims({
      kid: TOKEN_KEY.entry.kid,
      campaignLeadId: 7,
      messageId: 8,
      recipientTag: TAG,
      now,
      ...over,
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
let d1: FakeD1;
let logs: string[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-cfw-"));
  d1 = await FakeD1.create(dir);
  await d1.applySchema();
  logs = [];
});
afterEach(() => {
  d1.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (over: Partial<WorkerEnv> = {}): WorkerEnv => ({
  DB: d1,
  RELAY_KEYS: keyFileJson(),
  ...over,
});
const appOf = (e: WorkerEnv = env()) =>
  createWorkerApp(e, { log: (l) => logs.push(l), healthCacheMs: 0 });

const FORM = "application/x-www-form-urlencoded";
const post = (token: string, headers: Record<string, string> = {}, base = ORIGIN) =>
  new Request(`${base}/u/${token}`, {
    method: "POST",
    headers: { "Content-Type": FORM, "CF-Connecting-IP": "198.51.100.1", ...headers },
    body: "List-Unsubscribe=One-Click",
  });
const postMultipart = (token: string) => {
  const fd = new FormData();
  fd.set("List-Unsubscribe", "One-Click");
  return new Request(`${ORIGIN}/u/${token}`, { method: "POST", body: fd });
};
const rows = async () =>
  (await d1.client.execute("SELECT id, token, received_at FROM spool_events ORDER BY id")).rows;

/** Uygulamanın gerçek `HttpEventSource`u; ağ yerine Worker'ın `fetch`ine yönlendirilir. */
const sourceFor = (
  handle: (r: Request) => Promise<Response>,
  key = CHANNEL_KEY,
  now?: () => number,
) =>
  new HttpEventSource({
    baseUrl: ORIGIN,
    kid: key.entry.kid,
    privateKey: key.privateKey,
    ...(now ? { now } : {}),
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      handle(new Request(url as string, init))) as typeof fetch,
  });

/* ---------------------------------------------------------------------------------------------- */

describe("WebCrypto doğrulaması = node:crypto doğrulaması (karşılaştırmalı)", () => {
  /** Anahtarla imzalı ama keyfi yük (kanonik olmayan/kural dışı) belirteç. */
  const signRaw = (text: string, key = TOKEN_KEY) => {
    const pl = Buffer.from(text, "utf8").toString("base64url");
    const sig = crypto.sign(null, Buffer.from(`${SIGN_DOMAIN}${pl}`, "utf8"), key.privateKey);
    return `u2.${pl}.${sig.toString("base64url")}`;
  };
  const claimsText = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...newClaims({
        kid: TOKEN_KEY.entry.kid,
        campaignLeadId: 7,
        messageId: null,
        recipientTag: TAG,
        now: NOW,
      }),
      ...over,
    });

  it("geçerli, süresi dolmuş, erken, kurcalanmış, bilinmeyen anahtar, bozuk biçim: sonuçlar birebir aynı", async () => {
    const good = mint(NOW);
    const [p, pl, sg] = good.split(".") as [string, string, string];
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const lastBits = (s: string) => s.slice(0, -1) + (s.at(-1) === "w" ? "x" : "w");
    const plBytes = Buffer.from(pl, "base64url");
    const vectors: unknown[] = [
      good,
      mint(NOW, { scope: "p" }),
      `${p}.${flip(pl, 5)}.${sg}`,
      `${p}.${pl}.${flip(sg, 10)}`,
      `${p}.${pl}.${mint(NOW).split(".")[2]}`,
      `${p}.${pl}.${lastBits(sg)}`,
      `${p}.${lastBits(pl)}.${sg}`,
      `u1.${pl}.${sg}`,
      `${p}.${pl}`,
      `${p}.${pl}.${sg}.x`,
      `${p}..${sg}`,
      `${p}.${pl}.${sg.slice(0, 85)}`,
      `${p}.${pl}.${sg}A`,
      `${p}.${pl}+.${sg}`,
      "u2." + "a".repeat(700),
      "",
      42,
      null,
      `${p}.${Buffer.from("not json").toString("base64url")}.${sg}`,
      `${p}.${Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plBytes]).toString("base64url")}.${sg}`,
      `${p}.${Buffer.from([0xff, 0xfe, 0x7b]).toString("base64url")}.${sg}`,
      signRaw(claimsText()),
      signRaw(claimsText({ extra: 1 })),
      signRaw(claimsText().replace(/\{"v":2,"k"/, '{"k"')),
      signRaw(claimsText({ e: Math.floor(NOW / 1000) - 10 })),
      signRaw(claimsText({ e: Math.floor(NOW / 1000) + 500 * 86_400 })),
      signRaw(claimsText({ s: "x" })),
      signRaw(claimsText({ k: "zz" })),
      signRaw(claimsText(), STRANGER),
      `${p}.${pl}.${crypto.sign(null, Buffer.from(pl), TOKEN_KEY.privateKey).toString("base64url")}`,
    ];
    const keySets: PublicKeyEntry[][] = [
      [TOKEN_KEY.entry],
      [],
      [STRANGER.entry],
      [{ kid: TOKEN_KEY.entry.kid, x: STRANGER.entry.x }],
      [{ kid: TOKEN_KEY.entry.kid, x: "short" }],
      [STRANGER.entry, TOKEN_KEY.entry],
    ];
    const times = [NOW + 1000, NOW - 2 * 3_600_000, NOW + 181 * 86_400_000, NOW + 3_000_000];
    let compared = 0;
    for (const t of vectors) {
      for (const keys of keySets) {
        for (const now of times) {
          const a = verifyToken(t, keys, now);
          const b = await verifyTokenWeb(t, keys, now);
          expect(b, `${String(t).slice(0, 40)} @${now}`).toEqual(a);
          compared++;
        }
      }
    }
    expect(compared).toBe(vectors.length * keySets.length * times.length);
    // Kapsam: en az bir geçerli, bir süresi dolmuş, bir imza hatası sonucu karşılaştırıldı.
    expect((await verifyTokenWeb(good, [TOKEN_KEY.entry], NOW + 1000)).ok).toBe(true);
    expect(await verifyTokenWeb(good, [TOKEN_KEY.entry], NOW + 181 * 86_400_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("base64url ve anahtar kimliği: Buffer/node:crypto ile aynı", async () => {
    for (let n = 0; n < 70; n++) {
      const b = crypto.randomBytes(n);
      const s = b.toString("base64url");
      expect(b64urlEncode(b)).toBe(s);
      expect(Buffer.from(b64urlDecode(s)!).equals(b)).toBe(true);
    }
    expect(b64urlDecode("abcde")).toBeNull();
    expect(b64urlDecode("ab+c")).toBeNull();
    for (const k of [TOKEN_KEY, CHANNEL_KEY, STRANGER]) {
      expect(await kidOfPublicKeyWeb(k.entry.x)).toBe(kidOfPublicKey(k.entry.x));
    }
    expect(await kidOfPublicKeyWeb("!!")).toBe("");
  });

  it("kanal imzası: WebCrypto doğrulayıcısı node:crypto ile aynı kararı verir", async () => {
    const at = Date.now();
    const signed = (key = CHANNEL_KEY, method = "GET", p = "/spool/events?limit=5", body = "") =>
      new Headers(signChannelRequest(key.entry.kid, key.privateKey, method, p, body, at));
    const base = { method: "GET", pathWithQuery: "/spool/events?limit=5", body: "" };
    const h = signed();
    const lastBits = (s: string) => s.slice(0, -1) + (s.at(-1) === "w" ? "x" : "w");
    const variants: { req: typeof base & { headers: Headers }; now: number }[] = [
      { req: { ...base, headers: h }, now: at },
      { req: { ...base, method: "POST", headers: h }, now: at },
      { req: { ...base, pathWithQuery: "/spool/events?limit=6", headers: h }, now: at },
      { req: { ...base, body: "x", headers: h }, now: at },
      { req: { ...base, headers: h }, now: at + 6 * 60_000 },
      { req: { ...base, headers: signed(STRANGER) }, now: at },
      { req: { ...base, headers: new Headers() }, now: at },
      {
        req: {
          ...base,
          headers: new Headers({
            ...Object.fromEntries(h),
            "x-um-sig": lastBits(h.get("x-um-sig")!),
          }),
        },
        now: at,
      },
      {
        req: {
          method: "POST",
          pathWithQuery: "/spool/ack",
          body: '{"ids":["çağ"]}',
          headers: signed(CHANNEL_KEY, "POST", "/spool/ack", '{"ids":["çağ"]}'),
        },
        now: at,
      },
    ];
    const keySets: PublicKeyEntry[][] = [
      [CHANNEL_KEY.entry],
      [STRANGER.entry],
      [{ kid: CHANNEL_KEY.entry.kid, x: STRANGER.entry.x }],
      [],
    ];
    for (const v of variants) {
      for (const keys of keySets) {
        const a = verifyChannelRequest(v.req, keys, v.now);
        expect(await verifyChannelRequestWeb(v.req, keys, v.now)).toBe(a);
      }
    }
    expect(await verifyChannelRequestWeb(variants[0]!.req, [CHANNEL_KEY.entry], at)).toBe(true);
  });

  it("anahtar kümesi: WebCrypto ayrıştırıcısı dosya ayrıştırıcısıyla aynı hata kodlarını verir", async () => {
    const code = (f: () => unknown) => {
      try {
        f();
        return "ok";
      } catch (e) {
        return (e as KeyFileError).code;
      }
    };
    const codeAsync = async (p: Promise<unknown>) => {
      try {
        await p;
        return "ok";
      } catch (e) {
        return (e as KeyFileError).code;
      }
    };
    const wrongKid = { kid: STRANGER.entry.kid, x: TOKEN_KEY.entry.x };
    const files = [
      keyFileJson(),
      keyFileJson({ origin: `${ORIGIN}/` }),
      keyFileJson({ tokenKeys: [wrongKid] }),
      keyFileJson({ channelKeys: [CHANNEL_KEY.entry, wrongKid] }),
      keyFileJson({ tokenKeys: [wrongKid], channelKeys: "x" }),
      keyFileJson({ origin: "https://baska.example.com" }),
      keyFileJson({ origin: "http://um-relay.hesap.workers.dev" }),
      keyFileJson({ tokenKeys: [{ kid: "ABC", x: TOKEN_KEY.entry.x }] }),
      keyFileJson({ tokenKeys: [TOKEN_KEY.entry, TOKEN_KEY.entry] }),
      keyFileJson({ tokenKeys: Array(51).fill(TOKEN_KEY.entry) }),
      keyFileJson({ v: 2 }),
      keyFileJson({ pad: "a".repeat(70_000) }),
      "{nope",
      "[]",
    ];
    for (const f of files) {
      expect(await codeAsync(parseKeySetWeb(f, ORIGIN)), f.slice(0, 60)).toBe(
        code(() => parseKeyFile(f, ORIGIN)),
      );
    }
    expect(await parseKeySetWeb(keyFileJson(), ORIGIN)).toMatchObject({
      tokenKeys: [TOKEN_KEY.entry],
      channelKeys: [CHANNEL_KEY.entry],
    });
  });

  it("IP denetimleri: node:net ile aynı (bölge kimliği hariç)", () => {
    for (const s of [
      "::1",
      "::",
      "2001:db8::1",
      "::ffff:1.2.3.4",
      "64:ff9b::192.0.2.1",
      "1:2:3:4:5:6:7:8",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "12345::1",
      "g::1",
      ":1",
      "1:",
      "1.2.3.4",
      "",
      "::ffff:256.1.1.1",
      "1:2:3:4:5:6:1.2.3.4",
      "::ffff:01.2.3.4",
      "[::1]",
      "::1]:80/x",
    ]) {
      expect(isIPv6Text(s), s).toBe(net.isIPv6(s));
    }
    expect(isIPv6Text("fe80::1%eth0")).toBe(false);
    for (const s of ["1.2.3.4", "255.255.255.255", "256.1.1.1", "01.2.3.4", "1.2.3", "a.b.c.d"]) {
      expect(isIPv4Text(s), s).toBe(net.isIPv4(s));
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */

runSinkContract("D1Spool (SQLite üzerinde D1 taklidi)", async (): Promise<SinkHarness> => {
  let db = await d1.reopen();
  const make = () => {
    const spool = new D1Spool({ db });
    return { sink: spool, source: spool };
  };
  const first = make();
  return {
    ...first,
    restart: async () => {
      db.close();
      db = await d1.reopen();
      return make();
    },
    injectWriteFailure: (on) => {
      d1.failWrites = on;
      db.failWrites = on;
    },
  };
});

describe("D1Spool: FileSpool ile aynı anlam", () => {
  const ev = (token: string, receivedAt = 1_700_000_000_000): UnsubscribeEvent => ({
    v: 1,
    token,
    receivedAt,
    via: "one_click",
  });

  it("kuyruk sınırı dolunca queue_full (olay atılmaz); aynı olay idempotent; sıra ve onay", async () => {
    let clock = 1_700_000_000_000;
    const s = new D1Spool({ db: d1, maxPending: 2, now: () => clock });
    const r1 = await s.push(ev("t1"));
    clock += 5;
    const r2 = await s.push(ev("t2"));
    expect(r1.id < r2.id).toBe(true);
    // aynı olay: yeni satır yok, aynı makbuz (kuyruk dolu olsa bile — olay zaten kayıtlı)
    expect(await s.push(ev("t1"))).toEqual(r1);
    await expect(s.push(ev("t3"))).rejects.toMatchObject({ code: "queue_full" });
    await expect(s.push({ ...ev("t4"), extra: 1 } as never)).rejects.toBeInstanceOf(SpoolError);
    expect(await rows()).toHaveLength(2);
    // farklı an = farklı olay (yetkili tekilleştirme uygulamada)
    await s.ack([r1.id]);
    clock += 5; // farklı milisaniye öneki: sıra rastgele sonekten bağımsız (aksi halde test kararsız)
    const r3 = await s.push(ev("t2", 1_700_000_000_001));
    expect((await s.pull(10)).map((p) => p.id)).toEqual([r2.id, r3.id]);
    // ack: yalnızca listelenen; geçersiz kimlik yok sayılır
    await s.ack(["../x", "bilinmeyen", r2.id, r2.id]);
    expect((await s.pull(10)).map((p) => p.id)).toEqual([r3.id]);
    await s.ack([]);
    expect(await s.stats()).toMatchObject({ depth: 1, corrupt: 0 });
    expect(WORKER_DEFAULT_MAX_PENDING).toBe(10_000);
  });

  it("şema kısıtı ihlali (CHECK) sessizce yutulmaz: write_failed (queue_full DEĞİL), satır yok", async () => {
    // Doğrulayıcı ile şema ayrışırsa (burada: kimlik uzunluğu 30 değil) INSERT OR IGNORE ihlali yutup "kuyruk dolu"
    // derdi; ON CONFLICT yalnızca (token, received_at) çakışmasını yok sayar.
    const s = new D1Spool({ db: d1, randomHex16: () => "abc" });
    await expect(s.push(ev("t1"))).rejects.toMatchObject({ code: "write_failed" });
    expect(await rows()).toHaveLength(0);
    expect(await s.stats()).toMatchObject({ depth: 0 });
  });

  it("kuyruk derinliği sayaç satırından: push/stats COUNT(*) ile tabloyu taramaz; elle silme/ekleme sayacı bozmaz", async () => {
    let clock = 1_700_000_000_000;
    const s = new D1Spool({ db: d1, maxPending: 3, now: () => clock });
    const before = d1.queries.length;
    const a = await s.push(ev("a"));
    clock += 1;
    await s.push(ev("b"));
    expect(await s.stats()).toMatchObject({ depth: 2 });
    const sql = d1.queries.slice(before).join("\n");
    expect(sql).not.toMatch(/COUNT\(\*\)\s+FROM\s+spool_events/i);
    expect(sql).toMatch(/spool_meta/);
    // konsoldan elle silme ve ekleme: tetikleyiciler sayacı günceller
    await d1.client.execute({ sql: "DELETE FROM spool_events WHERE id = ?", args: [a.id] });
    expect(await s.stats()).toMatchObject({ depth: 1 });
    clock += 1;
    await s.push(ev("c"));
    clock += 1;
    await s.push(ev("d"));
    await expect(s.push(ev("e"))).rejects.toMatchObject({ code: "queue_full" });
    expect(await rows()).toHaveLength(3);
    const meta = await d1.client.execute("SELECT depth FROM spool_meta WHERE k = 1");
    expect(Number(meta.rows[0]!.depth)).toBe(3);
    // şemayı yeniden çalıştırmak sayacı sıfırlamaz/çiftlemez
    await d1.applySchema();
    expect(await s.stats()).toMatchObject({ depth: 3 });
  });

  it("sayaç satırı silinmişse sağlık false (sessiz queue_full yerine /healthz 503); şema yeniden çalışınca düzelir", async () => {
    let clock = 1_700_000_000_000;
    const s = new D1Spool({ db: d1, now: () => clock });
    await s.push(ev("a"));
    await d1.client.execute("DELETE FROM spool_meta");
    expect(await s.reachable()).toBe(false);
    expect((await appOf().handle(new Request(`${ORIGIN}/healthz`))).status).toBe(503);
    clock += 1;
    await expect(s.push(ev("b"))).rejects.toMatchObject({ code: "queue_full" });
    await d1.applySchema(); // satır mevcut kayıt sayısıyla geri gelir
    expect(await s.reachable()).toBe(true);
    expect(await s.stats()).toMatchObject({ depth: 1 });
    await s.push(ev("b"));
    expect(await s.stats()).toMatchObject({ depth: 2 });
  });

  it("çok sayıda kimlik tek işlemde onaylanır (D1 parametre sınırı parçalanır); istatistik yaşı", async () => {
    let clock = 1_700_000_000_000;
    const s = new D1Spool({ db: d1, now: () => clock });
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) ids.push((await s.push(ev(`tok${i}`, clock + i))).id);
    clock += 60_000;
    expect(await s.stats()).toEqual({ depth: 205, oldestAgeMs: 60_000, corrupt: 0 });
    expect(await s.pull(1_000)).toHaveLength(205);
    expect(await s.pull(0)).toHaveLength(1);
    await s.ack(ids.slice(0, 200));
    expect((await s.stats()).depth).toBe(5);
    await s.ack(ids);
    expect(await s.stats()).toEqual({ depth: 0, oldestAgeMs: null, corrupt: 0 });
  });

  it("bozuk satır SİLİNMEZ: karantinaya taşınır ve sayılır; kuyruğu tıkamaz", async () => {
    const s = new D1Spool({ db: d1, now: () => 1_700_000_000_500 });
    const good = await s.push(ev("iyi", 1_700_000_000_100));
    await d1.client.execute({
      sql: "INSERT INTO spool_events (id, token, received_at, created_at) VALUES (?, ?, ?, ?)",
      args: ["1600000000000-aaaaaaaaaaaaaaaa", "bozuk", 1.5, 1],
    });
    const pulled = await s.pull(10);
    expect(pulled.map((p) => p.id)).toEqual([good.id]);
    expect(await s.stats()).toMatchObject({ depth: 1, corrupt: 1 });
    const q = await d1.client.execute("SELECT id, token FROM spool_corrupt");
    expect(q.rows[0]).toMatchObject({ id: "1600000000000-aaaaaaaaaaaaaaaa", token: "bozuk" });
  });

  it("yazma/okuma hatası: push write_failed (makbuz YOK); sağlık false", async () => {
    const s = new D1Spool({ db: d1 });
    expect(await s.reachable()).toBe(true);
    d1.failWrites = true;
    await expect(s.push(ev("x"))).rejects.toMatchObject({ code: "write_failed" });
    d1.failWrites = false;
    d1.failAll = true;
    await expect(s.push(ev("x"))).rejects.toMatchObject({ code: "write_failed" });
    expect(await s.reachable()).toBe(false);
    await expect(s.pull(5)).rejects.toBeDefined();
    await expect(s.stats()).rejects.toBeDefined();
    d1.failAll = false;
    expect(await rows()).toHaveLength(0);
  });

  it("şema uygulanmamışsa sağlık false", async () => {
    const empty = await FakeD1.create(fs.mkdtempSync(path.join(dir, "e-")));
    try {
      expect(await new D1Spool({ db: empty }).reachable()).toBe(false);
    } finally {
      empty.close();
    }
  });

  it("D1ReplayStore: ortak, süreli, geçersiz jti yok sayılır, süresi dolanlar temizlenir", async () => {
    let clock = 1_000_000;
    const a = new D1ReplayStore(d1, () => clock);
    const b = new D1ReplayStore(await d1.reopen(), () => clock); // başka isolate
    await a.remember("jtiA", clock + 10_000);
    await a.remember("jtiB", clock + 1_000);
    await a.remember("bad jti", clock + 10_000);
    await a.remember("jtiC", Number.NaN);
    expect(await b.seen("jtiA")).toBe(true);
    expect(await b.seen("bad jti")).toBe(false);
    clock += 5_000;
    expect(await b.seen("jtiB")).toBe(false);
    await a.remember("jtiA", clock + 20_000); // güncelleme + temizlik
    const left = await d1.client.execute("SELECT jti FROM replay_jti ORDER BY jti");
    expect(left.rows.map((r) => r.jti)).toEqual(["jtiA"]);
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe("Worker fetch işleyicisi: uçtan uca", () => {
  it("/healthz: anahtar yok → 503; şema yok → 503; kanal anahtarı yok → 503; D1 erişilemez → 503; hazır → 200", async () => {
    const health = async (e: WorkerEnv) => {
      const r = await appOf(e).handle(new Request(`${ORIGIN}/healthz`));
      return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
    };
    expect(await health(env({ RELAY_KEYS: undefined }))).toMatchObject({
      status: 503,
      body: { ok: false },
    });
    expect(await health(env({ RELAY_KEYS: keyFileJson({ channelKeys: [] }) }))).toMatchObject({
      status: 503,
    });
    expect(await health(env({ RELAY_KEYS: "{bozuk" }))).toMatchObject({ status: 503 });
    expect(await health(env({ DB: undefined }))).toMatchObject({ status: 503 });
    const empty = await FakeD1.create(fs.mkdtempSync(path.join(dir, "e-")));
    try {
      expect(await health(env({ DB: empty }))).toMatchObject({ status: 503 });
    } finally {
      empty.close();
    }
    expect(await health(env())).toEqual({ status: 200, body: { ok: true }, cache: "no-store" });

    const app = appOf();
    d1.failAll = true;
    expect((await app.handle(new Request(`${ORIGIN}/healthz`))).status).toBe(503);
    d1.failAll = false;
    expect((await app.handle(new Request(`${ORIGIN}/healthz`))).status).toBe(200);
    const head = await app.handle(new Request(`${ORIGIN}/healthz`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await app.handle(new Request(`${ORIGIN}/healthz`, { method: "POST" }))).status).toBe(
      405,
    );
    // yanıt yalnızca {ok}: sayı/derinlik/anahtar açığa verilmez
    expect(logs.join("\n")).not.toContain(TOKEN_KEY.entry.x);
  });

  it("D1 sağlık sonucu kısa süre önbelleğe alınır (her /healthz veritabanı okumaz)", async () => {
    let clock = 1_000_000;
    const app = createWorkerApp(env(), { log: () => undefined, now: () => clock });
    await app.handle(new Request(`${ORIGIN}/healthz`));
    const n = d1.queries.length;
    await app.handle(new Request(`${ORIGIN}/healthz`));
    expect(d1.queries.length).toBe(n);
    clock += 10_001;
    await app.handle(new Request(`${ORIGIN}/healthz`));
    expect(d1.queries.length).toBeGreaterThan(n);
  });

  it("POST urlencoded ve multipart → 200 YALNIZCA D1'e yazıldıktan sonra; GET/HEAD veritabanına dokunmaz", async () => {
    const app = appOf();
    const t1 = mint();
    const t2 = mint();
    const g = await app.handle(new Request(`${ORIGIN}/u/${t1}`));
    expect(g.status).toBe(200);
    expect(await g.text()).toContain('method="post"');
    const h = await app.handle(new Request(`${ORIGIN}/u/${t1}`, { method: "HEAD" }));
    expect(h.status).toBe(200);
    expect(await h.text()).toBe("");
    expect(d1.queries.filter((q) => /spool_events|replay_jti/.test(q))).toHaveLength(0);

    const r1 = await app.handle(post(t1));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("location")).toBeNull();
    // 200 anında olay KALICI: başka bir bağlantıdan (yeni isolate) okunabilir
    const other = await d1.reopen();
    try {
      const seen = await other.client.execute("SELECT token FROM spool_events");
      expect(seen.rows.map((r) => r.token)).toEqual([t1]);
    } finally {
      other.close();
    }
    expect((await app.handle(postMultipart(t2))).status).toBe(200);
    expect((await rows()).map((r) => r.token).sort()).toEqual([t1, t2].sort());
  });

  it("D1 yazılamazsa 503 + Retry-After (200 DEĞİL) ve olay yok; düzelince aynı istek 200", async () => {
    const app = appOf();
    const t = mint();
    d1.failWrites = true;
    const bad = await app.handle(post(t));
    expect(bad.status).toBe(503);
    expect(bad.headers.get("retry-after")).toBe("60");
    d1.failWrites = false;
    expect(await rows()).toHaveLength(0);
    expect((await app.handle(post(t))).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("eşzamanlı aynı belirteç: istekler söz PAYLAŞMAZ (her biri kendi yazımını yapar), hepsi 200, tek satır", async () => {
    // Workers'ta bir isteğin G/Ç'si o isteğe aittir; birleştirme olsaydı iptal edilen ilk isteği bekleyen ikincisi
    // hiç yanıt üretemezdi. D1'in benzersiz dizini (aynı alınma anı) yinelenen satırı önler.
    const t = mint();
    const fixed = Date.now();
    const app = createWorkerApp(env(), {
      log: () => undefined,
      now: () => fixed,
      healthCacheMs: 0,
    });
    d1.beforeQuery = async (sql) => {
      if (/INSERT INTO spool_events/.test(sql)) await new Promise((r) => setTimeout(r, 30));
    };
    const res = await Promise.all(Array.from({ length: 4 }, () => app.handle(post(t))));
    d1.beforeQuery = null;
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(d1.queries.filter((q) => /INSERT INTO spool_events/.test(q))).toHaveLength(4);
    expect(await rows()).toHaveLength(1);
  });

  it("tekrar oynatma: aynı belirteç tekrar → 200, yeni olay YOK; başka isolate da (D1 ortak kayıt) görür", async () => {
    const t = mint();
    expect((await appOf().handle(post(t))).status).toBe(200);
    expect((await appOf().handle(post(t))).status).toBe(200);
    const db2 = await d1.reopen();
    try {
      expect((await appOf(env({ DB: db2 })).handle(post(t))).status).toBe(200);
    } finally {
      db2.close();
    }
    expect(await rows()).toHaveLength(1);
  });

  it("kuyruk sınırı (RELAY_MAX_PENDING): dolunca yeni çıkış 503, olay atılmaz", async () => {
    const app = appOf(env({ RELAY_MAX_PENDING: "1" }));
    expect((await app.handle(post(mint()))).status).toBe(200);
    const full = await app.handle(post(mint()));
    expect(full.status).toBe(503);
    expect(await rows()).toHaveLength(1);
  });

  it("geçersiz/süresi dolmuş belirteç, yanlış içerik türü, büyük gövde: 400/410/415/413 ve D1'e yazım yok", async () => {
    const app = appOf();
    expect((await app.handle(post("u2.a.b"))).status).toBe(400);
    expect((await app.handle(post(mint(Date.now() - 200 * 86_400_000)))).status).toBe(410);
    expect((await app.handle(new Request(`${ORIGIN}/u/u2.a.b`))).status).toBe(400);
    const json = await app.handle(
      new Request(`${ORIGIN}/u/${mint()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(json.status).toBe(415);
    const big = await app.handle(
      new Request(`${ORIGIN}/u/${mint()}`, {
        method: "POST",
        headers: { "Content-Type": FORM },
        body: `List-Unsubscribe=One-Click&pad=${"a".repeat(2_000)}`,
      }),
    );
    expect(big.status).toBe(413);
    expect((await app.handle(new Request(`${ORIGIN}/u/${mint()}`, { method: "PUT" }))).status).toBe(
      405,
    );
    expect(d1.queries.filter((q) => /INSERT/i.test(q))).toHaveLength(0);
  });

  it("bilinmeyen yollar 404", async () => {
    const app = appOf();
    for (const p of ["/", "/u", "/spool/other", "/spool", "/favicon.ico", "/healthz/x", "/U/x"]) {
      expect((await app.handle(new Request(`${ORIGIN}${p}`))).status, p).toBe(404);
    }
  });

  it("imzalı kanal: uygulamanın HttpEventSource'u çeker → onaylar; imzasız/yabancı/eski istek 401", async () => {
    const app = appOf();
    const handle = (r: Request) => app.handle(r);
    const t1 = mint();
    expect((await app.handle(post(t1))).status).toBe(200);
    expect((await app.handle(post(mint(), { "CF-Connecting-IP": "198.51.100.2" }))).status).toBe(
      200,
    );
    const src = sourceFor(handle);
    expect((await src.getStats()).depth).toBe(2);
    const events = await src.pull(10);
    expect(events).toHaveLength(2);
    expect(events.find((e) => (e.event as UnsubscribeEvent).token === t1)!.event).toEqual({
      v: 1,
      token: t1,
      receivedAt: expect.any(Number),
      via: "one_click",
    });
    expect(events.map((e) => (e.event as UnsubscribeEvent).token)).toContain(t1);
    // pull tüketmez
    expect(await src.pull(10)).toHaveLength(2);
    await src.ack(events.map((e) => e.id));
    expect(await src.getStats()).toEqual({ depth: 0, oldestAgeMs: null, corrupt: 0 });

    expect((await app.handle(new Request(`${ORIGIN}/spool/stats`))).status).toBe(401);
    await expect(sourceFor(handle, STRANGER).pull(10)).rejects.toMatchObject({
      code: "http_error",
      status: 401,
    });
    await expect(sourceFor(handle, TOKEN_KEY).getStats()).rejects.toMatchObject({ status: 401 });
    // 5 dakikadan eski imza (yeniden oynatılan istek) reddedilir
    await expect(
      sourceFor(handle, CHANNEL_KEY, () => Date.now() - 6 * 60_000).getStats(),
    ).rejects.toMatchObject({ status: 401 });
    // aşırı büyük onay gövdesi kimlik doğrulamadan önce 413
    const huge = await app.handle(
      new Request(`${ORIGIN}/spool/ack`, {
        method: "POST",
        body: JSON.stringify({ ids: [], pad: "a".repeat(70_000) }),
      }),
    );
    expect(huge.status).toBe(413);
  });

  it("hız sınırı YALNIZCA CF-Connecting-IP ile: X-Forwarded-For yeni kova açmaz; IPv6 /64 tek kova", async () => {
    const app = appOf(env({ RELAY_RATE_LIMIT_POST: "1", RELAY_RATE_LIMIT_GET: "1" }));
    expect((await app.handle(post(mint(), { "CF-Connecting-IP": "203.0.113.1" }))).status).toBe(
      200,
    );
    expect((await app.handle(post(mint(), { "CF-Connecting-IP": "203.0.113.2" }))).status).toBe(
      200,
    );
    const limited = await app.handle(post(mint(), { "CF-Connecting-IP": "203.0.113.1" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // CF başlığı yok: X-Forwarded-For / X-Real-IP / x-um-client yok sayılır → ortak "unknown" kovası
    const noCf = (xff: string) =>
      new Request(`${ORIGIN}/u/${mint()}`, {
        method: "POST",
        headers: {
          "Content-Type": FORM,
          "X-Forwarded-For": xff,
          "X-Real-IP": xff,
          "X-UM-Client": xff,
        },
        body: "List-Unsubscribe=One-Click",
      });
    expect((await app.handle(noCf("192.0.2.1"))).status).toBe(200);
    expect((await app.handle(noCf("192.0.2.2"))).status).toBe(429);
    // IPv6: aynı /64 içindeki adres döndürme sınırı atlatamaz
    const v6 = (ip: string) => app.handle(post(mint(), { "CF-Connecting-IP": ip }));
    expect((await v6("2001:db8:1:2::1")).status).toBe(200);
    expect((await v6("2001:db8:1:2:ffff::9")).status).toBe(429);
    // GET kovası ayrıdır
    const get = (ip: string) =>
      app.handle(new Request(`${ORIGIN}/u/${mint()}`, { headers: { "CF-Connecting-IP": ip } }));
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.1")).status).toBe(429);

    const key = (h: Record<string, string>, method = "POST") =>
      workerClientKey(new Request(`${ORIGIN}/u/x`, { method, headers: h }));
    expect(key({ "CF-Connecting-IP": " 198.51.100.7 " })).toBe("POST:198.51.100.7");
    expect(key({ "CF-Connecting-IP": "not-an-ip" })).toBe("POST:unknown");
    expect(key({ "CF-Connecting-IP": "2001:DB8:1:2:aaaa::1" }, "GET")).toBe(
      "GET:2001:db8:1:2::/64",
    );
    expect(key({ "X-Forwarded-For": "1.2.3.4" })).toBe("POST:unknown");
  });

  it("günlük: yöntem, yol sınıfı ve durum; belirteç, yol ve anahtar ASLA yazılmaz", async () => {
    const app = appOf();
    const t = mint();
    await app.handle(post(t));
    await app.handle(new Request(`${ORIGIN}/u/${t}`));
    await app.handle(new Request(`${ORIGIN}/spool/stats`));
    await app.handle(new Request(`${ORIGIN}/secret-path-xyz`));
    const reqLines = logs.filter((l) => / (GET|POST|HEAD) /.test(l));
    expect(reqLines).toHaveLength(4);
    expect(reqLines[0]).toMatch(/ POST u 200 \d+ms$/);
    expect(reqLines[2]).toMatch(/ GET spool 401 \d+ms$/);
    expect(reqLines[3]).toMatch(/ GET other 404 \d+ms$/);
    expect(logs).toContain("keys loaded token=1 channel=1");
    const all = logs.join("\n");
    expect(all).not.toContain(t);
    expect(all).not.toContain(t.slice(3, 40));
    expect(all).not.toContain("/u/");
    expect(all).not.toContain("secret-path-xyz");
    expect(all).not.toContain(TOKEN_KEY.entry.x);
    expect(all).not.toContain(CHANNEL_KEY.entry.x);
  });

  it("köken: anahtar dosyası başka adrese aitse 503 (yalnızca hata kodu günlüğe); http istek kökeni kabul edilmez", async () => {
    const app = appOf(env({ RELAY_KEYS: keyFileJson({ origin: "https://baska.example.com" }) }));
    expect((await app.handle(post(mint()))).status).toBe(503);
    expect((await app.handle(new Request(`${ORIGIN}/healthz`))).status).toBe(503);
    expect(logs).toContain("keys rejected code=origin_mismatch");
    expect(logs.join("\n")).not.toContain("baska.example.com");

    // RELAY_PUBLIC_ORIGIN: istek başka bir ana makineden gelse de anahtarlar bu kökene göre denetlenir
    const fixed = appOf(env({ RELAY_PUBLIC_ORIGIN: `${ORIGIN}/` }));
    expect((await fixed.handle(post(mint(), {}, "https://cikis.example.com"))).status).toBe(200);
    // sabit köken yoksa: http (ör. yerel deneme) kökeni kabul edilmez
    expect((await appOf().handle(post(mint(), {}, "http://127.0.0.1:8787"))).status).toBe(503);
  });

  it("yapılandırma hatası: tüm uçlar 503, sağlık 503; günlükte yalnızca değişken adı", async () => {
    for (const bad of [
      { RELAY_MAX_PENDING: "abc" },
      { RELAY_RATE_LIMIT_POST: "0" },
      { RELAY_PUBLIC_ORIGIN: "http://um-relay.hesap.workers.dev" },
    ]) {
      logs = [];
      const app = appOf(env(bad));
      expect((await app.handle(post(mint()))).status).toBe(503);
      expect((await app.handle(new Request(`${ORIGIN}/healthz`))).status).toBe(503);
      expect(logs.some((l) => l.startsWith("config rejected:"))).toBe(true);
    }
    expect(loadWorkerConfig({})).toEqual({
      origin: null,
      maxPending: 10_000,
      sinkTimeoutMs: 10_000,
      rateLimitGet: 60,
      rateLimitPost: 300,
      rateWindowMs: 60_000,
    });
    logs = [];
    const noDb = appOf(env({ DB: undefined }));
    expect((await noDb.handle(post(mint()))).status).toBe(503);
    expect(logs).toContain("D1 binding DB missing");
  });

  it("varsayılan dışa aktarım (Cloudflare `fetch(req, env, ctx)`): isolate başına tek örnek, ortam değişince yenilenir", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const e = env({ RELAY_RATE_LIMIT_POST: "1" });
      expect((await worker.fetch(post(mint()), e, {})).status).toBe(200);
      // aynı ortam → aynı örnek → hız sınırı sayacı korunur
      expect((await worker.fetch(post(mint()), { ...e }, {})).status).toBe(429);
      // yeni gizli değer (yeni dağıtım) → yeni örnek
      const e2 = env({ RELAY_RATE_LIMIT_POST: "2" });
      expect((await worker.fetch(post(mint()), e2, {})).status).toBe(200);
      expect((await worker.fetch(new Request(`${ORIGIN}/healthz`), e2)).status).toBe(200);
      expect(spy.mock.calls.flat().join("\n")).not.toContain("/u/");
    } finally {
      spy.mockRestore();
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe("uygulama uyumu: *.workers.dev adresi", () => {
  it("canlı çıkış bağlantısı için güvenli sayılır (https, port yok)", () => {
    expect(isSafeLiveUnsubscribeUrl(ORIGIN)).toBe(true);
    expect(isSafeLiveUnsubscribeUrl(`${ORIGIN}/u/x`)).toBe(true);
    expect(isSafeLiveUnsubscribeUrl("http://um-relay.hesap.workers.dev")).toBe(false);
    expect(isSafeLiveUnsubscribeUrl("https://um-relay.hesap.workers.dev:8443")).toBe(false);
  });

  describe("gerçek uygulama akışı Worker'a karşı (ağ yok)", () => {
    let client: Client;
    let db: Db;
    let clock: number;
    let a: Sent;
    let globalFetch: ReturnType<typeof vi.spyOn>;
    const saved: Record<string, string | undefined> = {};

    beforeEach(async () => {
      for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
      process.env.UM_DATA_DIR = path.join(dir, "app");
      fs.mkdirSync(process.env.UM_DATA_DIR, { recursive: true });
      process.env.UM_MASTER_KEY = "ab".repeat(32);
      ({ client, db } = await openMemoryDb());
      await seedBase(db);
      clock = NOW;
      a = await seedSent(db, await createCampaign(db, { status: "running" }), {
        email: "kisi@alici-ornek.com",
      });
      await ensureSigningKey(db, clock);
      await ensureChannelKey(db, clock);
      globalFetch = vi.spyOn(globalThis, "fetch");
    });
    afterEach(() => {
      expect(globalFetch).not.toHaveBeenCalled(); // gerçek ağ isteği YOK
      globalFetch.mockRestore();
      client.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("adres kaydedilir → anahtar dosyası Worker'a → uçtan uca doğrulama → gerçek çıkış çekilip işlenir", async () => {
      await setUnsubscribeBaseUrl(db, `${ORIGIN}/`, clock);
      const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
      expect(cfg.baseUrl).toBe(ORIGIN);
      // uygulamanın "Anahtar dosyasını indir" yanıtıyla aynı içerik (relay-keys route)
      const relayKeys = JSON.stringify({
        v: 1,
        origin: new URL(cfg.baseUrl!).origin,
        tokenKeys: (await exportRelayKeySet(db)).keys,
        channelKeys: await exportChannelPublicKeys(db),
        generatedAt: clock,
      });
      const app = createWorkerApp(
        { DB: d1, RELAY_KEYS: relayKeys },
        { now: () => clock, log: () => undefined, healthCacheMs: 0 },
      );
      expect((await app.handle(new Request(`${ORIGIN}/healthz`))).status).toBe(200);
      const viaWorker = (async (url: string | URL | Request, init?: RequestInit) =>
        app.handle(new Request(url as string, init))) as typeof fetch;
      const signer = (await getChannelSigner(db))!;
      const source = new HttpEventSource({
        baseUrl: cfg.baseUrl!,
        kid: signer.kid,
        privateKey: signer.privateKey,
        now: () => clock,
        fetch: viaWorker,
      });

      const r = await verifyOneClickEndpoint(db, {
        source,
        fetch: viaWorker,
        now: () => clock,
        sleep: async () => undefined,
        attempts: 2,
      });
      expect(r).toEqual({ ok: true, code: "verified" });
      expect(await isOneClickEndpointVerified(db, clock)).toBe(true);
      expect((await source.getStats()).depth).toBe(0);

      // gerçek çıkış bağlantısı: aynı kökende /u/ yolu, port yok
      const u = await mintUnsubscribeToken(db, { campaignLeadId: a.cl, now: clock });
      const link = buildUnsubscribeUrl(cfg.baseUrl!, u.token);
      expect(link).toBe(`${ORIGIN}/u/${u.token}`);
      const res = await viaWorker(link, {
        method: "POST",
        headers: { "Content-Type": FORM, "CF-Connecting-IP": "203.0.113.9" },
        body: "List-Unsubscribe=One-Click",
      });
      expect(res.status).toBe(200);
      const s = await drainUnsubscribeEvents(db, source, { now: () => clock + 1000 });
      expect(s).toMatchObject({ unsubscribed: 1, error: null });
      expect((await db.select().from(suppressions)).length).toBe(1);
      expect((await source.getStats()).depth).toBe(0);
    });
  });
});

/* ---------------------------------------------------------------------------------------------- */

describe("dağıtım paketi (npm run build:worker)", () => {
  it("tek dosyalık ES modülü: node:/libsql/drizzle/next İÇERMEZ ve paketlenmiş hâli çalışır", async () => {
    const out = path.join(dir, "bundle");
    await promisify(execFile)(
      process.execPath,
      ["scripts/build-bundles.mjs", "--worker", `--outdir=${out}`, "--metafile"],
      { cwd: process.cwd() },
    );
    expect(fs.readdirSync(out).sort()).toEqual(["worker.js", "worker.meta.json"]);
    const meta = JSON.parse(fs.readFileSync(path.join(out, "worker.meta.json"), "utf8")) as {
      inputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    const inputs = Object.keys(meta.inputs);
    expect(inputs).toContain("src/relay/worker.ts");
    for (const i of inputs) {
      expect(i, i).toMatch(/^src\/(relay|lib\/unsubscribe)\//);
      expect(i, i).not.toMatch(
        /node_modules|libsql|drizzle|next|\/db\/|\/spool\.ts$|key-file|relay\/server/,
      );
    }
    const externals = Object.values(meta.inputs)
      .flatMap((x) => x.imports)
      .filter((x) => x.external);
    expect(externals).toEqual([]);
    const bundle = fs.readFileSync(path.join(out, "worker.js"), "utf8");
    expect(bundle).not.toMatch(/\bnode:|require\(|process\.|drizzle|libsql|node:fs/);
    // Node'a özgü küresel adlar: test paketi Node'da çalıştırır, bunlar orada var olduğu için yalnızca çalıştırmak
    // Workers uyumunu kanıtlamaz.
    expect(bundle).not.toMatch(
      /\bBuffer\b|\bsetImmediate\b|__dirname|__filename|globalThis\.process|\bglobal\./,
    );
    expect(bundle).toMatch(/export\s*\{[^}]*default/);

    // paketlenmiş Worker'ı gerçekten çalıştır (Node'un WebCrypto'su; D1 taklidi)
    const mod = (await import(pathToFileURL(path.join(out, "worker.js")).href)) as {
      default: { fetch: (r: Request, e: WorkerEnv) => Promise<Response> };
    };
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const e = env();
      expect((await mod.default.fetch(new Request(`${ORIGIN}/healthz`), e)).status).toBe(200);
      const t = mint();
      expect((await mod.default.fetch(post(t), e)).status).toBe(200);
      const src = sourceFor((r) => mod.default.fetch(r, e));
      const events = await src.pull(10);
      expect(events.map((x) => (x.event as UnsubscribeEvent).token)).toEqual([t]);
      await src.ack(events.map((x) => x.id));
      expect((await src.getStats()).depth).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
