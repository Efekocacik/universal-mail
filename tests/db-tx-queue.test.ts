import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as settingsRoute from "@/app/api/settings/route";
import * as statusRoute from "@/app/api/status/route";
import { getDb, openDatabase, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { settings } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Süreç içi işlem kapısı (client.ts `trackTransactions`): libsql tek bağlantıda (concurrency=1) açık bir işlem varken
 * gelen her çağrıyı BEKLEMEDEN `TRANSACTION_ACTIVE` ile reddeder. Kapı bu çağrıları işlem bitene kadar sıraya alır;
 * işlem içinden dış bağlantı kullanımı ise kilitlenme yerine hemen başarısız olur.
 */

let t: TestDb;
const opened: Array<{ client: { close(): void } }> = [];

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  for (const h of opened.splice(0)) h.client.close();
  await t.cleanup();
});

/** Hata veya `cause` zincirinde TRANSACTION_ACTIVE kodu var mı (drizzle sorgu hatasını sarar)? */
async function txActive(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    for (let cur: any = e; cur; cur = cur.cause) if (cur.code === "TRANSACTION_ACTIVE") return true;
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fresh(opts: { txWaitMs?: number } = {}): Promise<Db> {
  const h = await openDatabase(t.path, opts);
  opened.push(h);
  return h.db;
}

async function value(db: Db, key: string): Promise<unknown> {
  const rows = await db
    .select({ v: settings.value })
    .from(settings)
    .where(sql`${settings.key} = ${key}`);
  return rows[0]?.v;
}

describe("işlem kapısı", () => {
  it("işlem sürerken gelen sorgu reddedilmez; commit sonrası çalışır ve yazılanı görür", async () => {
    const db = await fresh();
    let inside!: () => void;
    const started = new Promise<void>((r) => (inside = r));
    const tx = db.transaction(async (tx) => {
      await tx.insert(settings).values({ key: "kapi.a", value: 1, updatedAt: Date.now() });
      inside();
      await sleep(50);
    });
    await started;
    const read = value(db, "kapi.a"); // eskiden: TRANSACTION_ACTIVE
    await tx;
    await expect(read).resolves.toBe(1);
  });

  it("iki eşzamanlı işlem sırayla ikisi de commit edilir", async () => {
    const db = await fresh();
    const order: string[] = [];
    const run = (k: string) =>
      db.transaction(async (tx) => {
        order.push(`${k}:start`);
        await tx.insert(settings).values({ key: k, value: "x", updatedAt: Date.now() });
        await sleep(20);
        order.push(`${k}:end`);
      });
    await Promise.all([run("kapi.b"), run("kapi.c")]);
    expect(await value(db, "kapi.b")).toBe("x");
    expect(await value(db, "kapi.c")).toBe("x");
    // birbirine geçmezler
    expect(order.indexOf("kapi.b:end") + 1).toBe(order.indexOf("kapi.c:start"));
  });

  it("işlem geri çağrısı içinde dış bağlantı kullanımı beklemeden TRANSACTION_ACTIVE ile reddedilir", async () => {
    const db = await fresh();
    const t0 = Date.now();
    expect(
      await txActive(
        db.transaction(async () => {
          await db.select().from(settings);
        }),
      ),
    ).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
    // iç içe dış işlem de aynı
    expect(
      await txActive(
        db.transaction(async () => {
          await db.transaction(async () => undefined);
        }),
      ),
    ).toBe(true);
    // kapı kilitli kalmaz
    await expect(db.select().from(settings)).resolves.toBeDefined();
  });

  it("takılı işlem: bekleyenler süre dolunca TRANSACTION_ACTIVE ile reddedilir; işlem bitince kapı açılır", async () => {
    const db = await fresh({ txWaitMs: 80 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inside!: () => void;
    const started = new Promise<void>((r) => (inside = r));
    const tx = db.transaction(async () => {
      inside();
      await hold;
    });
    await started;
    expect(await txActive(db.select().from(settings))).toBe(true);
    expect(await txActive(db.transaction(async () => undefined))).toBe(true);
    release();
    await tx;
    await expect(db.select().from(settings)).resolves.toBeDefined();
  });

  it("rota düzeyi: ayar PUT işlemi ile eşzamanlı GET /api/status 503 vermez", async () => {
    await initDatabase();
    await getDb();
    const ORIGIN = "http://127.0.0.1:3000";
    const req = (method: string, url: string, body?: unknown) =>
      new Request(`${ORIGIN}${url}`, {
        method,
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "127.0.0.1:3000" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const results = await Promise.all([
      settingsRoute.PUT(req("PUT", "/api/settings", { "ui.language": "en" }), undefined),
      statusRoute.GET(req("GET", "/api/status"), undefined),
      settingsRoute.PUT(req("PUT", "/api/settings", { "ui.language": "tr" }), undefined),
      statusRoute.GET(req("GET", "/api/status"), undefined),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });
});
