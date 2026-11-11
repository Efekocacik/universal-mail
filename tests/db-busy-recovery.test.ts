import fs from "node:fs";
import os from "node:os";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suppressEmail } from "@/lib/compliance/suppression";
import { toLibsqlUrl } from "@/lib/config/paths";
import { audit } from "@/lib/db/audit";
import {
  isBusyConnectionError,
  openDatabase,
  resetConnection,
  trackTransactions,
  type Db,
} from "@/lib/db/client";
import { processInbound } from "@/lib/mail/inbound/process";
import { setSetting } from "@/lib/settings";
import { ensureSigningKey, mintUnsubscribeToken } from "@/lib/unsubscribe/keys";
import { ingestUnsubscribeEvent } from "@/lib/unsubscribe/ingest";
import { createCampaign, DEMO_MAILBOX, seedBase } from "./helpers/campaign-fixture";
import { createTestDb, type TestDb } from "./helpers/db";
import { NOW, rawMessage, seedSent, SIMULATED_PASS, type Sent } from "./helpers/inbound-fixture";

/**
 * Aşama 15.10-0: SQLITE_BUSY sonrası bağlantı durumu. libsql'de meşgul sonucu alan bir bağlantıdaki HEMEN SONRAKİ
 * ifade başarılı görünüp UYGULANMAYABİLİR (migrasyonsuz, düz yazma kilidiyle ölçüldü). `open()` ile açılan bağlantılar
 * bu durumda otomatik yenilenir. Burada genel yazma yolları (denetim, engel listesi, ayar, gelen ileti, abonelikten
 * çıkış) gerçek dosya veritabanında, DÜZ KİLİT TUTUCU ve eşzamanlı yazıcılarla sınanır; değişmez: "başarılı dönen her
 * yazma kalıcıdır; başarısız ifade OTOMATİK tekrarlanmaz".
 *
 * Windows'ta Türkçe karakter içeren geçici dizinlerde (bilinen sorun) atlanır; CI (Linux) kararlıdır.
 */

const tmpBase = process.env.TMPDIR ?? os.tmpdir();
const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(tmpBase);

let t: TestDb;
let app: { client: Client; db: Db };
let campaign: number;
let sent: Sent;
const extra: Client[] = [];
const saved: Record<string, string | undefined> = {};

const RCPT = "kisi@alici-ornek.com";

beforeEach(async () => {
  saved.UM_MASTER_KEY = process.env.UM_MASTER_KEY;
  process.env.UM_MASTER_KEY = "ab".repeat(32);
  t = await createTestDb();
  await seedBase(t.db);
  campaign = await createCampaign(t.db, { status: "running" });
  sent = await seedSent(t.db, campaign, { email: RCPT });
  app = await openDatabase(t.path); // sınanan bağlantı: uygulamanın `open()` ayarları ve otomatik kurtarma
});

afterEach(async () => {
  for (const c of extra.splice(0)) c.close();
  app.client.close();
  try {
    await t.cleanup();
  } catch {
    /* Windows'ta geçici dosya silme hatası (bilinen ortam sorunu); testin sonucunu etkilemez */
  }
  if (saved.UM_MASTER_KEY === undefined) delete process.env.UM_MASTER_KEY;
  else process.env.UM_MASTER_KEY = saved.UM_MASTER_KEY;
});

const raw = (): Client => {
  const c = createClient({ url: toLibsqlUrl(t.path) });
  extra.push(c);
  return c;
};

/** Başka bir bağlantı yazma kilidini tutar (düz kilit tutucu; şema değişikliği yok). */
async function holdLock(): Promise<{ release: () => Promise<void> }> {
  const tx = await raw().transaction("write"); // BEGIN IMMEDIATE: yazma kilidi alınır
  await tx.execute("UPDATE mailboxes SET label = label");
  return { release: async () => tx.commit() };
}

async function count(sql: string, args: (string | number)[] = []): Promise<number> {
  const r = await raw().execute({ sql, args });
  return Number(r.rows[0]?.[0] ?? 0);
}

/** Kilit tutulurken `op` çalıştırılır; meşgul hatası alınmalı. Kilit bırakılır. Bağlantı beklemeden meşgul döner. */
async function busyOnce(op: (db: Db) => Promise<unknown>): Promise<void> {
  const h = await holdLock();
  await app.client.execute("PRAGMA busy_timeout = 150");
  let err: unknown;
  try {
    await op(app.db);
  } catch (e) {
    err = e;
  }
  await h.release();
  expect(isBusyConnectionError(err)).toBe(true);
}

const probeAudit = (db: Db) => audit(db, "busy.probe", "test", 1, {}, 1);

describe("meşgul sonucu sonrası genel yazma yolları sessizce kaybolmaz", () => {
  it.skipIf(unsafeTmp)("denetim kaydı", async () => {
    for (let i = 0; i < 4; i++) {
      await busyOnce(probeAudit);
      await audit(app.db, "busy.after", "test", i, {}, 2);
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.after'")).toBe(i + 1);
    }
  });

  it.skipIf(unsafeTmp)("engel listesi (suppression)", async () => {
    await busyOnce(probeAudit);
    await suppressEmail(
      app.db,
      { email: "yeni@engel-ornek.com", reason: "manual", source: "manual" },
      5,
    );
    expect(await count("SELECT COUNT(*) FROM suppressions WHERE domain = 'engel-ornek.com'")).toBe(
      1,
    );
  });

  it.skipIf(unsafeTmp)("ayarlar", async () => {
    await busyOnce(probeAudit);
    await setSetting(app.db, "consent", { version: "busy", acceptedAt: 7, name: "Busy Test" });
    expect(
      await count(
        "SELECT COUNT(*) FROM settings WHERE key = 'consent' AND value LIKE '%Busy Test%'",
      ),
    ).toBe(1);
  });

  it.skipIf(unsafeTmp)("gelen kutusu: yanıt işleme (işlem içinde yazma)", async () => {
    await busyOnce(probeAudit);
    const res = await processInbound(
      app.db,
      {
        mailboxId: DEMO_MAILBOX,
        raw: rawMessage({ from: sent.email, inReplyTo: sent.rfc, nonce: "busy1" }),
        receivedAt: NOW,
        attestation: SIMULATED_PASS,
      },
      { now: NOW },
    );
    expect(res.outcome).not.toBe("rejected");
    expect(await count("SELECT COUNT(*) FROM messages WHERE direction = 'in'")).toBe(1);
    expect(
      await count("SELECT COUNT(*) FROM campaign_leads WHERE id = ? AND status = 'replied'", [
        sent.cl,
      ]),
    ).toBe(1);
  });

  it.skipIf(unsafeTmp)("abonelikten çıkış olayı", async () => {
    await ensureSigningKey(app.db, NOW);
    const { token } = await mintUnsubscribeToken(app.db, {
      campaignLeadId: sent.cl,
      messageId: sent.outboundId,
      now: NOW,
    });
    await busyOnce(probeAudit);
    const out = await ingestUnsubscribeEvent(
      app.db,
      { v: 1, token, receivedAt: NOW + 1000, via: "one_click" },
      { now: NOW + 2000 },
    );
    expect(out.outcome).toBe("unsubscribed");
    expect(await count("SELECT COUNT(*) FROM suppressions WHERE reason = 'unsubscribe'")).toBe(1);
    expect(
      await count("SELECT COUNT(*) FROM audit_log WHERE action = 'unsubscribe.one_click'"),
    ).toBe(1);
  });
});

describe("başarısız ifade tekrarlanmaz; bağlantı güvenle yenilenir", () => {
  it.skipIf(unsafeTmp)(
    "meşgul hatası aynen iletilir, ifade uygulanmaz ve OTOMATİK yeniden çalıştırılmaz",
    async () => {
      await busyOnce(probeAudit);
      await app.client.execute("SELECT 1"); // yenileme bitene kadar bekler
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.probe'")).toBe(0);
      // Çağıran elle yeniden dener: tam bir kayıt oluşur (çift kayıt yok)
      await probeAudit(app.db);
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.probe'")).toBe(1);
    },
  );

  it.skipIf(unsafeTmp)("yenileme sonrası yabancı anahtar ve önbellek eki geri gelir", async () => {
    await busyOnce(probeAudit);
    const fk = await app.client.execute("PRAGMA foreign_keys");
    expect(Number(fk.rows[0]?.[0])).toBe(1);
    const dbs = await app.client.execute("PRAGMA database_list");
    expect(dbs.rows.map((r) => String(r.name))).toContain("gcache");
    const bt = await app.client.execute("PRAGMA busy_timeout");
    expect(Number(bt.rows[0]?.[0])).toBe(8000);
  });

  it.skipIf(unsafeTmp)(
    "eşzamanlı yenileme çağrıları tek yenilemede birleşir (yarış yok)",
    async () => {
      const spy = vi.spyOn(app.client, "reconnect");
      await busyOnce(probeAudit); // otomatik yenileme meşgul hatası anında başlar
      const [r1, r2] = await Promise.all([
        resetConnection(app.client, t.path),
        resetConnection(app.client, t.path),
        audit(app.db, "busy.race", "test", 1, {}, 3), // yenileme sürerken gelen çağrı beklemeli
      ]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.race'")).toBe(1);
    },
  );

  it.skipIf(unsafeTmp)(
    "açık işlem varken yenileme YAPILMAZ; işlem geri alınınca yapılır ve yarım kayıt kalmaz",
    async () => {
      const spy = vi.spyOn(app.client, "reconnect");
      const tx = await app.client.transaction("deferred");
      await tx.execute("SELECT COUNT(*) FROM audit_log"); // okuma anlık görüntüsü
      await tx
        .execute({
          sql: "INSERT INTO audit_log (at, action) VALUES (1, 'busy.txhalf')",
          args: [],
        })
        .catch(() => undefined);
      // Yazma kilidini başka bir bağlantı tutarken işlem içinde yazma: meşgul
      await tx.rollback();
      const h = await holdLock();
      await app.client.execute("PRAGMA busy_timeout = 150");
      const tx2 = await app.client.transaction("deferred");
      await tx2.execute("SELECT COUNT(*) FROM audit_log");
      let err: unknown;
      try {
        await tx2.execute({
          sql: "INSERT INTO audit_log (at, action) VALUES (1, 'busy.txhalf')",
          args: [],
        });
      } catch (e) {
        err = e;
      }
      expect(isBusyConnectionError(err)).toBe(true);
      const before = spy.mock.calls.length;
      expect(await resetConnection(app.client, t.path)).toBe(false); // açık işlem: yenileme yok
      expect(spy.mock.calls.length).toBe(before);
      await tx2.rollback();
      await h.release();
      await app.client.execute("SELECT 1"); // işlem bitince otomatik yenileme tamamlanır
      expect(spy.mock.calls.length).toBe(before + 1);
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.txhalf'")).toBe(0);
      // Yenilemeden sonra yazma sağlam
      await audit(app.db, "busy.after_tx", "test", 1, {}, 4);
      expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = 'busy.after_tx'")).toBe(1);
    },
  );

  it("izlenmeyen veya yolsuz istemci için otomatik yenileme yapılmaz (bellek içi güvenli)", async () => {
    const c = trackTransactions(createClient({ url: ":memory:" }), ":memory:");
    const spy = vi.spyOn(c, "reconnect");
    await expect(c.execute("SELECT nonexistent_table_x FROM nope")).rejects.toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    c.close();
  });

  it("isBusyConnectionError yalnızca meşgul/kilit hatalarını tanır", () => {
    expect(isBusyConnectionError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isBusyConnectionError({ message: "x", cause: { code: "SQLITE_BUSY" } })).toBe(true);
    expect(isBusyConnectionError(new Error("UNIQUE constraint failed"))).toBe(false);
    expect(isBusyConnectionError({ code: "TRANSACTION_ACTIVE", message: "tx" })).toBe(false);
    expect(isBusyConnectionError(null)).toBe(false);
  });
});

describe("düz kilit tutucu + eşzamanlı yazıcılar: sessiz veri kaybı yok", () => {
  it.skipIf(unsafeTmp)(
    "başarılı dönen her ekleme kalıcıdır; meşgul dönenler uygulanmamıştır",
    async () => {
      const b = await openDatabase(t.path); // ikinci uygulama bağlantısı (ayrı yazıcı)
      extra.push(b.client);
      const writers = [
        { name: "A", c: app.client },
        { name: "B", c: b.client },
      ];
      const ok: string[] = [];
      const busy: string[] = [];
      const ins = async (w: { name: string; c: Client }, id: string) => {
        try {
          await w.c.execute({
            sql: "INSERT INTO audit_log (at, action) VALUES (1, ?)",
            args: [id],
          });
          ok.push(id);
        } catch (e) {
          if (!isBusyConnectionError(e)) throw e;
          busy.push(id);
        }
      };
      for (let round = 0; round < 6; round++) {
        const h = await holdLock();
        for (const w of writers) await w.c.execute("PRAGMA busy_timeout = 100");
        for (const w of writers) await ins(w, `rw:${round}:${w.name}:busy`);
        await h.release();
        // Meşgul sonrası HEMEN sonraki yazmalar (sessiz kaybın görüldüğü nokta)
        for (let k = 0; k < 3; k++)
          for (const w of writers) await ins(w, `rw:${round}:${w.name}:ok${k}`);
      }
      expect(busy.length).toBe(12);
      expect(ok.length).toBe(36);
      for (const id of ok) {
        expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = ?", [id])).toBe(1);
      }
      for (const id of busy) {
        expect(await count("SELECT COUNT(*) FROM audit_log WHERE action = ?", [id])).toBe(0);
      }
      expect(fs.existsSync(t.path)).toBe(true);
    },
  );
});
