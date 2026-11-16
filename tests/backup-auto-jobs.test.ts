import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_AUTO_JOB,
  enqueueWeeklyIfDue,
  isoWeekKey,
  localDayKey,
  makeAutoBackupHandler,
  enqueueStartupIfDue,
  onWorkerStarted,
} from "@/lib/backup/auto";
import { createBackup } from "@/lib/backup/service";
import { backups, jobs, notifications } from "@/lib/db/schema";
import type { JobRow } from "@/lib/jobs/queue";
import { NonRetryableJobError } from "@/lib/jobs/registry";
import { BACKUP_PASSPHRASE_SECRET, setSecret } from "@/lib/secrets/store";
import { getSetting, setSetting } from "@/lib/settings";
import { runHousekeeping } from "@/worker/housekeeping";
import { backupEnv, TEST_PASS, type BackupEnv } from "./helpers/backup-env";

/**
 * Paket Y.4: otomatik yedekler. Açılış yedeği yerel günde bir; haftalık yedek 7 günde bir (ISO haftası tekil);
 * parola yoksa hiçbir şey; kapatılmışsa işleyici atlar; hata bildirimi günde bir; parola/klasör hatası yeniden
 * denenmez; başka yedek sürüyorsa atlanır.
 */

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 16, 10, 0, 0).getTime();
let env: BackupEnv;

const autoJobs = () => env.db.select().from(jobs).where(eq(jobs.type, BACKUP_AUTO_JOB));
const ctx = (payload: unknown, logs: string[] = []) => ({
  job: { id: 1 } as JobRow,
  payload: payload as never,
  db: env.db,
  shouldStop: () => false,
  log: (m: string) => logs.push(m),
});

beforeEach(async () => {
  env = await backupEnv();
});
afterEach(async () => {
  await env.done();
});

describe("anahtarlar", () => {
  it("yerel gün ve ISO haftası", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
    expect(isoWeekKey(new Date(2026, 0, 1).getTime())).toBe("2026-W01");
    expect(isoWeekKey(new Date(2027, 0, 1).getTime())).toBe("2026-W53");
    expect(isoWeekKey(new Date(2026, 10, 16).getTime())).toBe("2026-W47");
  });
});

describe("açılış yedeği", () => {
  it("parola yoksa kuyruğa hiçbir şey eklenmez (ayar açık olsa da)", async () => {
    expect(await enqueueStartupIfDue(env.db, { now: NOW })).toBeNull();
    expect(await enqueueWeeklyIfDue(env.db, { now: NOW })).toBeNull();
    expect(await autoJobs()).toEqual([]);
  });

  it("günde bir kez; bugün başarılı açılış yedeği varsa eklenmez; kapalıysa eklenmez", async () => {
    await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
    // İşçi dikişi (imza P0'daki gibi `Promise<void>`) işi ekler; aynı gün ikinci çağrı tekildir.
    await expect(onWorkerStarted(env.db, { now: NOW })).resolves.toBeUndefined();
    expect(await autoJobs()).toHaveLength(1);
    expect(await enqueueStartupIfDue(env.db, { now: NOW + 3_600_000 })).toBeNull(); // aynı gün: tekil
    const [job] = await autoJobs();
    expect(job!.dedupeKey).toBe(`backup.auto:startup:${localDayKey(NOW)}`);
    expect(job!.payload).toEqual({ reason: "startup" });
    await createBackup(env.db, { kind: "startup", now: NOW + DAY });
    expect(await enqueueStartupIfDue(env.db, { now: NOW + DAY + 1000 })).toBeNull();
    const s = await getSetting(env.db, "backup.schedule");
    await setSetting(env.db, "backup.schedule", { ...s, onStartup: false });
    expect(await enqueueStartupIfDue(env.db, { now: NOW + 3 * DAY })).toBeNull();
    await setSetting(env.db, "backup.schedule", { ...s, auto: false });
    expect(await enqueueStartupIfDue(env.db, { now: NOW + 3 * DAY })).toBeNull();
  });
});

describe("haftalık yedek (bakım turu)", () => {
  it("hiç yoksa veya son başarılı haftalık 7 günden eskiyse eklenir; haftada bir", async () => {
    await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
    const r = await runHousekeeping(env.db, { now: NOW });
    expect(r.lifecycle).toContain(BACKUP_AUTO_JOB);
    expect(r.errors).toEqual([]);
    expect((await runHousekeeping(env.db, { now: NOW + 6 * 3_600_000 })).lifecycle).not.toContain(
      BACKUP_AUTO_JOB,
    );
    await createBackup(env.db, { kind: "weekly", now: NOW + DAY });
    expect(await enqueueWeeklyIfDue(env.db, { now: NOW + 7 * DAY })).toBeNull(); // 6 gün geçti
    expect(await enqueueWeeklyIfDue(env.db, { now: NOW + 8 * DAY + 1 })).not.toBeNull();
    const keys = (await autoJobs()).map((j) => j.dedupeKey);
    expect(keys).toEqual([
      `backup.auto:weekly:${isoWeekKey(NOW)}`,
      `backup.auto:weekly:${isoWeekKey(NOW + 8 * DAY + 1)}`,
    ]);
  });
});

describe("işleyici", () => {
  it("yedeği alır; döndürme ayarı uygulanır; kapalıysa veya bugün zaten alınmışsa atlar", async () => {
    await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
    let now = NOW;
    const handler = makeAutoBackupHandler({}, () => now);
    const logs: string[] = [];
    await handler(ctx({ reason: "startup" }, logs));
    expect(logs[0]).toMatch(/otomatik yedek alındı/);
    await handler(ctx({ reason: "startup" })); // aynı gün ikinci çalıştırma: atlanır
    expect(await env.db.select().from(backups)).toHaveLength(1);
    now = NOW + DAY;
    await handler(ctx({ reason: "weekly" }));
    expect((await env.db.select().from(backups)).map((b) => b.kind).sort()).toEqual([
      "startup",
      "weekly",
    ]);
    const s = await getSetting(env.db, "backup.schedule");
    await setSetting(env.db, "backup.schedule", { ...s, weekly: false });
    now = NOW + 9 * DAY;
    const skip: string[] = [];
    await handler(ctx({ reason: "weekly" }, skip));
    expect(skip[0]).toMatch(/kapatıldı/);
    await expect(handler(ctx({ reason: "aylık" }))).rejects.toBeInstanceOf(NonRetryableJobError);
  });

  it("parola silinmişse: bildirim günde bir, yeniden denenmez", async () => {
    const handler = makeAutoBackupHandler({}, () => NOW);
    await expect(handler(ctx({ reason: "startup" }))).rejects.toBeInstanceOf(NonRetryableJobError);
    await expect(handler(ctx({ reason: "weekly" }))).rejects.toBeInstanceOf(NonRetryableJobError);
    const n = await env.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, "backup.failed"));
    expect(n).toHaveLength(1);
    expect(n[0]!.params).toEqual({ code: "BACKUP_PASSPHRASE_REQUIRED" });
    expect(n[0]!.url).toBe("/settings");
  });

  it("geçici hata yeniden denenir (NonRetryable değil); başka yedek sürüyorsa bildirimsiz yeniden denenir", async () => {
    await setSecret(BACKUP_PASSPHRASE_SECRET, TEST_PASS);
    const broken = makeAutoBackupHandler(
      {
        createWriter: () => {
          throw new Error("beklenmeyen");
        },
      },
      () => NOW,
    );
    const err = await broken(ctx({ reason: "weekly" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableJobError);
    expect((await env.db.select().from(notifications))[0]!.params).toEqual({
      code: "BACKUP_FAILED",
    });
    await env.db.insert(backups).values({
      kind: "manual",
      status: "running",
      fileName: "universal-mail-20261116-095900-manual.umbk",
      folder: env.dir,
      appVersion: "0.1.0",
      schemaMigrations: 7,
      createdAt: NOW - 60_000,
    });
    const logs: string[] = [];
    const notifsBefore = (await env.db.select().from(notifications)).length;
    // Başarı sayılmaz (günün tekilleştirme anahtarı harcanmasın): yeniden denenebilir hata, bildirim yok.
    const busy = await makeAutoBackupHandler(
      {},
      () => NOW,
    )(ctx({ reason: "weekly" }, logs)).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(Error);
    expect(busy).not.toBeInstanceOf(NonRetryableJobError);
    expect(logs[0]).toMatch(/başka bir yedek sürüyor/);
    expect((await env.db.select().from(notifications)).length).toBe(notifsBefore);
    expect(
      fs.readdirSync(path.join(env.dir, "backups")).filter((f) => f.endsWith(".umbk")),
    ).toEqual([]);
  });
});
