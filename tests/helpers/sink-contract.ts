import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UnsubscribeEventSource } from "@/lib/unsubscribe/ingest";
import { createRelayHandler, type EventSink, type UnsubscribeEvent } from "@/lib/unsubscribe/relay";
import { kidOfPublicKey, newClaims, signToken, type PublicKeyEntry } from "@/lib/unsubscribe/token";

/**
 * Olay kuyruğu/teslimat SÖZLEŞME testleri (Aşama 15.6 incelemesi). Gerçek iletim mekanizması (Aşama 15.7) bu
 * paketi KENDİ gerçeklemesiyle çalıştırmak ZORUNDADIR; geçmeden `oneClickEndpointVerified` açılamaz.
 * Kabul ölçütleri: docs/09-FAZ3-CANLI-DOGRULAMA.md, Bölüm 3.1.
 */

export interface SinkHarness {
  sink: EventSink;
  source: UnsubscribeEventSource;
  /** Süreç yeniden başlamasını simüle eder: bellekteki her şey atılır, yalnızca KALICI depo kalır. */
  restart(): Promise<{ sink: EventSink; source: UnsubscribeEventSource }>;
  /** Yazma hatası enjekte eder (disk dolu, bağlantı yok...). */
  injectWriteFailure(on: boolean): void;
}

const NOW = Date.UTC(2026, 10, 10, 10, 0, 0);
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const X = publicKey.export({ format: "jwk" }).x!;
const KEY: PublicKeyEntry = { kid: kidOfPublicKey(X), x: X };

/** Testlerde kullanılan genel anahtar kümesi. */
export const testKeys = (): PublicKeyEntry[] => [KEY];

export const newToken = (): string =>
  signToken(
    newClaims({
      kid: KEY.kid,
      campaignLeadId: 3,
      messageId: 4,
      recipientTag: "C".repeat(22),
      now: NOW,
    }),
    privateKey,
  );
export const newEvent = (token = newToken()): UnsubscribeEvent => ({
  v: 1,
  token,
  receivedAt: NOW + 1000,
  via: "one_click",
});

const FORM = "application/x-www-form-urlencoded";
export const postFor = (token: string): Request =>
  new Request(`https://cikis.example.test/u/${token}`, {
    method: "POST",
    headers: { "Content-Type": FORM },
    body: "List-Unsubscribe=One-Click",
  });

export const relayFor = (sink: EventSink, now = NOW + 1000, sinkTimeoutMs?: number) =>
  createRelayHandler({
    keys: () => [KEY],
    sink,
    now: () => now,
    ...(sinkTimeoutMs ? { sinkTimeoutMs } : {}),
  });

export function runSinkContract(name: string, make: () => Promise<SinkHarness>): void {
  describe(`olay kuyruğu sözleşmesi: ${name}`, () => {
    it("dayanıklı olduğunu bildirir ve makbuz verir", async () => {
      const h = await make();
      expect(h.sink.durable).toBe(true);
      const r = await h.sink.push(newEvent());
      expect(r.stored).toBe(true);
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
    });

    it("push çözüldüyse olay YENİDEN BAŞLATMADAN sonra da vardır (dayanıklılık)", async () => {
      const h = await make();
      const e = newEvent();
      const receipt = await h.sink.push(e);
      const again = await h.restart();
      const items = await again.source.pull(10);
      expect(items.map((i) => i.event)).toEqual([e]);
      expect(items[0]!.id).toBe(receipt.id);
    });

    it("pull olayı tüketmez; yalnızca ack siler; onaylanmayan olay yeniden başlatmada tekrar gelir", async () => {
      const h = await make();
      const [e1, e2] = [newEvent(), newEvent()];
      await h.sink.push(e1);
      await h.sink.push(e2);
      expect(await h.source.pull(10)).toHaveLength(2);
      expect(await h.source.pull(10)).toHaveLength(2); // tüketilmedi
      const first = (await h.source.pull(1))[0]!;
      await h.source.ack([first.id]);
      await h.source.ack(["bilinmeyen-kimlik"]); // zararsız
      const r = await h.restart();
      const left = await r.source.pull(10);
      expect(left).toHaveLength(1);
      expect(left[0]!.id).not.toBe(first.id);
    });

    it("yazma başarısızsa push REDDEDİLİR (çözülmez) ve hiçbir olay kaydedilmez", async () => {
      const h = await make();
      h.injectWriteFailure(true);
      await expect(h.sink.push(newEvent())).rejects.toBeDefined();
      h.injectWriteFailure(false);
      const r = await h.restart();
      expect(await r.source.pull(10)).toHaveLength(0);
    });

    it("en-az-bir-kez: aynı olay iki kez yazılırsa hiçbiri kaybolmaz (tekilleştirme uygulamadadır)", async () => {
      const h = await make();
      const e = newEvent();
      await h.sink.push(e);
      await h.sink.push(e);
      const items = await (await h.restart()).source.pull(10);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.every((i) => JSON.stringify(i.event) === JSON.stringify(e))).toBe(true);
    });

    it("uygulama çevrimdışı: olaylar birikir, hiçbiri kaybolmaz; sonra hepsi çekilir", async () => {
      const h = await make();
      const events = Array.from({ length: 12 }, () => newEvent());
      for (const e of events) await h.sink.push(e);
      const r = await h.restart();
      const pulled = await r.source.pull(100);
      expect(pulled.map((i) => (i.event as UnsubscribeEvent).token).sort()).toEqual(
        events.map((e) => e.token).sort(),
      );
    });

    it("aktarıcı: yazma hatasında 503 + Retry-After (200 DEĞİL), düzelince aynı istek 200 ve olay kayıtlı", async () => {
      const h = await make();
      const token = newToken();
      const relay = relayFor(h.sink);
      h.injectWriteFailure(true);
      const bad = await relay(postFor(token));
      expect(bad.status).toBe(503);
      expect(bad.headers.get("retry-after")).toBe("60");
      expect(await h.source.pull(10)).toHaveLength(0);
      h.injectWriteFailure(false);
      const ok = await relay(postFor(token));
      expect(ok.status).toBe(200);
      const items = await h.source.pull(10);
      expect(items).toHaveLength(1);
      expect((items[0]!.event as UnsubscribeEvent).token).toBe(token);
    });

    it("aktarıcı: 200 döndüğü anda olay ZATEN kalıcıdır; aktarıcı yeniden başlasa da kaybolmaz", async () => {
      const h = await make();
      const token = newToken();
      const res = await relayFor(h.sink)(postFor(token));
      expect(res.status).toBe(200);
      // aktarıcı + sink süreçleri çöker; yalnızca kalıcı depo kalır
      const r = await h.restart();
      const items = await r.source.pull(10);
      expect(items.map((i) => (i.event as UnsubscribeEvent).token)).toEqual([token]);
      // yeni aktarıcı (tekrar oynatma kaydı kaybolmuş): aynı belirteç 200, olay kaybolmaz (kopya olabilir)
      const again = await relayFor(r.sink)(postFor(token));
      expect(again.status).toBe(200);
      const after = await r.source.pull(10);
      expect(after.length).toBeGreaterThanOrEqual(1);
      expect(new Set(after.map((i) => (i.event as UnsubscribeEvent).token))).toEqual(
        new Set([token]),
      );
    });
  });
}
