import { and, eq, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { errorMessage } from "@/lib/util";
import type { MailProvider } from "../provider/provider";
import { reconcileStaleSending } from "../send-service";
import { MailDispatcher } from "./dispatcher";

/**
 * `mail.send` iş türü: kampanya dağıtıcısını uyandıran TEK iş. Her çalıştırmada en fazla bir ileti gönderilir ve
 * iş kendini bir sonraki uygun ana yeniden planlar. Kampanya durumunun doğru kaynağı iş kuyruğu değil,
 * `campaign_leads` / `messages` tablolarıdır; bu yüzden iş iki kez çalışsa bile aynı adım ikinci kez gönderilmez.
 *
 * GÜVENLİK: Zamanlayıcı varsayılan olarak KAPALIDIR. Yalnızca `FAZ3_DEMO_SCHEDULER_ENABLED=1` ortam değişkeniyle
 * (bu sürümde yalnızca testlerde) açılır. Kapalıyken hiçbir gönderim, uzlaştırma veya kampanya durum değişikliği
 * yapılmaz. Açıkken bile yalnızca demo posta kutusu ve demo sağlayıcısı kullanılabilir; canlı gönderim kapalıdır.
 */

export const MAIL_SEND_JOB = "mail.send";
export const SCHEDULER_FLAG = "FAZ3_DEMO_SCHEDULER_ENABLED";
/** Bu süreden uzun kalp atışı almayan `running` `mail.send` işi sahipsiz sayılır (kalp atışı 15 s). */
export const STALE_MAIL_JOB_LOCK_MS = 60_000;
export const MAIL_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const MAIL_LOCK_CHECK_INTERVAL_MS = 60_000;

export function isDemoSchedulerEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const v = env[SCHEDULER_FLAG];
  return v === "1" || v === "true";
}

/**
 * Bekleyen veya çalışan başka bir `mail.send` işi yoksa yenisini ekler (tek işlem; süreçler arası da tek dağıtıcı).
 * Eklenen işin kimliğini, zaten varsa `null` döndürür.
 */
export async function scheduleDispatch(
  db: Db,
  opts: { runAt: number; now?: number; exceptJobId?: number },
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MAIL_SEND_JOB),
          inArray(jobs.status, ["queued", "running"]),
          opts.exceptJobId !== undefined ? ne(jobs.id, opts.exceptJobId) : undefined,
        ),
      )
      .limit(1);
    if (existing.length > 0) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        type: MAIL_SEND_JOB,
        payload: {},
        status: "queued",
        priority: 0,
        maxAttempts: 1,
        runAt: opts.runAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: jobs.id });
    return row?.id ?? null;
  });
}

/**
 * Kalp atışı kesilmiş (sahibi çökmüş) `running` `mail.send` işlerini kuyruğa geri alır. Kalp atışı taze olan işe
 * DOKUNULMAZ: başka bir aktif worker'ın işi sahiplenilmez. Karşılaştırmalı güncelleme: arada kalp atışı gelirse iş
 * değişmez.
 */
export async function requeueStaleMailJobs(
  db: Db,
  opts: { now?: number; olderThanMs?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.olderThanMs ?? STALE_MAIL_JOB_LOCK_MS);
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, runAt: now, updatedAt: now })
    .where(and(eq(jobs.type, MAIL_SEND_JOB), eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return rows.length;
}

export interface MailHandlerOptions {
  enabled: boolean;
  dispatcher: MailDispatcher;
  provider?: MailProvider;
  now?: () => number;
  timeoutMs?: number;
  /**
   * Veritabanı meşgul sonucu alındığında bağlantıyı yeniler (worker'da `recoverDbConnection`). libsql'de meşgul
   * hatası bağlantıyı bozabildiği için gereklidir; bkz. `resetConnection`.
   */
  onBusy?: () => Promise<boolean | void>;
}

/** `mail.send` işleyicisi. Gönderimden sonra asla hata fırlatmaz (genel iş yeniden denemesi gönderimi tekrarlamasın). */
export function createMailSendHandler(opts: MailHandlerOptions): JobHandler {
  return async (ctx) => {
    if (!opts.enabled) {
      throw new NonRetryableJobError(
        `${SCHEDULER_FLAG} kapalı: demo zamanlayıcısı çalıştırılmadı, gönderim yapılmadı.`,
      );
    }
    const clock = opts.now ?? Date.now;
    let nextWakeAt = clock() + 60_000;
    try {
      const r = await opts.dispatcher.dispatchOnce({
        now: clock,
        provider: opts.provider,
        timeoutMs: opts.timeoutMs,
        log: ctx.log,
      });
      nextWakeAt = r.nextWakeAt;
      if (r.busy && opts.onBusy) {
        try {
          if ((await opts.onBusy()) === false) {
            ctx.log(
              "bağlantı yenilemesi ertelendi (açık işlem var); sonraki turda yeniden denenecek",
            );
          }
        } catch (e) {
          ctx.log(`bağlantı yenilenemedi: ${e instanceof Error ? e.name : "unknown"}`);
        }
      }
    } catch (e) {
      // Kişisel veri içermeyen kısa hata adı.
      ctx.log(`dağıtıcı hatası: ${e instanceof Error ? e.name : "unknown"}`);
    }
    if (ctx.shouldStop()) return;
    try {
      await scheduleDispatch(ctx.db, { runAt: nextWakeAt, now: clock(), exceptJobId: ctx.job.id });
    } catch (e) {
      ctx.log(`sonraki dağıtım planlanamadı: ${errorMessage(e).slice(0, 120)}`);
    }
  };
}

/**
 * Worker başlangıcı: bayrak açıksa eski `sending` kayıtlarını uzlaştırır (10 dk eşiği; aktif gönderimlere
 * dokunulmaz), sahipsiz işleri geri alır, dağıtıcıyı planlar ve periyodik bakımı kurar. Bayrak kapalıysa
 * veritabanına HİÇ yazmaz.
 */
export async function startMailScheduler(
  db: Db,
  opts: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    now?: () => number;
    log?: (m: string) => void;
    timers?: boolean;
  },
): Promise<{ enabled: boolean; reconciled: number; stop: () => void }> {
  if (!isDemoSchedulerEnabled(opts.env)) return { enabled: false, reconciled: 0, stop: () => {} };
  const clock = opts.now ?? Date.now;
  const log = opts.log ?? (() => undefined);
  const reconciled = await reconcileStaleSending(db, { now: clock() });
  if (reconciled > 0) log(`${reconciled} sonucu belirsiz gönderim incelemeye alındı (unknown).`);
  await requeueStaleMailJobs(db, { now: clock() });
  await scheduleDispatch(db, { runAt: clock(), now: clock() });

  if (opts.timers === false) return { enabled: true, reconciled, stop: () => {} };
  const safe = (fn: () => Promise<unknown>) => () =>
    void fn().catch((e) =>
      log(`zamanlayıcı bakımı başarısız: ${e instanceof Error ? e.name : "?"}`),
    );
  const reconcileTimer = setInterval(
    safe(async () => {
      const n = await reconcileStaleSending(db, { now: clock() });
      if (n > 0) log(`${n} sonucu belirsiz gönderim incelemeye alındı (unknown).`);
      await scheduleDispatch(db, { runAt: clock(), now: clock() });
    }),
    MAIL_RECONCILE_INTERVAL_MS,
  );
  const lockTimer = setInterval(
    safe(() => requeueStaleMailJobs(db, { now: clock() })),
    MAIL_LOCK_CHECK_INTERVAL_MS,
  );
  reconcileTimer.unref?.();
  lockTimer.unref?.();
  return {
    enabled: true,
    reconciled,
    stop: () => {
      clearInterval(reconcileTimer);
      clearInterval(lockTimer);
    },
  };
}
