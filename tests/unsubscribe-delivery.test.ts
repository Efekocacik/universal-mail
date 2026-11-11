import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { campaignLeads, suppressions } from "@/lib/db/schema";
import { drainUnsubscribeEvents, type UnsubscribeEventSource } from "@/lib/unsubscribe/ingest";
import { ensureSigningKey, loadPublicKeys, mintUnsubscribeToken } from "@/lib/unsubscribe/keys";
import {
  MemoryEventQueue,
  assertSinkAllowed,
  createRelayHandler,
  type DeliveryReceipt,
  type EventSink,
  type UnsubscribeEvent,
} from "@/lib/unsubscribe/relay";
import { createCampaign, openMemoryDb, seedBase } from "./helpers/campaign-fixture";
import { NOW, seedSent } from "./helpers/inbound-fixture";
import {
  newToken,
  postFor,
  relayFor,
  runSinkContract,
  type SinkHarness,
} from "./helpers/sink-contract";

/**
 * Teslimat sözleşmesi (Aşama 15.6 güvenilirlik incelemesi). Kalıcı depolama veya gerçek HTTPS sunucusu KURULMAZ:
 * "kalıcı depo", yeniden başlatmada korunan bir bellek yapısıyla simüle edilir; arayüzün sözleşmeyi desteklediği
 * gösterilir. Gerçek mekanizma (Aşama 15.7) aynı sözleşme testlerini KENDİ gerçeklemesiyle geçmelidir.
 */

/** Süreç yeniden başlamasında korunan "disk". */
class SimDurableStore {
  rows: { id: string; event: UnsubscribeEvent; acked: boolean }[] = [];
  seq = 0;
  failWrites = false;
  capacity = Number.POSITIVE_INFINITY;

  sink(): EventSink {
    return {
      durable: true,
      push: async (event) => {
        if (this.failWrites) throw new Error("disk hatası");
        if (this.rows.filter((r) => !r.acked).length >= this.capacity)
          throw new Error("kuyruk dolu");
        const id = `row-${++this.seq}`;
        this.rows.push({ id, event: structuredClone(event), acked: false });
        return { stored: true, id };
      },
    };
  }
  source(): UnsubscribeEventSource {
    return {
      pull: async (limit) => {
        return this.rows
          .filter((r) => !r.acked)
          .slice(0, limit)
          .map((r) => ({ id: r.id, event: structuredClone(r.event) }));
      },
      ack: async (ids) => {
        for (const r of this.rows) if (ids.includes(r.id)) r.acked = true;
      },
    };
  }
}

runSinkContract("simüle kalıcı depo (test)", async (): Promise<SinkHarness> => {
  const store = new SimDurableStore();
  return {
    sink: store.sink(),
    source: store.source(),
    async restart() {
      return { sink: store.sink(), source: store.source() };
    },
    injectWriteFailure(on) {
      store.failWrites = on;
    },
  };
});

/* ---------------------------------------------------------------------------------------------- */

describe("200 yalnızca DAYANIKLI kayıttan sonra", () => {
  it("push bekliyorken yanıt BEKLER; push bitince 200 (kayıt, yanıttan önce)", async () => {
    const store = new SimDurableStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = store.sink();
    const sink: EventSink = {
      durable: true,
      async push(e) {
        await gate;
        return inner.push(e);
      },
    };
    const relay = relayFor(sink);
    let settled = false;
    const pending = relay(postFor(newToken())).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // henüz kayıt yok → yanıt yok
    expect(store.rows).toHaveLength(0);
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(store.rows).toHaveLength(1); // yanıt verildiğinde kayıt zaten var
  });

  const violators: [string, () => Promise<unknown>][] = [
    ["makbuz yok (undefined)", async () => undefined],
    ["null", async () => null],
    ["stored:false", async () => ({ stored: false, id: "x" })],
    ["stored dizge", async () => ({ stored: "true", id: "x" })],
    ["kimlik yok", async () => ({ stored: true })],
    ["boş kimlik", async () => ({ stored: true, id: "" })],
    ["kimlik sayı", async () => ({ stored: true, id: 7 })],
    ["düz true", async () => true],
    ["istisna", async () => Promise.reject(new Error("boom"))],
  ];
  it.each(violators)(
    "sözleşmeyi ihlal eden sink (%s): 200 DEĞİL, 503; tekrar oynatma kaydı tutulmaz",
    async (_n, result) => {
      let calls = 0;
      const sink: EventSink = {
        durable: true,
        push: async () => {
          calls++;
          return (await result()) as DeliveryReceipt;
        },
      };
      const relay = relayFor(sink);
      const token = newToken();
      for (let i = 0; i < 2; i++) {
        const res = await relay(postFor(token));
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("60");
      }
      expect(calls).toBe(2); // başarısız teslimat "görüldü" sayılmadı: her yeniden deneme sink'e gider
    },
  );
});

describe("zaman aşımı ve geç başarı", () => {
  it("push zaman aşımına uğrarsa 503; sonraki istek yeniden dener ve 200 alır", async () => {
    const store = new SimDurableStore();
    const real = store.sink();
    let calls = 0;
    const sink: EventSink = {
      durable: true,
      push: (e) => {
        calls++;
        return calls === 1 ? new Promise<DeliveryReceipt>(() => undefined) : real.push(e);
      },
    };
    const { relay } = withTimeout(sink, 40);
    const token = newToken();
    expect((await relay(postFor(token))).status).toBe(503);
    expect(store.rows).toHaveLength(0);
    expect((await relay(postFor(token))).status).toBe(200);
    expect(store.rows).toHaveLength(1);
  });

  it("zaman aşımından SONRA gelen geç başarı olayı kaybettirmez (503 verildi, kayıt var → istemci yeniden dener, kopya olabilir)", async () => {
    const store = new SimDurableStore();
    const real = store.sink();
    const sink: EventSink = {
      durable: true,
      push: async (e) => {
        await new Promise((r) => setTimeout(r, 80));
        return real.push(e);
      },
    };
    const { relay } = withTimeout(sink, 20);
    const token = newToken();
    expect((await relay(postFor(token))).status).toBe(503);
    await new Promise((r) => setTimeout(r, 120));
    expect(store.rows.length).toBeGreaterThanOrEqual(1); // olay kayıtlı: kaybolmadı
    const events = store.rows.map((r) => r.event.token);
    expect(new Set(events)).toEqual(new Set([token]));
  });
});

describe("eşzamanlılık ve geri basınç", () => {
  it("aynı belirteçle eşzamanlı istekler TEK push çağrısında birleşir ve aynı sonucu alır", async () => {
    const store = new SimDurableStore();
    const real = store.sink();
    let calls = 0;
    const sink: EventSink = {
      durable: true,
      push: async (e) => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return real.push(e);
      },
    };
    const relay = relayFor(sink);
    const token = newToken();
    const results = await Promise.all(Array.from({ length: 6 }, () => relay(postFor(token))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(calls).toBe(1);
    expect(store.rows).toHaveLength(1);
  });

  it("eşzamanlı istekler ve sink hatası: hepsi 503, sonra yeniden deneme başarılı (tıkanma yok)", async () => {
    const store = new SimDurableStore();
    store.failWrites = true;
    const relay = relayFor(store.sink());
    const token = newToken();
    const bad = await Promise.all(Array.from({ length: 4 }, () => relay(postFor(token))));
    expect(bad.map((r) => r.status)).toEqual([503, 503, 503, 503]);
    store.failWrites = false;
    expect((await relay(postFor(token))).status).toBe(200);
    expect(store.rows).toHaveLength(1);
  });

  it("kuyruk dolu (geri basınç): olay SESSİZCE ATILMAZ; 503 verilir, mevcut olaylar korunur", async () => {
    const store = new SimDurableStore();
    store.capacity = 2;
    const relay = relayFor(store.sink());
    const tokens = [newToken(), newToken(), newToken()];
    expect((await relay(postFor(tokens[0]!))).status).toBe(200);
    expect((await relay(postFor(tokens[1]!))).status).toBe(200);
    expect((await relay(postFor(tokens[2]!))).status).toBe(503);
    expect(store.rows).toHaveLength(2);
    // uygulama olayları tüketince yer açılır ve reddedilen istek yeniden denenebilir
    await store.source().ack([store.rows[0]!.id]);
    expect((await relay(postFor(tokens[2]!))).status).toBe(200);
    expect(store.rows.filter((r) => !r.acked)).toHaveLength(2);
  });
});

describe("gerçek ortamda bellek içi sink yanlışlıkla etkinleştirilemez", () => {
  const withEnv = async (value: string, fn: () => void | Promise<void>) => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = value;
    try {
      await fn();
    } finally {
      env.NODE_ENV = prev;
    }
  };
  const fake = (durable: boolean): EventSink => ({
    durable,
    push: async () => ({ stored: true, id: "x" }),
  });

  it("MemoryEventQueue test dışında oluşturulamaz; dayanıklı değildir", async () => {
    expect(new MemoryEventQueue().durable).toBe(false);
    for (const env of ["production", "development", ""]) {
      await withEnv(env, () => {
        expect(() => new MemoryEventQueue(), env).toThrow(/yalnızca testte/);
      });
    }
  });

  it("dayanıklı olmayan sink test dışında işleyiciye verilemez; dayanıklı sink verilebilir", async () => {
    const queue = new MemoryEventQueue(); // testte oluşturuldu
    for (const env of ["production", "development"]) {
      await withEnv(env, () => {
        expect(() => createRelayHandler({ keys: () => [], sink: queue }), env).toThrow(
          /Dayanıklı olmayan/,
        );
        expect(() => createRelayHandler({ keys: () => [], sink: fake(false) }), env).toThrow(
          /Dayanıklı olmayan/,
        );
        expect(() => assertSinkAllowed(fake(false))).toThrow();
        expect(() => createRelayHandler({ keys: () => [], sink: fake(true) }), env).not.toThrow();
      });
    }
    // testte dayanıklı olmayan sink izinli (yalnızca testler)
    expect(() => createRelayHandler({ keys: () => [], sink: queue })).not.toThrow();
  });

  it("geçersiz sink (eksik push) her ortamda reddedilir", () => {
    for (const bad of [undefined, null, {}, { durable: true }, { durable: true, push: 1 }]) {
      expect(() => assertSinkAllowed(bad as unknown as EventSink)).toThrow(/Geçersiz/);
    }
  });

  it("`durable` alanı yalnızca true ise dayanıklı sayılır (truthy dizge/1 yetmez)", async () => {
    await withEnv("production", () => {
      for (const v of ["true", 1, {}, "yes"]) {
        const s = {
          durable: v,
          push: async () => ({ stored: true, id: "x" }),
        } as unknown as EventSink;
        expect(() => assertSinkAllowed(s)).toThrow();
      }
    });
  });
});

/* ---------------------------------------------------------------------------------------------- */

function withTimeout(sink: EventSink, ms: number) {
  return { relay: relayFor(sink, undefined, ms) };
}

describe("uçtan uca: aktarıcı yeniden başlar, uygulama çevrimdışıdır, olay kaybolmaz ve çift etki doğmaz", () => {
  let client: Client;
  let db: Db;
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["UM_DATA_DIR", "UM_MASTER_KEY"]) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "um-deliv-"));
    process.env.UM_DATA_DIR = dir;
    process.env.UM_MASTER_KEY = "ab".repeat(32);
    ({ client, db } = await openMemoryDb());
    await seedBase(db);
  });
  afterEach(() => {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("A aktarıcısı kaydeder → çöker → B aktarıcısı (kayıt kaybolmuş) kopya kaydeder → uygulama sonra açılır: tek etki", async () => {
    await ensureSigningKey(db, NOW);
    const campaign = await createCampaign(db, { status: "running" });
    const sent = await seedSent(db, campaign, { email: "kisi@alici-ornek.com" });
    const other = await seedSent(db, campaign, { email: "diger@diger-alan.com" });
    const { token } = await mintUnsubscribeToken(db, {
      campaignLeadId: sent.cl,
      messageId: sent.outboundId,
      now: NOW,
    });
    const store = new SimDurableStore();
    const keys = () => loadPublicKeys(db);

    const relayA = createRelayHandler({ keys, sink: store.sink(), now: () => NOW + 1000 });
    expect((await relayA(postFor(token))).status).toBe(200);
    // A çöker (işleyici ve tekrar oynatma kaydı gider); posta istemcisi yanıtı alamadığını varsayıp yeniden dener
    const relayB = createRelayHandler({ keys, sink: store.sink(), now: () => NOW + 2000 });
    expect((await relayB(postFor(token))).status).toBe(200);
    expect(store.rows.length).toBe(2); // kopya: en-az-bir-kez

    // uygulama o ana kadar çevrimdışıydı; şimdi açılır
    const summary = await drainUnsubscribeEvents(db, store.source(), { now: () => NOW + 3600_000 });
    expect(summary).toMatchObject({ pulled: 2, unsubscribed: 1, already: 1, error: null }); // kopya, alıcı zaten engelli
    expect((await db.select().from(suppressions)).length).toBe(1);
    expect(
      (await db.select().from(campaignLeads).where(eq(campaignLeads.id, sent.cl)))[0]!.status,
    ).toBe("unsubscribed");
    expect(
      (await db.select().from(campaignLeads).where(eq(campaignLeads.id, other.cl)))[0]!.status,
    ).toBe("waiting_next");
    expect(store.rows.every((r) => r.acked)).toBe(true);
  });

  it("uygulama çökerse (onaydan önce) olaylar kalır; yeniden açılınca işlenir, çift etki yok", async () => {
    await ensureSigningKey(db, NOW);
    const campaign = await createCampaign(db, { status: "running" });
    const sent = await seedSent(db, campaign, { email: "kisi@alici-ornek.com" });
    const { token } = await mintUnsubscribeToken(db, { campaignLeadId: sent.cl, now: NOW });
    const store = new SimDurableStore();
    await createRelayHandler({
      keys: () => loadPublicKeys(db),
      sink: store.sink(),
      now: () => NOW + 1000,
    })(postFor(token));

    // ilk tur: işleme başarılı ama onay verilemeden uygulama çöker
    const src = store.source();
    const crashing: UnsubscribeEventSource = {
      pull: (n) => src.pull(n),
      ack: async () => {
        throw new Error("çöktü");
      },
    };
    await expect(drainUnsubscribeEvents(db, crashing, { now: () => NOW + 5000 })).rejects.toThrow(
      "çöktü",
    );
    expect(store.rows.some((r) => !r.acked)).toBe(true); // olay hâlâ kuyrukta
    // yeniden açılış
    const s2 = await drainUnsubscribeEvents(db, store.source(), { now: () => NOW + 6000 });
    expect(s2).toMatchObject({ duplicates: 1, unsubscribed: 0, error: null });
    expect((await db.select().from(suppressions)).length).toBe(1);
    expect(store.rows.every((r) => r.acked)).toBe(true);
  });
});
