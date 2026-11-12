import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHANNEL_SKEW_MS,
  ChannelError,
  HttpEventSource,
  channelSigningInput,
  createSpoolPullHandler,
  signChannelRequest,
  verifyChannelRequest,
} from "@/lib/unsubscribe/channel";
import { createRelayHandler, type UnsubscribeEvent } from "@/lib/unsubscribe/relay";
import { FileSpool, SpoolError } from "@/lib/unsubscribe/spool";
import { kidOfPublicKey, type PublicKeyEntry } from "@/lib/unsubscribe/token";
import {
  newEvent,
  newToken,
  postFor,
  relayFor,
  runSinkContract,
  testKeys,
} from "./helpers/sink-contract";

/**
 * Dosya tabanlı dayanıklı kuyruk ve imzalı çekme kanalı (Aşama 15.7). Geçici dizin; gerçek ağ/HTTPS yok.
 * Gerçek `FileSpool`, 15.6'daki yürütülebilir sink sözleşmesinden geçirilir.
 */

let dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-spool-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/* Gerçek dosya kuyruğu, sözleşme paketinden geçer (K1–K6). */
runSinkContract("FileSpool (gerçek dosya sistemi)", async () => {
  const dir = tmp();
  let fail = false;
  const open = () =>
    new FileSpool({
      dir,
      beforeWrite: () => {
        if (fail) throw new Error("disk hatası");
      },
    });
  let spool = open();
  return {
    get sink() {
      return spool;
    },
    get source() {
      return spool;
    },
    async restart() {
      spool = open(); // yeni süreç: yalnızca disk kalır
      return { sink: spool, source: spool };
    },
    injectWriteFailure(on: boolean) {
      fail = on;
    },
  } as never;
});

describe("FileSpool: dayanıklılık ve sınırlar", () => {
  it("makbuz sonrası dosya diskte; yarım kalan yazım (tmp) kuyrukta değildir ve açılışta temizlenir", async () => {
    const dir = tmp();
    const s = new FileSpool({ dir });
    const r = await s.push(newEvent());
    expect(fs.existsSync(path.join(dir, "pending", `${r.id}.json`))).toBe(true);
    // çökme: tmp'de yarım dosya
    fs.writeFileSync(path.join(dir, "tmp", "1700000000000-aaaaaaaaaaaaaaaa.tmp"), '{"v":1');
    const s2 = new FileSpool({ dir });
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
    expect((await s2.pull(10)).map((i) => i.id)).toEqual([r.id]);
  });

  it("yazma hatasında olay YOK, tmp artığı YOK, push reddedilir (SpoolError write_failed)", async () => {
    const dir = tmp();
    let fail = true;
    const s = new FileSpool({
      dir,
      beforeWrite: () => {
        if (fail) throw new Error("x");
      },
    });
    await expect(s.push(newEvent())).rejects.toMatchObject({ code: "write_failed" });
    expect(fs.readdirSync(path.join(dir, "pending"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
    fail = false;
    await expect(s.push(newEvent())).resolves.toMatchObject({ stored: true });
  });

  it("kuyruk sınırı: dolunca push reddedilir (olay atılmaz), ack ile yer açılır", async () => {
    const s = new FileSpool({ dir: tmp(), maxPending: 2 });
    const a = await s.push(newEvent());
    await s.push(newEvent());
    await expect(s.push(newEvent())).rejects.toMatchObject({ code: "queue_full" });
    expect(s.stats().depth).toBe(2);
    await s.ack([a.id]);
    await expect(s.push(newEvent())).resolves.toMatchObject({ stored: true });
  });

  it("geçersiz olay biçimi reddedilir; bozuk dosya karantinaya alınır (silinmez), kuyruğu tıkamaz, sayılır", async () => {
    const dir = tmp();
    const s = new FileSpool({ dir });
    await expect(
      s.push({ v: 1, token: "x", receivedAt: 1, via: "one_click", ekstra: 1 } as never),
    ).rejects.toBeInstanceOf(SpoolError);
    await expect(s.push({ ...newEvent(), token: "" })).rejects.toMatchObject({
      code: "invalid_event",
    });
    const ok = await s.push(newEvent());
    fs.writeFileSync(path.join(dir, "pending", "1700000000001-bbbbbbbbbbbbbbbb.json"), "{bozuk");
    fs.writeFileSync(
      path.join(dir, "pending", "1700000000002-cccccccccccccccc.json"),
      '{"v":1,"x":1}',
    );
    const pulled = await s.pull(10);
    expect(pulled.map((p) => p.id)).toContain(ok.id);
    expect(pulled).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, "corrupt")).sort()).toEqual([
      "1700000000001-bbbbbbbbbbbbbbbb.json",
      "1700000000002-cccccccccccccccc.json",
    ]);
    expect(s.stats().corrupt).toBe(2);
  });

  it("ack: yol geçişi ve yabancı kimlikler yok sayılır; yalnızca geçerli kimlik silinir", async () => {
    const dir = tmp();
    const s = new FileSpool({ dir });
    const r = await s.push(newEvent());
    fs.writeFileSync(path.join(dir, "korunan.json"), "x");
    await s.ack([
      "../korunan",
      "..\\korunan",
      "../../etc/passwd",
      "x",
      "",
      r.id.replace(/.$/, "Z"),
    ]);
    expect(fs.existsSync(path.join(dir, "korunan.json"))).toBe(true);
    expect(s.stats().depth).toBe(1);
    await s.ack([r.id]);
    expect(s.stats().depth).toBe(0);
  });

  it("izleme (K11): derinlik ve en eski olayın yaşı; sıra zaman damgasına göredir; saklama süresiz (otomatik silme yok)", async () => {
    let t = 1_800_000_000_000;
    const s = new FileSpool({ dir: tmp(), now: () => t });
    expect(s.stats()).toEqual({ depth: 0, oldestAgeMs: null, corrupt: 0 });
    await s.push(newEvent());
    t += 5_000;
    await s.push(newEvent());
    t += 400 * 86_400_000; // 400 gün sonra: olaylar hâlâ duruyor
    expect(s.stats()).toMatchObject({ depth: 2 });
    expect(s.stats().oldestAgeMs).toBe(5_000 + 400 * 86_400_000);
    expect(await s.pull(10)).toHaveLength(2);
  });

  it("beforeWrite üretimde kabul edilmez", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() => new FileSpool({ dir: tmp(), beforeWrite: () => undefined })).toThrow(
        /yalnızca testte/,
      );
    } finally {
      env.NODE_ENV = prev;
    }
  });

  it("aktarıcıya takılı gerçek dosya kuyruğu: 200 → dosya diskte; kuyruk dolunca 503, olay atılmaz", async () => {
    const dir = tmp();
    const spool = new FileSpool({ dir, maxPending: 1 });
    const relay = relayFor(spool);
    const t1 = newToken();
    expect((await relay(postFor(t1))).status).toBe(200);
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(1);
    expect((await relay(postFor(newToken()))).status).toBe(503);
    expect(fs.readdirSync(path.join(dir, "pending"))).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */

const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
function channelKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { privateKey, entry: { kid: kidOfPublicKey(x), x } as PublicKeyEntry };
}
const CK = channelKeys();
const OTHER = channelKeys();

describe("imzalı çekme kanalı (K9)", () => {
  let dir: string;
  let spool: FileSpool;
  let handler: (r: Request) => Promise<Response>;
  const BASE = "https://cikis.firma-ornek.com";
  beforeEach(() => {
    dir = tmp();
    spool = new FileSpool({ dir, now: () => NOW });
    handler = createSpoolPullHandler({ spool, keys: () => [CK.entry], now: () => NOW });
  });

  const signedReq = (
    method: string,
    pathQ: string,
    body = "",
    key = CK,
    ts = NOW,
    kid = key.entry.kid,
  ) =>
    new Request(`${BASE}${pathQ}`, {
      method,
      headers: {
        ...signChannelRequest(kid, key.privateKey, method, pathQ, body, ts),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body } : {}),
    });
  const source = (over: Partial<ConstructorParameters<typeof HttpEventSource>[0]> = {}) =>
    new HttpEventSource({
      baseUrl: BASE,
      kid: CK.entry.kid,
      privateKey: CK.privateKey,
      now: () => NOW,
      fetch: ((url: string, init: RequestInit) => handler(new Request(url, init))) as typeof fetch,
      ...over,
    });

  it("imzalı çekme/onay/istatistik uçtan uca çalışır", async () => {
    const e = newEvent();
    const r = await spool.push(e);
    const src = source();
    const items = await src.pull(10);
    expect(items).toEqual([{ id: r.id, event: e }]);
    await src.ack([r.id]);
    expect(await src.pull(10)).toEqual([]);
    expect(await src.getStats()).toEqual({ depth: 0, oldestAgeMs: null, corrupt: 0 });
  });

  it("kimlik doğrulaması olmayan/yanlış her istek tek tip 401 alır ve hiçbir şey yapmaz", async () => {
    const r = await spool.push(newEvent());
    const bad: [string, Request][] = [
      ["imzasız", new Request(`${BASE}/spool/events`)],
      ["başka anahtar", signedReq("GET", "/spool/events?limit=10", "", OTHER)],
      ["bilinmeyen kid", signedReq("GET", "/spool/events?limit=10", "", CK, NOW, "0".repeat(16))],
      [
        "eski zaman damgası",
        signedReq("GET", "/spool/events?limit=10", "", CK, NOW - CHANNEL_SKEW_MS - 1000),
      ],
      [
        "ileri zaman damgası",
        signedReq("GET", "/spool/events?limit=10", "", CK, NOW + CHANNEL_SKEW_MS + 1000),
      ],
    ];
    for (const [name, req] of bad) {
      const res = await handler(req);
      expect(res.status, name).toBe(401);
      expect(await res.json(), name).toEqual({ error: "unauthorized" });
    }
    // imza başka yola/yönteme/gövdeye bağlı: kaydırma saldırıları
    const signedForEvents = signedReq("GET", "/spool/events?limit=10");
    const h = Object.fromEntries(signedForEvents.headers);
    expect((await handler(new Request(`${BASE}/spool/stats`, { headers: h }))).status).toBe(401);
    expect(
      (await handler(new Request(`${BASE}/spool/events?limit=500`, { headers: h }))).status,
    ).toBe(401);
    const ackBody = JSON.stringify({ ids: [r.id] });
    const signedAck = signedReq("POST", "/spool/ack", ackBody);
    const ah = Object.fromEntries(signedAck.headers);
    expect(
      (
        await handler(
          new Request(`${BASE}/spool/ack`, {
            method: "POST",
            headers: ah,
            body: JSON.stringify({ ids: ["1700000000000-ffffffffffffffff"] }),
          }),
        )
      ).status,
    ).toBe(401); // gövde değiştirildi
    expect(spool.stats().depth).toBe(1); // hiçbir yetkisiz istek olayı silmedi
  });

  it("imza kaydırma: aynı imza başka yöntemle/başka yolla geçerli değil; imza girdisi alanlara bağlı", () => {
    const a = channelSigningInput("GET", "/spool/events", NOW, "");
    expect(a.equals(channelSigningInput("POST", "/spool/events", NOW, ""))).toBe(false);
    expect(a.equals(channelSigningInput("GET", "/spool/stats", NOW, ""))).toBe(false);
    expect(a.equals(channelSigningInput("GET", "/spool/events", NOW + 1, ""))).toBe(false);
    expect(a.equals(channelSigningInput("GET", "/spool/events", NOW, "x"))).toBe(false);
    const headers = new Headers(
      signChannelRequest(CK.entry.kid, CK.privateKey, "GET", "/spool/events", "", NOW),
    );
    expect(
      verifyChannelRequest(
        { method: "GET", pathWithQuery: "/spool/events", headers, body: "" },
        [CK.entry],
        NOW,
      ),
    ).toBe(true);
    expect(
      verifyChannelRequest(
        { method: "GET", pathWithQuery: "/spool/events", headers, body: "" },
        [{ kid: CK.entry.kid, x: OTHER.entry.x }],
        NOW,
      ),
    ).toBe(false);
    expect(
      verifyChannelRequest(
        { method: "GET", pathWithQuery: "/spool/events", headers, body: "" },
        [],
        NOW,
      ),
    ).toBe(false);
  });

  it("yanlış etiketlenmiş anahtar girdisi (kimlik, genel anahtarın özetiyle uyuşmuyor) reddedilir", () => {
    const fakeKid = "a".repeat(16);
    const headers = new Headers(
      signChannelRequest(fakeKid, OTHER.privateKey, "GET", "/spool/events", "", NOW),
    );
    const req = { method: "GET", pathWithQuery: "/spool/events", headers, body: "" };
    expect(verifyChannelRequest(req, [{ kid: fakeKid, x: OTHER.entry.x }], NOW)).toBe(false);
    expect(verifyChannelRequest(req, [OTHER.entry], NOW)).toBe(false); // kid başlığı uyuşmuyor
    const ok = new Headers(
      signChannelRequest(OTHER.entry.kid, OTHER.privateKey, "GET", "/spool/events", "", NOW),
    );
    expect(verifyChannelRequest({ ...req, headers: ok }, [OTHER.entry], NOW)).toBe(true);
  });

  it("yol/yöntem sınırları ve biçim hataları: kimlik doğrulandıktan sonra 400/405/413", async () => {
    expect((await handler(new Request(`${BASE}/spool/baska`))).status).toBe(404);
    expect((await handler(signedReq("POST", "/spool/events"))).status).toBe(405);
    expect((await handler(signedReq("GET", "/spool/ack"))).status).toBe(405);
    for (const body of [
      "{bozuk",
      "{}",
      '{"ids":"x"}',
      '{"ids":["../x"]}',
      `{"ids":[${Array(501).fill('"1700000000000-aaaaaaaaaaaaaaaa"').join(",")}]}`,
    ]) {
      expect((await handler(signedReq("POST", "/spool/ack", body))).status, body.slice(0, 30)).toBe(
        400,
      );
    }
    const huge = JSON.stringify({ ids: [], pad: "a".repeat(70_000) });
    expect((await handler(signedReq("POST", "/spool/ack", huge))).status).toBe(413);
  });

  it("anahtar kaynağı hata verirse 503; kuyruk hata verirse 503 (sızıntı yok)", async () => {
    const h1 = createSpoolPullHandler({
      spool,
      keys: () => {
        throw new Error("x");
      },
      now: () => NOW,
    });
    expect((await h1(signedReq("GET", "/spool/stats"))).status).toBe(503);
    const broken = {
      ...spool,
      pull: async () => {
        throw new Error("disk");
      },
      ack: spool.ack.bind(spool),
      stats: spool.stats.bind(spool),
    };
    const h2 = createSpoolPullHandler({ spool: broken, keys: () => [CK.entry], now: () => NOW });
    const res = await h2(signedReq("GET", "/spool/events?limit=5"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("disk");
  });

  it("HttpEventSource: yalnızca https; yönlendirme/bozuk yanıt/aşırı büyük/HTTP hatası kontrollü ChannelError", async () => {
    expect(() => source({ baseUrl: "http://cikis.firma-ornek.com" })).toThrow(ChannelError);
    expect(() => source({ baseUrl: "https://u:p@cikis.firma-ornek.com" })).toThrow(ChannelError);
    const respond = (status: number, body: string) =>
      source({ fetch: (async () => new Response(body, { status })) as typeof fetch });
    await expect(respond(500, "x").pull(5)).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });
    await expect(respond(401, "x").pull(5)).rejects.toMatchObject({
      code: "http_error",
      status: 401,
    });
    await expect(respond(200, "{bozuk").pull(5)).rejects.toMatchObject({ code: "bad_response" });
    await expect(respond(200, '{"events":"x"}').pull(5)).rejects.toMatchObject({
      code: "bad_response",
    });
    await expect(
      respond(200, '{"events":[{"id":"../x","event":{}}]}').pull(5),
    ).rejects.toMatchObject({ code: "bad_response" });
    await expect(
      respond(
        200,
        '{"events":[{"id":"1700000000000-aaaaaaaaaaaaaaaa"},{"id":"1700000000000-aaaaaaaaaaaaaaab","event":1}]}',
      ).pull(5),
    ).rejects.toMatchObject({ code: "bad_response" });
    const many = JSON.stringify({
      events: Array.from({ length: 6 }, (_, i) => ({
        id: `170000000000${i}-aaaaaaaaaaaaaaaa`,
        event: {},
      })),
    });
    await expect(respond(200, many).pull(5)).rejects.toMatchObject({ code: "bad_response" }); // istenenden fazla
    await expect(respond(200, "x".repeat(1_600_000)).pull(5)).rejects.toMatchObject({
      code: "bad_response",
    });
    // Uzunluk başlığı olmayan akış: sınır aşılınca okuma DURUR (gövdenin tamamı belleğe alınmaz).
    const streamed = (status: number, chunks: number) => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          if (pulled > chunks) c.close();
          else c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
      });
      return {
        src: source({ fetch: (async () => new Response(body, { status })) as typeof fetch }),
        pulled: () => pulled,
      };
    };
    const big = streamed(200, 10_000); // ~640 MB olurdu
    await expect(big.src.pull(5)).rejects.toMatchObject({ code: "bad_response" });
    expect(big.pulled()).toBeLessThan(40);
    const bigErr = streamed(500, 10_000);
    await expect(bigErr.src.pull(5)).rejects.toMatchObject({ code: "http_error", status: 500 });
    expect(bigErr.pulled()).toBeLessThan(3); // hata gövdesi okunmaz
    await expect(
      source({
        fetch: (async () =>
          new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), { status: 200 })) as typeof fetch,
      }).pull(5),
    ).rejects.toMatchObject({ code: "bad_response" }); // geçersiz UTF-8
    await expect(
      respond(200, '{"acked":"x"}').ack(["1700000000000-aaaaaaaaaaaaaaaa"]),
    ).rejects.toMatchObject({ code: "bad_response" });
    await expect(
      respond(200, '{"depth":-1,"oldestAgeMs":null,"corrupt":0}').getStats(),
    ).rejects.toMatchObject({ code: "bad_response" });
    const netFail = source({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(netFail.pull(5)).rejects.toMatchObject({ code: "network" });
  });
});

describe("uçtan uca: aktarıcı → dosya kuyruğu → imzalı çekme (yeniden başlatmalı)", () => {
  it("aktarıcı yeniden başlar, kuyruk diskte kalır, uygulama imzalı kanaldan çeker ve onaylar", async () => {
    const dir = tmp();
    const BASE = "https://cikis.firma-ornek.com";
    const t1 = newToken();
    const relayA = createRelayHandler({
      keys: testKeys,
      sink: new FileSpool({ dir }),
      now: () => Date.UTC(2026, 10, 10, 10, 0, 1),
    });
    expect((await relayA(postFor(t1))).status).toBe(200);
    // yeniden başlatma: yeni FileSpool, yeni çekme işleyicisi
    const spool = new FileSpool({ dir });
    const handler = createSpoolPullHandler({ spool, keys: () => [CK.entry], now: () => NOW });
    const src = new HttpEventSource({
      baseUrl: BASE,
      kid: CK.entry.kid,
      privateKey: CK.privateKey,
      now: () => NOW,
      fetch: ((u: string, i: RequestInit) => handler(new Request(u, i))) as typeof fetch,
    });
    const items = await src.pull(10);
    expect(items).toHaveLength(1);
    expect((items[0]!.event as UnsubscribeEvent).token).toBe(t1);
    await src.ack(items.map((i) => i.id));
    expect(spool.stats().depth).toBe(0);
  });
});
