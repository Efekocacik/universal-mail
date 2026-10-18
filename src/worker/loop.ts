import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { scans } from "@/lib/db/schema";
import {
  cancelJob,
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  listRunningJobs,
  requeueJob,
} from "@/lib/jobs/queue";
import { getJobHandler, NonRetryableJobError } from "@/lib/jobs/registry";
import { enqueueScanJob } from "@/lib/scan/service";
import { errorMessage, sleep } from "@/lib/util";

export interface WorkerOptions {
  db: Db;
  workerId: string;
  pollMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

/**
 * Tek işçili SQLite iş kuyruğu döngüsü. Uygulama tarafından yönetilir (Electron ana süreci başlatır).
 * Bütçeyi ve hız sınırını koruyan sıralı çalışma için aynı anda yalnızca bir iş yürütülür.
 */
export class Worker {
  private stopping = false;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: WorkerOptions) {
    this.pollMs = opts.pollMs ?? 1000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.log = opts.log ?? ((m) => console.log(`[worker] ${m}`));
  }

  shouldStop = (): boolean => this.stopping;

  stop(): void {
    this.stopping = true;
  }

  /**
   * Önceki oturumdan kalanları toparlar:
   * - "çalışıyor" görünen tarama işleri iptal edilir, tarama DURAKLATILIR (ücretli çağrılar kullanıcı onayı olmadan sürmez);
   * - diğer işler yeniden kuyruğa alınır;
   * - kuyruğa alınmış ama işi kaybolmuş taramalara iş eklenir.
   */
  async recover(): Promise<void> {
    const { db } = this.opts;
    for (const job of await listRunningJobs(db)) {
      if (job.type === "scan.run") await cancelJob(db, job.id);
      else await requeueJob(db, job.id);
    }
    const interrupted = await db
      .update(scans)
      .set({
        status: "paused",
        pauseReason: "Uygulama kapandı veya beklenmedik şekilde durdu; devam edebilirsiniz.",
      })
      .where(eq(scans.status, "running"))
      .returning({ id: scans.id });
    if (interrupted.length > 0) this.log(`${interrupted.length} yarım kalan tarama duraklatıldı.`);

    const queued = await db
      .select({ id: scans.id })
      .from(scans)
      .where(and(inArray(scans.status, ["queued"])));
    for (const s of queued) await enqueueScanJob(db, s.id);
  }

  /** Bir iş kapıp çalıştırır. İş çalıştırıldıysa `true` döner. */
  async tick(): Promise<boolean> {
    const { db, workerId } = this.opts;
    const job = await claimNextJob(db, workerId);
    if (!job) return false;

    const handler = getJobHandler(job.type);
    if (!handler) {
      await failJob(
        db,
        { id: job.id, attempts: job.maxAttempts, maxAttempts: job.maxAttempts },
        `Bilinmeyen iş türü: ${job.type}`,
      );
      return true;
    }

    const timer = setInterval(
      () => void heartbeatJob(db, job.id).catch(() => undefined),
      this.heartbeatMs,
    );
    try {
      this.log(`iş #${job.id} (${job.type}) başladı`);
      await handler({
        job,
        payload: job.payload,
        db,
        shouldStop: this.shouldStop,
        log: (m) => this.log(`iş #${job.id}: ${m}`),
      });
      await completeJob(db, job.id);
    } catch (e) {
      const message = errorMessage(e);
      this.log(`iş #${job.id} hata verdi: ${message}`);
      const permanent = e instanceof NonRetryableJobError;
      await failJob(
        db,
        permanent ? { id: job.id, attempts: job.maxAttempts, maxAttempts: job.maxAttempts } : job,
        message,
      );
    } finally {
      clearInterval(timer);
    }
    return true;
  }

  async run(): Promise<void> {
    await this.recover();
    this.log("işçi başladı");
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (e) {
        this.log(`döngü hatası: ${errorMessage(e)}`);
      }
      if (!worked) await sleep(this.pollMs);
    }
    this.log("işçi durdu");
  }
}
