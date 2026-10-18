import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { openDatabase } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { runMigrations } from "@/lib/db/migrate";
import { jobs, scans } from "@/lib/db/schema";
import { claimNextJob, completeJob, countJobs, enqueueJob, failJob, pruneFinishedJobs } from "@/lib/jobs/queue";
import { clearJobHandlers, NonRetryableJobError, registerJobHandler } from "@/lib/jobs/registry";
import { createAndStartScan } from "@/lib/scan/service";
import { categorySets } from "@/lib/db/schema";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { setSetting } from "@/lib/settings";
import { Worker } from "@/worker/loop";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let db: Db;

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  clearJobHandlers();
});

afterEach(async () => {
  await t.cleanup();
});

describe("iş kuyruğu", () => {
  it("işleri öncelik ve sıraya göre kilitler; aynı işi iki kez vermez", async () => {
    const low = await enqueueJob(db, "x", { n: 1 });
    const high = await enqueueJob(db, "x", { n: 2 }, { priority: 5 });
    const a = await claimNextJob(db, "w1");
    expect(a?.id).toBe(high);
    expect(a?.status).toBe("running");
    expect(a?.attempts).toBe(1);
    const b = await claimNextJob(db, "w2");
    expect(b?.id).toBe(low);
    expect(await claimNextJob(db, "w3")).toBeNull();
  });

  it("dedupeKey tekrarlı eklemeyi engeller", async () => {
    expect(await enqueueJob(db, "x", {}, { dedupeKey: "k" })).not.toBeNull();
    expect(await enqueueJob(db, "x", {}, { dedupeKey: "k" })).toBeNull();
    expect(await countJobs(db, "queued")).toBe(1);
  });

  it("gelecekteki runAt olan iş henüz alınmaz", async () => {
    await enqueueJob(db, "x", {}, { runAt: Date.now() + 60_000 });
    expect(await claimNextJob(db, "w")).toBeNull();
    expect(await claimNextJob(db, "w", Date.now() + 61_000)).not.toBeNull();
  });

  it("başarısız iş gecikmeyle yeniden denenir, hak bitince 'failed' olur", async () => {
    await enqueueJob(db, "x", {}, { maxAttempts: 2 });
    const j1 = (await claimNextJob(db, "w"))!;
    expect(await failJob(db, j1, "boom", 1000)).toBe("queued");
    expect(await claimNextJob(db, "w")).toBeNull(); // gecikme dolmadı
    const j2 = (await claimNextJob(db, "w", Date.now() + 5000))!;
    expect(j2.attempts).toBe(2);
    expect(await failJob(db, j2, "boom again")).toBe("failed");
    const row = (await db.select().from(jobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("boom again");
  });

  it("bitmiş eski kayıtlar temizlenir", async () => {
    await enqueueJob(db, "x", {});
    const j = (await claimNextJob(db, "w"))!;
    await completeJob(db, j.id, Date.now() - 40 * 86_400_000);
    await pruneFinishedJobs(db);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });
});

describe("işçi döngüsü", () => {
  it("kayıtlı işleyiciyi çalıştırır ve işi tamamlar", async () => {
    const seen: unknown[] = [];
    registerJobHandler("echo", async (ctx) => {
      seen.push(ctx.payload);
    });
    await enqueueJob(db, "echo", { hello: "world" });
    const w = new Worker({ db, workerId: "t", log: () => undefined });
    expect(await w.tick()).toBe(true);
    expect(seen).toEqual([{ hello: "world" }]);
    expect((await db.select().from(jobs))[0]!.status).toBe("done");
    expect(await w.tick()).toBe(false);
  });

  it("işleyici hata verirse yeniden dener; NonRetryable ise hemen bitirir", async () => {
    registerJobHandler("flaky", async () => {
      throw new Error("geçici");
    });
    registerJobHandler("fatal", async () => {
      throw new NonRetryableJobError("kalıcı");
    });
    await enqueueJob(db, "flaky", {}, { maxAttempts: 3 });
    await enqueueJob(db, "fatal", {}, { maxAttempts: 3 });
    const w = new Worker({ db, workerId: "t", log: () => undefined });
    await w.tick();
    await w.tick();
    const rows = await db.select().from(jobs);
    expect(rows.find((r) => r.type === "flaky")?.status).toBe("queued");
    expect(rows.find((r) => r.type === "fatal")?.status).toBe("failed");
  });

  it("bilinmeyen iş türü başarısız olur", async () => {
    await enqueueJob(db, "yok", {});
    await new Worker({ db, workerId: "t", log: () => undefined }).tick();
    const row = (await db.select().from(jobs))[0]!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("Bilinmeyen iş türü");
  });

  it("açılışta kurtarma: çalışıyor görünen tarama duraklatılır, diğer işler yeniden kuyruğa girer, kuyruktaki taramaya iş eklenir", async () => {
    await initDatabase();
    await setSetting(db, "places.provider", "mock");
    const cats = (await db.select().from(categorySets)).filter((c) => c.key === "cafe").map((c) => c.id);
    const { scanId } = await createAndStartScan(db, {
      region: { kind: "city", name: "London", bbox: bboxFromCenter(51.5085, -0.1257, 2) },
      categoryIds: cats,
    });
    // Çökme simülasyonu: iş kilitli, tarama "çalışıyor"
    const scanJob = (await claimNextJob(db, "eski-işçi"))!;
    await db.update(scans).set({ status: "running" }).where(eq(scans.id, scanId));
    await enqueueJob(db, "other", {});
    const other = (await claimNextJob(db, "eski-işçi"))!;

    await new Worker({ db, workerId: "yeni", log: () => undefined }).recover();

    expect((await db.select().from(jobs).where(eq(jobs.id, scanJob.id)))[0]!.status).toBe("cancelled");
    expect((await db.select().from(jobs).where(eq(jobs.id, other.id)))[0]!.status).toBe("queued");
    const scan = (await db.select().from(scans).where(eq(scans.id, scanId)))[0]!;
    expect(scan.status).toBe("paused");
    expect(scan.pauseReason).toContain("devam");
  });

  it("kuyrukta kalan taramanın kayıp işi yeniden eklenir", async () => {
    await initDatabase();
    await setSetting(db, "places.provider", "mock");
    const cats = (await db.select().from(categorySets)).filter((c) => c.key === "cafe").map((c) => c.id);
    const { scanId } = await createAndStartScan(db, {
      region: { kind: "city", name: "London", bbox: bboxFromCenter(51.5085, -0.1257, 2) },
      categoryIds: cats,
    });
    await db.delete(jobs);
    await new Worker({ db, workerId: "w", log: () => undefined }).recover();
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "scan.run", status: "queued" });
    expect(JSON.stringify(rows[0]!.payload)).toContain(String(scanId));
  });
});

describe("şema geçişi ve yedek", () => {
  /** Gerçek migrasyon klasörünün kopyasına, SQL'i verilen ikinci bir migrasyon ekler. */
  function folderWithExtraMigration(sql: string): string {
    const src = process.env.UM_MIGRATIONS_DIR!;
    const dst = path.join(t.dir, "migrations-v2");
    fs.cpSync(src, dst, { recursive: true });
    const journalPath = path.join(dst, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Record<string, unknown>[] };
    journal.entries.push({ idx: 1, version: "6", when: Date.now() + 1000, tag: "0001_test", breakpoints: true });
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    fs.writeFileSync(path.join(dst, "0001_test.sql"), sql);
    return dst;
  }

  it("temiz veritabanına migrasyon uygulanır; ilk kurulumda yedek alınmaz", async () => {
    const handle = await openDatabase(t.path);
    const rows = (await handle.client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name));
    for (const name of ["settings", "regions", "category_sets", "scans", "scan_units", "places", "place_snapshots", "leads", "api_usage", "jobs", "audit_log"]) {
      expect(rows).toContain(name);
    }
    expect(fs.existsSync(path.join(t.dir, "backups"))).toBe(false);
    handle.client.close();
  });

  it("veri varken bekleyen migrasyon uygulanmadan önce yedek alınır; yedekte eski şema vardır", async () => {
    await setSetting(db, "budget.monthlyUsd", 42);
    process.env.UM_MIGRATIONS_DIR = folderWithExtraMigration("CREATE TABLE `lead_emails_test` (`id` integer PRIMARY KEY NOT NULL);");
    const handle = await openDatabase(t.path);
    const res = await runMigrations(handle.db, handle.client);
    expect(res.pending).toBe(1);
    expect(res.backupPath).toBeDefined();
    expect(fs.existsSync(res.backupPath!)).toBe(true);

    // Yeni tablo ana veritabanında var, yedekte yok; mevcut veri korunmuş.
    const main = (await handle.client.execute("SELECT name FROM sqlite_master WHERE name='lead_emails_test'")).rows;
    expect(main).toHaveLength(1);
    const backup = await openDatabase(res.backupPath!);
    expect((await backup.client.execute("SELECT name FROM sqlite_master WHERE name='lead_emails_test'")).rows).toHaveLength(0);
    expect((await backup.client.execute("SELECT value FROM settings WHERE key='budget.monthlyUsd'")).rows).toHaveLength(1);
    backup.client.close();
    handle.client.close();

    // Tekrar çalıştırmak bir şey yapmaz
    const again = await openDatabase(t.path);
    expect((await runMigrations(again.db, again.client)).pending).toBe(0);
    again.client.close();
  });

  it("hatalı migrasyon veriyi bozmaz: yedek yerinde, ana veritabanı eski halde", async () => {
    await setSetting(db, "budget.monthlyUsd", 42);
    process.env.UM_MIGRATIONS_DIR = folderWithExtraMigration("CREATE TABLE `ok_table` (`id` integer);\n--> statement-breakpoint\nTHIS IS NOT SQL;");
    const handle = await openDatabase(t.path);
    await expect(runMigrations(handle.db, handle.client)).rejects.toThrow();
    const tables = (await handle.client.execute("SELECT name FROM sqlite_master WHERE name='ok_table'")).rows;
    expect(tables).toHaveLength(0); // işlem geri alındı
    expect((await handle.client.execute("SELECT value FROM settings WHERE key='budget.monthlyUsd'")).rows).toHaveLength(1);
    expect(fs.readdirSync(path.join(t.dir, "backups")).some((f) => f.startsWith("pre-migrate-"))).toBe(true);
    handle.client.close();
  });
});
