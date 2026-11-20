import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeConfirmUnavailableError,
  requestNativeConfirm,
  resetNativeConfirmForTests,
  type IpcChannel,
} from "@/lib/native-confirm";
import {
  canonicalJson,
  isNativeConfirmCancel,
  isNativeConfirmRequest,
  isNativeConfirmResponse,
  NATIVE_CONFIRM_CANCEL,
  NATIVE_CONFIRM_MAX_TTL_MS,
  NATIVE_CONFIRM_REQUEST,
  NATIVE_CONFIRM_RESPONSE,
  summaryHash,
  type CountryActivationSummary,
} from "@/lib/native-confirm-protocol";

/**
 * Yerel onay protokolü ve sunucu tarafı istemci (src/lib/native-confirm*.ts). Sahte kanal; gerçek `process` kullanılmaz.
 */

const SUMMARY: CountryActivationSummary = {
  countries: ["GB"],
  mode: "generic_only",
  operatorName: "Op",
  representativeName: "Temsilci",
  representativeTitle: "Müdür",
  documentRef: "REF-1",
  documentDate: "2026-11-18",
  documentShaPrefix: null,
  testModeEnabled: true,
  allowedAddressCount: 1,
  runningLiveCampaigns: 0,
};
const ID = "a".repeat(32);

class FakeChannel extends EventEmitter {
  connected = true;
  sent: Record<string, unknown>[] = [];
  send = vi.fn((m: unknown) => {
    this.sent.push(m as Record<string, unknown>);
    return true;
  });
}
const asChannel = (c: FakeChannel) => c as unknown as IpcChannel;
const reply = (ch: FakeChannel, over: Record<string, unknown> = {}) =>
  ch.emit("message", {
    type: NATIVE_CONFIRM_RESPONSE,
    id: ID,
    approved: true,
    summaryHash: summaryHash(SUMMARY),
    ...over,
  });
const ask = (ch: FakeChannel, ttlMs?: number) =>
  requestNativeConfirm(
    { kind: "country_activation", summary: SUMMARY },
    { channel: asChannel(ch), newId: () => ID, ttlMs },
  );

beforeEach(() => {
  resetNativeConfirmForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetNativeConfirmForTests();
});

describe("protokol", () => {
  it("özet kararlı biçimde özetlenir (anahtar sırası fark etmez); istek/yanıt/iptal yapıları doğrulanır", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(summaryHash({ a: 1, b: 2 })).toBe(summaryHash({ b: 2, a: 1 }));
    expect(summaryHash({ a: 1 })).not.toBe(summaryHash({ a: 2 }));
    const req = {
      type: NATIVE_CONFIRM_REQUEST,
      id: ID,
      kind: "country_activation",
      summary: SUMMARY,
      summaryHash: summaryHash(SUMMARY),
      ttlMs: 1000,
    };
    expect(isNativeConfirmRequest(req)).toBe(true);
    expect(isNativeConfirmRequest({ ...req, id: "kısa" })).toBe(false);
    expect(isNativeConfirmRequest({ ...req, summaryHash: "x" })).toBe(false);
    expect(isNativeConfirmRequest({ ...req, type: "notify" })).toBe(false);
    expect(isNativeConfirmRequest(null)).toBe(false);
    expect(
      isNativeConfirmResponse({
        type: NATIVE_CONFIRM_RESPONSE,
        id: "x",
        approved: true,
        summaryHash: "h",
      }),
    ).toBe(true);
    expect(
      isNativeConfirmResponse({
        type: NATIVE_CONFIRM_RESPONSE,
        id: "x",
        approved: "evet",
        summaryHash: "h",
      }),
    ).toBe(false);
    expect(isNativeConfirmCancel({ type: NATIVE_CONFIRM_CANCEL, id: "x" })).toBe(true);
  });
});

describe("requestNativeConfirm", () => {
  it("kanal yoksa (send yok veya bağlı değil) NativeConfirmUnavailableError", async () => {
    const none = new EventEmitter() as unknown as IpcChannel; // send yok (tarayıcı/geliştirme/betik)
    await expect(
      requestNativeConfirm({ kind: "country_activation", summary: SUMMARY }, { channel: none }),
    ).rejects.toBeInstanceOf(NativeConfirmUnavailableError);
    const ch = new FakeChannel();
    ch.connected = false;
    await expect(ask(ch)).rejects.toMatchObject({ why: "no_channel" });
    expect(ch.send).not.toHaveBeenCalled();
  });

  it("istek doğru biçimde gider; özetle ve kimlikle eşleşen onay 'approved' döner; dinleyiciler kaldırılır", async () => {
    const ch = new FakeChannel();
    const p = ask(ch);
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toMatchObject({
      type: NATIVE_CONFIRM_REQUEST,
      id: ID,
      kind: "country_activation",
      summary: SUMMARY,
      summaryHash: summaryHash(SUMMARY),
      ttlMs: NATIVE_CONFIRM_MAX_TTL_MS,
    });
    reply(ch);
    await expect(p).resolves.toBe("approved");
    expect(ch.listenerCount("message")).toBe(0);
    expect(ch.listenerCount("disconnect")).toBe(0);
  });

  it("TEK KULLANIMLIK: ikinci yanıt yok sayılır; yanlış kimlik, yanlış özet ve onaysız yanıt onay sayılmaz", async () => {
    // yanlış kimlik: yok sayılır (bekleme sürer), doğru yanıt sonra gelir
    let ch = new FakeChannel();
    let p = ask(ch);
    reply(ch, { id: "b".repeat(32) });
    reply(ch, { approved: false });
    await expect(p).resolves.toBe("declined");
    reply(ch); // ikinci (geç) yanıt: etkisiz
    expect(ch.listenerCount("message")).toBe(0);

    // yanlış özet özeti: onay sayılmaz
    resetNativeConfirmForTests();
    ch = new FakeChannel();
    p = ask(ch);
    reply(ch, { summaryHash: "0".repeat(64) });
    await expect(p).resolves.toBe("declined");

    // başka türde mesajlar yok sayılır
    resetNativeConfirmForTests();
    ch = new FakeChannel();
    p = ask(ch);
    ch.emit("message", { type: "notify" });
    ch.emit("message", "metin");
    ch.emit("message", null);
    expect(ch.listenerCount("message")).toBe(1); // hâlâ bekliyor
    reply(ch);
    await expect(p).resolves.toBe("approved");
  });

  it("süre dolarsa ana sürece İPTAL gider ve 'timeout' döner; sonradan gelen onay etkisizdir", async () => {
    const ch = new FakeChannel();
    const p = ask(ch, 10_000);
    await vi.advanceTimersByTimeAsync(10_000 + 5000);
    await expect(p).resolves.toBe("timeout");
    expect(ch.sent.at(-1)).toMatchObject({ type: NATIVE_CONFIRM_CANCEL, id: ID });
    expect(ch.listenerCount("message")).toBe(0);
    reply(ch);
  });

  it("süre üst sınırla kırpılır; kanal kopunca ve gönderim hatasında 'declined'", async () => {
    let ch = new FakeChannel();
    const p = ask(ch, 10 * 60_000);
    expect((ch.sent[0] as { ttlMs: number }).ttlMs).toBe(NATIVE_CONFIRM_MAX_TTL_MS);
    ch.emit("disconnect");
    await expect(p).resolves.toBe("declined");

    resetNativeConfirmForTests();
    ch = new FakeChannel();
    ch.send = vi.fn(() => {
      throw new Error("kanal kapalı");
    });
    await expect(ask(ch)).resolves.toBe("declined");
    expect(ch.listenerCount("message")).toBe(0);
  });

  it("aynı anda tek bekleyen istek: ikincisi 'busy'; ilki bitince yenisi başlayabilir", async () => {
    const ch = new FakeChannel();
    const first = ask(ch);
    await expect(ask(new FakeChannel())).rejects.toMatchObject({ why: "busy" });
    reply(ch);
    await first;
    const ch2 = new FakeChannel();
    const next = ask(ch2);
    reply(ch2);
    await expect(next).resolves.toBe("approved");
  });
});

describe("test kancası ve vitest IPC güvenliği", () => {
  it("kanal kancası: null = kanal yok, nesne = sahte kanal, undefined = varsayılan; üretimde kullanılamaz", async () => {
    const { isNativeConfirmChannelAvailable, setNativeConfirmChannelForTests } =
      await import("@/lib/native-confirm");
    setNativeConfirmChannelForTests(null);
    expect(isNativeConfirmChannelAvailable()).toBe(false);
    const ch = new FakeChannel();
    setNativeConfirmChannelForTests(asChannel(ch));
    expect(isNativeConfirmChannelAvailable()).toBe(true);
    ch.connected = false;
    expect(isNativeConfirmChannelAvailable()).toBe(false);
    setNativeConfirmChannelForTests(undefined);
    const old = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => setNativeConfirmChannelForTests(null)).toThrow(/yalnızca testte/i);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = old!;
    }
  });

  it("hiçbir test gerçek process.send/connected'ı değiştirmez (vitest çalışanı kendi IPC kanalı olarak kullanır; çökertir)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = __dirname;
    const self = path.basename(__filename);
    const offenders = fs
      .readdirSync(dir)
      // electron-ipc-seams: mevcut; YALNIZCA eşzamanlı bir çağrı süresince değiştirip `finally` ile geri yükler (await yok).
      .filter((f) => /\.test\.tsx?$/.test(f) && f !== self && f !== "electron-ipc-seams.test.ts")
      .filter((f) =>
        /defineProperty\(\s*process\s*,\s*["'](send|connected)["']|process\.(send|connected)\s*=[^=]|vi\.spyOn\(\s*process\s*,\s*["']send["']/.test(
          fs.readFileSync(path.join(dir, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
