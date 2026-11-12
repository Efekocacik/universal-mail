import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { getSetting, setSetting } from "@/lib/settings";
import { errorMessage } from "@/lib/util";
import type { MailProvider } from "../provider/provider";
import { reconcileStaleSending } from "../send-service";
import { MailDispatcher } from "./dispatcher";

/**
 * `mail.send` iş türü: kampanya dağıtıcısını uyandıran TEK iş. Her çalıştırmada en fazla bir ileti gönderilir ve
 * iş kendini bir sonraki uygun ana yeniden planlar. Kampanya durumunun doğru kaynağı iş kuyruğu değil,
 * `campaign_leads` / `messages` tablolarıdır; bu yüzden iş iki kez çalışsa bile aynı adım ikinci kez gönderilmez.
 *
 * GÜVENLİK: Zamanlayıcı varsayılan olarak KAPALIDIR. İki yoldan biriyle açılır:
 *  - `FAZ3_DEMO_SCHEDULER_ENABLED=1` ortam değişkeni (demo; bu sürümde yalnızca testlerde ve yerel demo ortamında),
 *  - gerçek gönderimin TEK birleşik kapısı `isLiveSendingPermitted()` (kodda sabit bayrak VE bütün hukuki onaylar).
 * Kapalıyken hiçbir gönderim, uzlaştırma veya kampanya durum değişikliği yapılmaz. Kapı kapalıyken davranış öncekiyle
 * aynıdır: yalnızca demo posta kutusu ve demo sağlayıcısı kullanılabilir. Kapı açık olsa bile her ileti gönderimden
 * hemen önce `sendCampaignStep` içinde aynı kapıdan ve diğer bütün kurallardan yeniden geçer.
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
 * `mail.send` dağıtıcısı çalışmalı mı? Demo bayrağı VEYA canlı gönderim kapısı (`isLiveSendingPermitted`). Kapı
 * kodda sabittir; kapalıyken sonuç yalnızca demo bayrağına bağlıdır (önceki davranış).
 */
export function isMailSchedulerEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  return isDemoSchedulerEnabled(env) || isLiveSendingPermitted();
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

/** Uyandırılan dağıtıcının en erken yeniden çalışması (dağıtıcının `MIN_WAKE_MS` tabanıyla aynı). */
export const WAKE_FLOOR_MS = 5_000;
export const WAKE_REQUEST_SETTING = "mail.dispatch.wakeRequestedAt";

/**
 * `wakeDispatch` sonucu: `pulled` bekleyen iş öne çekildi, `inserted` yeni iş eklendi, `flagged` çalışan işe "turdan
 * sonra hemen yeniden bak" bayrağı bırakıldı, `noop` iş zaten şimdi çalışacak, `disabled` zamanlayıcı kapalı.
 */
export type WakeOutcome = "pulled" | "inserted" | "flagged" | "noop" | "disabled";

/**
 * Dağıtıcıyı HEMEN uyandırır (Faz 4, hata b): kampanya başlatma/devam, inceleme kararı (`mark_not_sent`) ve posta
 * kutusu tavanının yükseltilmesi gibi işi "şimdi uygun" yapan değişikliklerden sonra çağrılır. Worker'a Electron'dan
 * gelen `{type:'wake'}` IPC iletisi de bunu çağırır.
 *
 * İDEMPOTENT ve MONOTON: bekleyen tek `mail.send` işinin `run_at` değerini yalnızca ÖNE çeker, asla ikinci iş eklemez
 * (kuyrukta veya çalışan iş yoksa `scheduleDispatch` ile aynı tek iş kuralıyla bir tane ekler). Çalışan iş varsa ayar
 * bayrağı yazılır; işleyici turunu bitirince bayrağı görür ve sonraki turu `WAKE_FLOOR_MS` içinde planlar.
 *
 * GÖNDERİM KURALLARINI GEVŞETMEZ: uyandırma yalnızca `dispatchOnce` turunu erkene alır. 90 s aralık, kutu ve kampanya
 * günlük tavanları, gönderim penceresi, canlı gönderim kilidi ve uygunluk denetimleri her ileti için
 * `sendCampaignStep` içinde aynen uygulanır. Zamanlayıcı kapalıysa veritabanına HİÇ yazmaz.
 */
export async function wakeDispatch(
  db: Db,
  opts: {
    now?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    enabled?: boolean;
  } = {},
): Promise<WakeOutcome> {
  const enabled = opts.enabled ?? isMailSchedulerEnabled(opts.env ?? process.env);
  if (!enabled) return "disabled";
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx): Promise<WakeOutcome> => {
    const pulled = await tx
      .update(jobs)
      .set({ runAt: now, updatedAt: now })
      .where(and(eq(jobs.type, MAIL_SEND_JOB), eq(jobs.status, "queued"), gt(jobs.runAt, now)))
      .returning({ id: jobs.id });
    if (pulled.length > 0) return "pulled";
    const existing = await tx
      .select({ status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, MAIL_SEND_JOB), inArray(jobs.status, ["queued", "running"])));
    if (existing.some((j) => j.status === "running")) {
      await setSetting(tx, WAKE_REQUEST_SETTING, now);
      return "flagged";
    }
    if (existing.length > 0) return "noop";
    await tx.insert(jobs).values({
      type: MAIL_SEND_JOB,
      payload: {},
      status: "queued",
      priority: 0,
      maxAttempts: 1,
      runAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return "inserted";
  });
}

/**
 * Çağıranlar için güvenli sarmalayıcı: uyandırma başarısız olursa yalnızca hata ADI günlüğe yazılır (kişisel veri
 * yok) ve worker'ın periyodik bakımı işi en geç birkaç dakika içinde yeniden kurar. Asıl işlemi asla bozmaz.
 */
export async function wakeDispatchSafely(
  db: Db,
  opts: {
    now?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    source: string;
  },
): Promise<WakeOutcome | "failed"> {
  try {
    return await wakeDispatch(db, { now: opts.now, env: opts.env });
  } catch (e) {
    console.warn(
      `[mail] dispatch.wake_failed source=${opts.source} error=${e instanceof Error ? e.name : "unknown"}`,
    );
    return "failed";
  }
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
        `${SCHEDULER_FLAG} kapalı ve canlı gönderim kapısı kapalı: zamanlayıcı çalıştırılmadı, gönderim yapılmadı.`,
      );
    }
    const clock = opts.now ?? Date.now;
    const turnStartedAt = clock();
    let nextWakeAt = turnStartedAt + 60_000;
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
      // Tur sürerken uyandırma istendiyse (`wakeDispatch` → `flagged`), yeni planlanan iş öne çekilir. Bayrak iş
      // EKLENDİKTEN SONRA okunur: ekleme öncesi gelen istek burada, sonrası gelen istek doğrudan kuyruktaki işi görür.
      const requested = await getSetting(ctx.db, WAKE_REQUEST_SETTING);
      if (requested !== null && requested >= turnStartedAt) {
        const soon = clock() + WAKE_FLOOR_MS;
        await ctx.db
          .update(jobs)
          .set({ runAt: soon, updatedAt: clock() })
          .where(
            and(eq(jobs.type, MAIL_SEND_JOB), eq(jobs.status, "queued"), gt(jobs.runAt, soon)),
          );
      }
    } catch (e) {
      ctx.log(`sonraki dağıtım planlanamadı: ${errorMessage(e).slice(0, 120)}`);
    }
  };
}

/**
 * Worker başlangıcı: zamanlayıcı açıksa (`isMailSchedulerEnabled`) eski `sending` kayıtlarını uzlaştırır (10 dk eşiği;
 * aktif gönderimlere dokunulmaz), sahipsiz işleri geri alır, dağıtıcıyı planlar ve periyodik bakımı kurar. Kapalıysa
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
  if (!isMailSchedulerEnabled(opts.env)) return { enabled: false, reconciled: 0, stop: () => {} };
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
