import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { LIVE_INBOX_READING_ENABLED } from "@/lib/compliance/policies";
import type { Db } from "@/lib/db/client";
import { jobs, mailboxes } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { GmailInboxReader } from "../gmail/inbox";
import { getOAuthStatus } from "../gmail/oauth";
import { getDemoInbox } from "../inbound/fake-inbox";
import { syncInbox, type InboxReader, type SyncSummary } from "../inbound/sync";

/**
 * `inbox.sync` iş türü: gelen kutularını okuyup iletileri işler (Aşama 13 demo; go-live C6 Gmail).
 *
 * GÜVENLİK: Varsayılan KAPALI. İki BAĞIMSIZ anahtar vardır; ikisi de kapalıyken iş hiç planlanmaz, hiçbir ileti okunmaz,
 * veritabanına hiçbir şey yazılmaz:
 *  - `FAZ3_DEMO_INBOX_ENABLED=1` (ortam): YALNIZCA demo posta kutuları okunur (bu sürümde yalnızca testlerde/E2E).
 *  - `LIVE_INBOX_READING_ENABLED` (kod sabiti, varsayılan false): YALNIZCA bağlı ve `gmail.readonly` izni olan Gmail
 *    kutuları `GmailInboxReader` ile okunur. Kilit kapalıyken Gmail okuyucusu hiç oluşturulmaz, ağ isteği atılmaz.
 *    Okuyucu ve `syncInbox` aynı kilidi ayrıca kendileri de denetler (derinlemesine savunma).
 * `FAZ3_DEMO_SCHEDULER_ENABLED` bayrağından BAĞIMSIZDIR: o kapalıyken de bu açılabilir, tersi de geçerlidir.
 */

export const INBOX_SYNC_JOB = "inbox.sync";
export const INBOX_FLAG = "FAZ3_DEMO_INBOX_ENABLED";
export const INBOX_SYNC_INTERVAL_MS = 60_000;
/** Gmail hız sınırı geri çekilmesinin üst sınırı (kutu başına). */
export const MAX_INBOX_BACKOFF_MS = 6 * 3_600_000;
const STALE_INBOX_JOB_LOCK_MS = 60_000;

export function isDemoInboxEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const v = env[INBOX_FLAG];
  return v === "1" || v === "true";
}

/** Yalnızca testte geçersiz kılınabilen ayarlar üretimde reddedilir (GmailInboxReader ile aynı kural). */
function assertTestOnly(used: boolean): void {
  if (used && process.env.NODE_ENV !== "test") {
    throw new Error("Gelen kutusu işi ayarları yalnızca testte değiştirilebilir.");
  }
}

/** Gerçek gelen kutusu okuma kilidi: üretimde her zaman `LIVE_INBOX_READING_ENABLED` sabitidir. */
function liveInboxGate(override?: () => boolean): () => boolean {
  assertTestOnly(override !== undefined);
  return override ?? (() => LIVE_INBOX_READING_ENABLED);
}

/** İş açık mı: demo bayrağı VEYA gerçek gelen kutusu okuma kilidi. */
export function isInboxSyncEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  opts: { liveInboxEnabled?: () => boolean } = {},
): boolean {
  return isDemoInboxEnabled(env) || liveInboxGate(opts.liveInboxEnabled)();
}

/** Bekleyen veya çalışan başka bir `inbox.sync` işi yoksa yenisini ekler. */
export async function scheduleInboxSync(
  db: Db,
  opts: { runAt: number; now?: number; exceptJobId?: number },
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.type, INBOX_SYNC_JOB), inArray(jobs.status, ["queued", "running"])));
    if (existing.some((j) => j.id !== opts.exceptJobId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        type: INBOX_SYNC_JOB,
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

export function createInboxSyncHandler(opts: {
  /** Demo gelen kutusu bayrağı (`FAZ3_DEMO_INBOX_ENABLED`). Gerçek okuma kilidinden bağımsızdır. */
  enabled: boolean;
  /** Demo okuyucu (varsayılan: süreç içi demo gelen kutusu). */
  reader?: InboxReader;
  /** Yalnızca testte: Gmail okuyucusu fabrikası (varsayılan: `new GmailInboxReader({ db })`). */
  gmailReader?: (db: Db) => InboxReader;
  /** Yalnızca testte: gerçek gelen kutusu okuma kilidini geçersiz kılar. */
  liveInboxEnabled?: () => boolean;
  now?: () => number;
}): JobHandler {
  assertTestOnly(opts.gmailReader !== undefined);
  const live = liveInboxGate(opts.liveInboxEnabled);
  /**
   * Kutu başına geri çekilme (Gmail 429/kota 403 `Retry-After`): kutu bu zamana kadar OKUNMAZ, diğer kutular 60 sn
   * aralıkla sürer. Yalnızca bellekte (worker yeniden başlarsa ilk turda yeniden denenir; Gmail yine sınırlarsa yeniden
   * geri çekilir). Üst sınır 6 saat.
   */
  const backoffUntil = new Map<number, number>();
  return async (ctx) => {
    const demoOn = opts.enabled;
    const liveOn = live();
    if (!demoOn && !liveOn) {
      throw new NonRetryableJobError(
        `${INBOX_FLAG} ve gerçek gelen kutusu okuma kilidi kapalı: hiçbir gelen kutusu okunmadı, hiçbir ileti işlenmedi.`,
      );
    }
    const clock = opts.now ?? Date.now;
    const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");
    const report = (kind: "demo" | "gmail", r: SyncSummary) => {
      if (r.fetched > 0) {
        // Demo satırı önceki sürümle birebir aynıdır; gerçek kutu "gmail" önekiyle ayrılır.
        ctx.log(
          `${kind === "gmail" ? "gmail " : ""}gelen kutusu: ${r.processed} işlendi, ${r.duplicates} yinelenen, ${r.needsReview} inceleme, ${r.effects} etki${r.floodGuard ? " (hacim sınırı aşıldı)" : ""}`,
        );
      }
      if (kind === "gmail" && r.error) ctx.log(`gmail gelen kutusu eşitlenemedi: ${r.error}`);
    };

    if (demoOn) {
      const reader = opts.reader ?? getDemoInbox();
      try {
        const boxes = await ctx.db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(and(eq(mailboxes.provider, "demo"), eq(mailboxes.status, "connected")))
          .orderBy(asc(mailboxes.id));
        for (const b of boxes)
          report("demo", await syncInbox(ctx.db, reader, b.id, { now: clock }));
      } catch (e) {
        ctx.log(`gelen kutusu hatası: ${errName(e)}`);
      }
    }

    if (liveOn && !ctx.shouldStop()) {
      try {
        const boxes = await ctx.db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.status, "connected")))
          .orderBy(asc(mailboxes.id));
        // Yalnızca okuma izni (`gmail.readonly`) verilmiş kutular; gönderim izni okuma yerine geçmez. Ağ yok.
        const readable: number[] = [];
        for (const b of boxes) if ((await getOAuthStatus(ctx.db, b.id)).read) readable.push(b.id);
        if (readable.length > 0) {
          // Okuyucu yalnızca okunacak kutu varsa oluşturulur; kendi kilidini de ağdan ÖNCE denetler.
          const reader = opts.gmailReader?.(ctx.db) ?? new GmailInboxReader({ db: ctx.db });
          for (const id of readable) {
            if (ctx.shouldStop()) break;
            const until = backoffUntil.get(id);
            if (until !== undefined && clock() < until) continue;
            backoffUntil.delete(id);
            // Kutu başına ayrı: birinin hatası diğerlerini durdurmaz. syncInbox `mail.inboxSync` kaydını yazar.
            try {
              const r = await syncInbox(ctx.db, reader, id, {
                now: clock,
                ...(opts.liveInboxEnabled ? { liveInboxEnabled: opts.liveInboxEnabled } : {}),
              });
              report("gmail", r);
              // Retry-After yoksa hız sınırında yine de en az 5 dk beklenir (her dakika yeniden denenmez).
              const retryAfter =
                r.retryAfterMs ?? (r.error === "rate_limited" ? 5 * 60_000 : undefined);
              if (retryAfter !== undefined) {
                const wait = Math.min(retryAfter, MAX_INBOX_BACKOFF_MS);
                backoffUntil.set(id, clock() + wait);
                ctx.log(
                  `gmail gelen kutusu hız sınırında: ${Math.ceil(wait / 60_000)} dk ertelendi.`,
                );
              }
            } catch (e) {
              ctx.log(`gmail gelen kutusu hatası: ${errName(e)}`);
            }
          }
        }
      } catch (e) {
        ctx.log(`gmail gelen kutusu hatası: ${errName(e)}`);
      }
    }

    if (ctx.shouldStop()) return;
    try {
      await scheduleInboxSync(ctx.db, {
        runAt: clock() + INBOX_SYNC_INTERVAL_MS,
        now: clock(),
        exceptJobId: ctx.job.id,
      });
    } catch (e) {
      ctx.log(`sonraki gelen kutusu turu planlanamadı: ${errName(e)}`);
    }
  };
}

/**
 * Worker başlangıcı: demo bayrağı VEYA gerçek gelen kutusu okuma kilidi açıksa turu planlar; ikisi de kapalıysa
 * veritabanına HİÇ yazmaz. Gerçek okumanın planlaması da burada yapılır (worker/index.ts değişmeden çağırır).
 */
export async function startInboxScheduler(
  db: Db,
  opts: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    now?: () => number;
    /** Yalnızca testte: gerçek gelen kutusu okuma kilidini geçersiz kılar. */
    liveInboxEnabled?: () => boolean;
  },
): Promise<{ enabled: boolean; demo: boolean; live: boolean }> {
  const demo = isDemoInboxEnabled(opts.env);
  const live = liveInboxGate(opts.liveInboxEnabled)();
  if (!demo && !live) return { enabled: false, demo, live };
  const clock = opts.now ?? Date.now;
  await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, runAt: clock(), updatedAt: clock() })
    .where(
      and(
        eq(jobs.type, INBOX_SYNC_JOB),
        eq(jobs.status, "running"),
        lt(jobs.lockedAt, clock() - STALE_INBOX_JOB_LOCK_MS),
      ),
    );
  await scheduleInboxSync(db, { runAt: clock(), now: clock() });
  return { enabled: true, demo, live };
}
