import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { auditLog, categorySets, jobs, scans } from "@/lib/db/schema";
import { bboxFromCenter } from "@/lib/geo/bbox";
import { clearJobHandlers, getJobHandler, type JobContext } from "@/lib/jobs/registry";
import { COST_CAP } from "@/lib/scan/pause-codes";
import { SCHEDULE_TICK_JOB, scheduleTick } from "@/lib/scan/schedule";
import {
  createAndStartScan,
  ORPHAN_SCAN_GRACE_MS,
  requeueOrphanScans,
  resumeScan,
} from "@/lib/scan/service";
import { setSetting } from "@/lib/settings";
import { registerScanBackgroundHandlers } from "@/worker/background";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Sürdürme atomikliği ve öksüz tarama onarımı: `resumeScan` durum geçişini, maliyet tavanının kaldırılmasını, denetim
 * kaydını ve iş eklemeyi TEK işlemde yapar. Eskiden bunlar ayrı yazılardı; iş eklenemeden bir hata taramayı `queued`
 * ama işsiz bırakıyordu (sonsuza dek "Sırada", zamanlaması PREVIOUS_RUN_ACTIVE ile atlanır). Zamanlama turu böyle
 * öksüz taramaları kısa bir beklemeden sonra yeniden kuyruğa alır.
 */

let t: TestDb;
let db: Db;
let seq = 0;

beforeEach(async () => {
  t = await createTestDb();
  db = t.db;
  await initDatabase();
  await setSetting(db, "places.provider", "mock");
  clearJobHandlers();
});
afterEach(async () => {
  clearJobHandlers();
  await t.cleanup();
});

/** Her çağrı farklı bölge (aynı anahtarla etkin tarama ACTIVE_SCAN olurdu). */
async function startScan(at = Date.now()): Promise<number> {
  const rows = await db.select().from(categorySets);
  const box = bboxFromCenter(51.5085 + 0.05 * ++seq, -0.1257, 3.5);
  const { scanId } = await createAndStartScan(
    db,
    {
      region: { kind: "city", name: `London ${seq}`, countryCode: "GB", bbox: box },
      categoryIds: rows.filter((r) => r.key === "cafe").map((r) => r.id),
    },
    at,
  );
  return scanId;
}

const scanJobs = (scanId: number, statuses = ["queued", "running"] as const) =>
  db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "scan.run"),
        inArray(jobs.status, [...statuses]),
        sql`json_extract(${jobs.payload}, '$.scanId') = ${scanId}`,
      ),
    );

const row = async (id: number) => (await db.select().from(scans).where(eq(scans.id, id)))[0]!;
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

/** Onaylı tavanında durmuş tarama (işi bitmiş). */
async function capStopped(): Promise<number> {
  const id = await startScan();
  const s = await row(id);
  await db
    .update(scans)
    .set({
      status: "paused",
      pauseCode: COST_CAP,
      pauseReason: "Onaylı tavan doldu",
      estimate: { ...(s.estimate as object), costCapUsd: 0.5 },
    })
    .where(eq(scans.id, id));
  await db.update(jobs).set({ status: "done" }).where(eq(jobs.type, "scan.run"));
  return id;
}

describe("resumeScan atomik", () => {
  it("iş eklenemezse hiçbir şey yazılmaz: tarama duraklı kalır, tavan ve denetim değişmez", async () => {
    const id = await capStopped();
    await db.run(
      sql.raw(
        "CREATE TRIGGER no_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'disk dolu'); END",
      ),
    );
    await expect(resumeScan(db, id)).rejects.toThrow();
    const s = await row(id);
    expect(s.status).toBe("paused");
    expect(s.pauseCode).toBe(COST_CAP);
    expect((s.estimate as { costCapUsd: number | null }).costCapUsd).toBe(0.5);
    expect(await audits("scan.cost_cap_lifted")).toHaveLength(0);
    expect(await scanJobs(id)).toHaveLength(0);

    // Sorun giderilince sürdürme tamamlanır: tavan kalkar, tek iş, tek denetim.
    await db.run(sql.raw("DROP TRIGGER no_jobs"));
    expect(await resumeScan(db, id)).toEqual({ ok: true });
    const after = await row(id);
    expect(after).toMatchObject({ status: "queued", pauseCode: null, pauseReason: null });
    expect((after.estimate as { costCapUsd: number | null }).costCapUsd).toBeNull();
    expect(await scanJobs(id)).toHaveLength(1);
    expect(await audits("scan.cost_cap_lifted")).toHaveLength(1);
  });

  it("eşzamanlı iki sürdürme: biri kazanır; tek iş ve tek denetim kaydı", async () => {
    const id = await capStopped();
    const res = await Promise.all([resumeScan(db, id), resumeScan(db, id)]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.find((r) => !r.ok)).toMatchObject({ ok: false });
    expect(await scanJobs(id)).toHaveLength(1);
    expect(await audits("scan.cost_cap_lifted")).toHaveLength(1);
  });

  it("okumadan sonra iptal edilen tarama sürdürülmez (karşılaştır-ve-yaz)", async () => {
    const id = await capStopped();
    const tx = db.transaction.bind(db);
    // İşlem başlamadan hemen önce kullanıcı iptal eder (okuma ile yazma arasındaki pencere).
    (db as { transaction: unknown }).transaction = async (fn: never) => {
      await db.update(scans).set({ status: "cancelled" }).where(eq(scans.id, id));
      (db as { transaction: unknown }).transaction = tx;
      return tx(fn);
    };
    const r = await resumeScan(db, id);
    expect(r.ok).toBe(false);
    expect((await row(id)).status).toBe("cancelled");
    expect(await scanJobs(id)).toHaveLength(0);
  });
});

describe("öksüz tarama onarımı", () => {
  it("işi olmayan eski `queued` tarama yeniden kuyruğa alınır ve denetlenir; yenisi ve işi olan dokunulmaz", async () => {
    const now = Date.now();
    const orphan = await startScan(now - 10 * 60_000);
    const fresh = await startScan(now - 30_000);
    await db.delete(jobs).where(eq(jobs.type, "scan.run"));
    // Bu taramanın kuyrukta işi var: dokunulmaz.
    const withJob = await startScan(now - 10 * 60_000);
    // Son işi az önce bitmiş: bekleme süresi dolmadı.
    const justDone = await startScan(now - 10 * 60_000);
    await db
      .update(jobs)
      .set({ status: "failed", updatedAt: now - 30_000 })
      .where(sql`json_extract(${jobs.payload}, '$.scanId') = ${justDone}`);

    const out = await requeueOrphanScans(db, now);
    expect(out).toEqual([orphan]);
    expect(await scanJobs(orphan)).toHaveLength(1);
    expect(await scanJobs(fresh)).toHaveLength(0);
    expect(await scanJobs(withJob)).toHaveLength(1);
    expect(await scanJobs(justDone)).toHaveLength(0);
    const a = await audits("scan.requeued_orphan");
    expect(a.map((x) => x.entityId)).toEqual([String(orphan)]);

    // Tekrar: artık işi var; çift iş yok.
    expect(await requeueOrphanScans(db, now + ORPHAN_SCAN_GRACE_MS)).toEqual([fresh, justDone]);
    expect(await scanJobs(orphan)).toHaveLength(1);
  });

  it("zamanlama turu öksüz taramayı onarır", async () => {
    const now = Date.now();
    const orphan = await startScan(now - 10 * 60_000);
    await db.delete(jobs).where(eq(jobs.type, "scan.run"));
    registerScanBackgroundHandlers({ now: () => now });
    const tickId = (await scheduleTick(db, { runAt: now, now }))!;
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, tickId));
    await getJobHandler(SCHEDULE_TICK_JOB)!({
      job: { id: tickId, type: SCHEDULE_TICK_JOB } as JobContext["job"],
      payload: {},
      db,
      shouldStop: () => false,
      log: () => undefined,
    } as JobContext);
    expect(await scanJobs(orphan)).toHaveLength(1);
    expect(await audits("scan.requeued_orphan")).toHaveLength(1);
  });
});
