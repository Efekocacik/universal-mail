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
import { MAIL_SEND_JOB, requeueStaleMailJobs } from "@/lib/mail/scheduler/job";
import { budgetSummary } from "@/lib/scan/gates";
import { APP_STOPPED, INTERRUPTED } from "@/lib/scan/runner";
import { safeNotify } from "@/lib/scan/scan-notifications";
import { enqueueScanJob } from "@/lib/scan/service";
import { errorMessage, sleep } from "@/lib/util";

export interface RecoverResult {
  interrupted: number;
  resumedScheduled: number;
  pausedManual: number;
}

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
   * - "çalışıyor" görünen tarama işleri iptal edilir, tarama DURAKLATILIR (`pause_code = INTERRUPTED`);
   * - Faz 4: ZAMANLANMIŞ taramalardan kesilen (INTERRUPTED) veya kapanışta güvenle duraklatılan (APP_STOPPED) olanlar
   *   bütçe engelli değilse kendiliğinden yeniden kuyruğa alınır (kullanıcı zamanlamayı kurarken onayladı; çalıştırıcının
   *   çağrı ve bütçe sınırları geçerlidir). ELLE başlatılan taramalar duraklatılmış kalır (ücretli çağrılar kullanıcı
   *   onayı olmadan sürmez) ve M9: kesilen elle taramalar için tek bir `scan.paused` bildirimi yazılır. BİLİNÇLİ
   *   SAPMA: M9 yalnızca işçinin kendiliğinden yeniden başlatılmasını istiyordu; işçi ilk açılışla yeniden başlatmayı
   *   ayırt edemez ve kullanıcı sert kapatmadan sonraki açılışta da yarım kalan taramasından haberdar olmalıdır;
   *   bildirim gün başına tekildir. Zamanlanmış taramalar ayrıca tick'te de sürdürülür (schedule.ts `handleOwnRun`);
   * - `mail.send` işi yalnızca kalp atışı kesilmişse geri alınır (başka aktif bir worker'ın işi sahiplenilmez);
   * - diğer işler yeniden kuyruğa alınır;
   * - kuyruğa alınmış ama işi kaybolmuş taramalara iş eklenir.
   */
  async recover(now: number = Date.now()): Promise<RecoverResult> {
    const { db } = this.opts;
    for (const job of await listRunningJobs(db)) {
      if (job.type === "scan.run") await cancelJob(db, job.id);
      else if (job.type !== MAIL_SEND_JOB) await requeueJob(db, job.id);
    }
    await requeueStaleMailJobs(db);
    const interrupted = await db
      .update(scans)
      .set({
        status: "paused",
        pauseReason: "Uygulama kapandı veya beklenmedik şekilde durdu; devam edebilirsiniz.",
        pauseCode: INTERRUPTED,
      })
      .where(eq(scans.status, "running"))
      .returning({ id: scans.id, origin: scans.origin });
    if (interrupted.length > 0) this.log(`${interrupted.length} yarım kalan tarama duraklatıldı.`);

    let resumed = 0;
    const resumable = await db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          eq(scans.status, "paused"),
          eq(scans.origin, "schedule"),
          inArray(scans.pauseCode, [INTERRUPTED, APP_STOPPED]),
        ),
      );
    if (resumable.length > 0) {
      const budget = await budgetSummary(db);
      if (budget.level !== "blocked") {
        for (const s of resumable) {
          await db
            .update(scans)
            .set({ status: "queued", pauseReason: null, pauseCode: null })
            .where(and(eq(scans.id, s.id), eq(scans.status, "paused")));
          resumed++;
        }
        this.log(`${resumed} zamanlanmış tarama kaldığı yerden sürecek.`);
      }
    }

    const manual = interrupted.filter((s) => s.origin === "manual");
    if (manual.length > 0) {
      const first = manual[0]!.id;
      await safeNotify(
        db,
        {
          kind: "scan.paused",
          dedupeKey: `scan.paused:${first}:${new Date(now).toISOString().slice(0, 10)}`,
          params: { n: manual.length, scanId: first },
          url: "/scans",
          entity: "scan",
          entityId: first,
        },
        now,
        this.log,
      );
    }

    const queued = await db
      .select({ id: scans.id })
      .from(scans)
      .where(and(inArray(scans.status, ["queued"])));
    for (const s of queued) await enqueueScanJob(db, s.id);
    return {
      interrupted: interrupted.length,
      resumedScheduled: resumed,
      pausedManual: manual.length,
    };
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
