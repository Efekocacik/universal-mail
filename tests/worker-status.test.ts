import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_STATUS_FILENAME } from "@/lib/config/paths";
import { jobs } from "@/lib/db/schema";
import {
  RUNNING_FRESH_MS,
  STALE_JOB_MS,
  WATCHED_JOB_TYPES,
  getWorkerStatus,
} from "@/lib/jobs/worker-status";
import { INBOX_SYNC_JOB } from "@/lib/mail/scheduler/inbox-job";
import { MAIL_SEND_JOB } from "@/lib/mail/scheduler/job";
import { UNSUBSCRIBE_DRAIN_JOB } from "@/lib/unsubscribe/drain-job";
import { createTestDb, type TestDb } from "./helpers/db";

/** Arka plan işçisi canlılığı: veritabanından türetilen gecikme denetimi ve Electron çökme döngüsü kaydı. */

const NOW = 1_800_000_000_000;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const job = (over: Partial<typeof jobs.$inferInsert>) =>
  t.db.insert(jobs).values({
    type: MAIL_SEND_JOB,
    payload: {},
    status: "queued",
    runAt: NOW,
    createdAt: NOW - STALE_JOB_MS * 3,
    updatedAt: NOW - STALE_JOB_MS * 3,
    ...over,
  });

describe("işçi canlılığı", () => {
  it("izlenen iş türleri zamanlayıcı sabitleriyle aynıdır", () => {
    expect([...WATCHED_JOB_TYPES].sort()).toEqual(
      [MAIL_SEND_JOB, INBOX_SYNC_JOB, UNSUBSCRIBE_DRAIN_JOB].sort(),
    );
  });

  it("kuyruk boş veya iş yeni: sorun yok", async () => {
    expect(await getWorkerStatus(t.db, NOW)).toMatchObject({ ok: true, reason: null });
    await job({ runAt: NOW - STALE_JOB_MS + 1000 });
    expect((await getWorkerStatus(t.db, NOW)).ok).toBe(true);
  });

  it("10 dk'dan uzun bekleyen gönderim işi ve canlı işçi yok: overdue_jobs", async () => {
    await job({ runAt: NOW - STALE_JOB_MS - 5000 });
    await job({ type: UNSUBSCRIBE_DRAIN_JOB, runAt: NOW - STALE_JOB_MS - 1000 });
    // izlenmeyen tür sayılmaz
    await job({ type: "scan.run", runAt: NOW - STALE_JOB_MS * 2 });
    const s = await getWorkerStatus(t.db, NOW);
    expect(s).toMatchObject({
      ok: false,
      reason: "overdue_jobs",
      overdueJobs: 2,
      oldestOverdueAt: NOW - STALE_JOB_MS - 5000,
    });
  });

  it("işçi uzun bir işle meşgul (taze kalp atışı): uyarı yok; kalp atışı eskiyse uyarı", async () => {
    await job({ runAt: NOW - STALE_JOB_MS - 5000 });
    await job({ type: "scan.run", status: "running", lockedAt: NOW - 10_000, lockedBy: "w" });
    expect((await getWorkerStatus(t.db, NOW)).ok).toBe(true);
    expect((await getWorkerStatus(t.db, NOW + RUNNING_FRESH_MS)).reason).toBe("overdue_jobs");
  });

  it("Electron çökme döngüsü dosyası okunur; bozuk dosya yok sayılır", async () => {
    const file = path.join(t.dir, WORKER_STATUS_FILENAME);
    fs.writeFileSync(file, JSON.stringify({ v: 1, state: "crash_loop", at: NOW, restarts: 6 }));
    expect(await getWorkerStatus(t.db, NOW)).toMatchObject({
      ok: false,
      reason: "crash_loop",
      crashLoop: { at: NOW, restarts: 6 },
    });
    fs.writeFileSync(file, "{bozuk");
    expect((await getWorkerStatus(t.db, NOW)).ok).toBe(true);
  });

  it("Electron işçi yeniden başlatma politikası: sağlıklı çalışmada sayaç sıfırlanır, sınırdan sonra bırakılmaz", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron", "main.ts"), "utf8");
    expect(src).toContain("WORKER_HEALTHY_RESET_MS");
    expect(src).toContain("WORKER_SLOW_RETRY_MS");
    expect(src).not.toContain("yeniden başlatılmıyor");
    expect(src).toContain("writeWorkerStatus(");
    const worker = fs.readFileSync(path.join(__dirname, "..", "src", "worker", "index.ts"), "utf8");
    expect(worker).toContain('process.on("unhandledRejection"');
    const shell = fs.readFileSync(
      path.join(__dirname, "..", "src", "components", "app-shell.tsx"),
      "utf8",
    );
    expect(shell).toContain("<WorkerStatusBanner />");
  });
});
