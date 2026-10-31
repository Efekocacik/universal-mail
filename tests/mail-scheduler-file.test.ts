import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLibsqlUrl } from "@/lib/config/paths";
import { resetConnection, trackTransactions, type Db } from "@/lib/db/client";
import { jobs, messages } from "@/lib/db/schema";
import { FakeMailProvider } from "@/lib/mail/provider/fake-provider";
import { MailDispatcher } from "@/lib/mail/scheduler/dispatcher";
import { scheduleDispatch } from "@/lib/mail/scheduler/job";
import { sendCampaignStep } from "@/lib/mail/send-service";
import {
  addSequence,
  createCampaign,
  MIGRATIONS,
  seedBase,
  T0,
  wrap,
} from "./helpers/campaign-fixture";

/**
 * Dosya tabanlı veritabanında eşzamanlılık: aynı GEÇİCİ dosyaya iki ayrı bağlantı ve (Linux'ta) iki gerçek süreç.
 * Gerçek `.data` veritabanı kullanılmaz.
 *
 * Not: aynı süreçteki iki bağlantı birbirini beklerken libsql'in eşzamanlı (bloklayan) meşgul beklemesi olay döngüsünü
 * durdurur; bu yüzden bu testlerde meşgul bekleme süresi kısa tutulur ve `busy` sonucu kabul edilir. Gerçek çok
 * süreçli kullanım ayrıca iki gerçek süreçle doğrulanır.
 *
 * Windows'ta Türkçe karakter içeren geçici dizinlerde Node'un dosya silme hatası süreci düşürebildiği (bilinen
 * sorun; macOS/Linux'u etkilemez) için bu dosya o durumda atlanır. İki süreçli test yalnızca Linux'ta (CI) çalışır.
 */

const unsafeTmp = process.platform === "win32" && /[^\x20-\x7e]/.test(os.tmpdir());
const REPO = path.resolve(__dirname, "..");

let dir: string;
let file: string;
const clients: Client[] = [];

async function connect(busyTimeoutMs = 300): Promise<{ client: Client; db: Db }> {
  // Uygulamanın bağlantı ayarlarıyla aynı: tek bağlantı ve meşgul bekleme süresi (bkz. src/lib/db/client.ts).
  const client = trackTransactions(
    createClient({ url: toLibsqlUrl(file), concurrency: 1, timeout: busyTimeoutMs }),
  );
  clients.push(client);
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return { client, db: wrap(client) };
}

describe.skipIf(unsafeTmp)("dosya tabanlı veritabanı: iki bağlantı", () => {
  let A: Db;
  let B: Db;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-sched-"));
    file = path.join(dir, "test.sqlite");
    A = (await connect()).db;
    await migrate(A, { migrationsFolder: MIGRATIONS });
    await seedBase(A);
    B = (await connect()).db;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* geçici dizin; işletim sistemi temizler */
    }
  });

  it("iki bağlantıdan aynı adım için eşzamanlı ayırmada yalnızca biri gönderir", async () => {
    const c = await createCampaign(A, { steps: 1 });
    const { cl } = await addSequence(A, c);
    const p = new FakeMailProvider({ script: [{ kind: "accept", delayMs: 30 }], now: () => T0 });
    const results = await Promise.all(
      [A, B, A, B].map((db) =>
        sendCampaignStep(db, { campaignLeadId: cl, stepIndex: 0 }, { provider: p, now: () => T0 }),
      ),
    );
    expect(results.filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(p.calls).toBe(1);
    expect(await A.select().from(messages)).toHaveLength(1);
  });

  it("başka bağlantı yazma kilidini tutarken sonuç busy; kayıt açılmaz, sağlayıcı çağrılmaz", async () => {
    const c = await createCampaign(A, { steps: 1 });
    const { cl } = await addSequence(A, c);
    const { client: lockHolder } = await connect();
    const { client: impatientClient, db: impatient } = await connect(100);
    const tx = await lockHolder.transaction("write");
    await tx.execute("UPDATE settings SET updated_at = updated_at");
    const p = new FakeMailProvider({ now: () => T0 });
    const r = await sendCampaignStep(
      impatient,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: () => T0 },
    );
    expect(r.outcome).toBe("busy");
    expect(p.calls).toBe(0);
    await tx.rollback();
    expect(await A.select().from(messages)).toHaveLength(0);
    // libsql: meşgul hatasından sonra bağlantı yenilenmeden işlem COMMIT edilemez (worker'da `onBusy`).
    await resetConnection(impatientClient, file);
    const again = await sendCampaignStep(
      impatient,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: () => T0 },
    );
    expect(again.outcome).toBe("sent");
  });

  it("dağıtım işi iki bağlantıdan eşzamanlı planlansa da tek olur", async () => {
    const results = await Promise.allSettled([
      scheduleDispatch(A, { runAt: T0, now: T0 }),
      scheduleDispatch(B, { runAt: T0, now: T0 }),
      scheduleDispatch(A, { runAt: T0, now: T0 }),
    ]);
    const created = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(created).toHaveLength(1);
    // Diğerleri ya "zaten var" (null) ya da meşgul hatası; ikinci iş hiçbir durumda oluşmaz.
    for (const r of results) {
      if (r.status === "rejected")
        expect(String(r.reason?.cause ?? r.reason)).toMatch(/BUSY|locked|TRANSACTION_ACTIVE/i);
    }
    expect(await A.select().from(jobs)).toHaveLength(1);
  });

  it("iki bağlantıdaki iki dağıtıcı dönüşümlü: her adım tam bir kez, bekleme süreleri korunur", async () => {
    const c = await createCampaign(A, { steps: 1 });
    for (let i = 0; i < 6; i++) await addSequence(A, c);
    const pa = new FakeMailProvider({ now: () => T0 });
    const pb = new FakeMailProvider({ now: () => T0 });
    const [da, db] = [new MailDispatcher(A), new MailDispatcher(B)];
    // Aynı süreçte sırayla (gerçek eşzamanlılık aşağıdaki iki süreçli testte): her bağlantı diğerinin yazdığını görür.
    for (let i = 0; i < 80; i++) {
      const t = T0 + i * 30_000;
      await da.dispatchOnce({ now: () => t, provider: pa });
      await db.dispatchOnce({ now: () => t, provider: pb });
    }
    const rows = await A.select().from(messages).orderBy(messages.createdAt);
    expect(rows).toHaveLength(6);
    expect(pa.calls + pb.calls).toBe(6);
    expect(new Set(rows.map((m) => m.idempotencyKey)).size).toBe(6);
    expect(rows.every((m) => m.status === "sent")).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.createdAt - rows[i - 1]!.createdAt).toBeGreaterThanOrEqual(90_000);
    }
  });
});

describe.skipIf(unsafeTmp)("bağlantı yenileme (resetConnection) ve gönderim güvenliği", () => {
  let client: Client;
  let A: Db;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-reset-"));
    file = path.join(dir, "test.sqlite");
    ({ client, db: A } = await connect());
    await migrate(A, { migrationsFolder: MIGRATIONS });
    await seedBase(A);
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* geçici dizin */
    }
  });

  async function pragmas() {
    const fk = await client.execute("PRAGMA foreign_keys");
    const dbs = await client.execute("PRAGMA database_list");
    return {
      foreignKeys: Number(fk.rows[0]?.[0]),
      attached: dbs.rows.map((r) => String(r.name)),
    };
  }

  it("yenilemeden sonra ayarlar geri gelir: yabancı anahtarlar açık, önbellek ekli", async () => {
    await resetConnection(client, file);
    expect(await pragmas()).toMatchObject({ foreignKeys: 1 });
    expect((await pragmas()).attached).toContain("gcache");
    await expect(resetConnection(client, ":memory:")).rejects.toThrow(/Bellek içi/);
    const untracked = createClient({ url: toLibsqlUrl(file) });
    clients.push(untracked);
    await expect(resetConnection(untracked, file)).rejects.toThrow(/izlenmeyen/);
  });

  it("gönderimden sonra yenileme aynı adımı yeniden göndermez", async () => {
    const c = await createCampaign(A, { steps: 2 });
    const { cl } = await addSequence(A, c);
    const p = new FakeMailProvider({ now: () => T0 });
    const d = new MailDispatcher(A);
    expect((await d.dispatchOnce({ now: () => T0, provider: p })).send?.outcome).toBe("sent");
    for (let i = 1; i <= 20; i++) {
      await resetConnection(client, file);
      const t = T0 + i * 10 * 60_000;
      await d.dispatchOnce({ now: () => t, provider: p });
      await new MailDispatcher(A).dispatchOnce({ now: () => t, provider: p });
    }
    expect(p.calls).toBe(1);
    const rows = await A.select().from(messages);
    expect(rows.map((m) => [m.campaignLeadId, m.stepIndex, m.status])).toEqual([[cl, 0, "sent"]]);
  });

  it("açık işlem varken yenileme yapılmaz (kilit sızmaz); işlem normal biter, sonra tek gönderim", async () => {
    const c = await createCampaign(A, { steps: 1 });
    const { cl } = await addSequence(A, c);
    const p = new FakeMailProvider({ now: () => T0 });
    await A.transaction(async (tx) => {
      await tx.insert(jobs).values({
        type: "x",
        payload: {},
        status: "queued",
        runAt: 0,
        createdAt: 0,
        updatedAt: 0,
      });
      // Eşzamanlı bir yenileme isteği: açık işlem olduğu için reddedilir.
      expect(await resetConnection(client, file)).toBe(false);
      await tx.select().from(jobs);
    });
    expect(await A.select().from(jobs)).toHaveLength(1);
    // Başarısız (geri alınan) işlemden sonra da sayaç sıfırlanır; yenileme artık yapılır.
    await expect(
      A.transaction(async () => {
        throw new Error("geri al");
      }),
    ).rejects.toThrow("geri al");
    expect(await resetConnection(client, file)).toBe(true);
    expect((await pragmas()).foreignKeys).toBe(1);

    const r = await sendCampaignStep(
      A,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: () => T0 },
    );
    expect(r.outcome).toBe("sent");
    expect(p.calls).toBe(1);
  });

  it("sağlayıcı çağrısı sürerken yenileme: sonuç yeni bağlantıyla kaydedilir, ileti bir kez gider", async () => {
    const c = await createCampaign(A, { steps: 1 });
    const { cl } = await addSequence(A, c);
    const inner = new FakeMailProvider({ now: () => T0 });
    const p = {
      id: "demo" as const,
      send: async (input: Parameters<FakeMailProvider["send"]>[0]) => {
        await resetConnection(client, file); // gönderim işlem dışında; açık işlem yok
        return inner.send(input);
      },
    };
    const r = await sendCampaignStep(
      A,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: () => T0 },
    );
    expect(r).toMatchObject({ outcome: "sent" });
    expect(r.outcome === "sent" && r.recordError).toBeFalsy();
    expect(inner.calls).toBe(1);
    const again = await sendCampaignStep(
      A,
      { campaignLeadId: cl, stepIndex: 0 },
      { provider: p, now: () => T0 + 60 * 60_000 },
    );
    expect(again.outcome).toBe("ineligible");
    expect(inner.calls).toBe(1);
  });

  it("meşgul hatasıyla bozulan bağlantı yenilenmeden kayıt yazamaz; yenileme sonrası tek gönderim", async () => {
    const c = await createCampaign(A, { steps: 1 });
    await addSequence(A, c);
    const { client: holder } = await connect();
    const tx = await holder.transaction("write");
    await tx.execute("UPDATE settings SET updated_at = updated_at");
    const p = new FakeMailProvider({ now: () => T0 });
    const d = new MailDispatcher(A);
    const busy = await d.dispatchOnce({ now: () => T0, provider: p });
    expect(busy.busy).toBe(true);
    expect(p.calls).toBe(0);
    await tx.rollback();
    await resetConnection(client, file); // worker'da `onBusy`
    for (let i = 0; i < 10; i++) {
      const t = T0 + i * 5 * 60_000;
      await d.dispatchOnce({ now: () => t, provider: p });
    }
    expect(p.calls).toBe(1);
    expect(await A.select().from(messages)).toHaveLength(1);
  });
});

function runChild(args: string[]): Promise<{ calls: number; counts: Record<string, number> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(REPO, "tests", "helpers", "dispatch-child.ts"), ...args],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(JSON.parse(out));
      else reject(new Error(`alt süreç ${code}: ${err.slice(0, 2000)}`));
    });
  });
}

describe.skipIf(unsafeTmp || process.platform !== "linux")("iki gerçek süreç (Linux/CI)", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-sched-proc-"));
    file = path.join(dir, "test.sqlite");
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* geçici dizin */
    }
  });

  it("iki süreç aynı veritabanında dağıtıcı çalıştırsa da her adım tam bir kez gönderilir", async () => {
    const { db } = await connect();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await seedBase(db);
    const c = await createCampaign(db, { steps: 1 });
    for (let i = 0; i < 6; i++) await addSequence(db, c);

    const args = [file, String(T0), "80", "30000"];
    const [a, b] = await Promise.all([runChild(args), runChild(args)]);

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(6);
    expect(a.calls + b.calls).toBe(6); // her sağlayıcı çağrısı tam bir kayda karşılık gelir
    expect(new Set(rows.map((m) => m.idempotencyKey)).size).toBe(6);
    expect(rows.every((m) => m.status === "sent")).toBe(true);
    const times = rows.map((m) => m.createdAt).sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90_000);
    }
  }, 120_000);
});
