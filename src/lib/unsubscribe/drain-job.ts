import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { getSetting } from "@/lib/settings";
import { HttpEventSource, getChannelSigner } from "./channel";
import { checkDeliveryHealth } from "./endpoint";
import { drainUnsubscribeEvents, type UnsubscribeEventSource } from "./ingest";

/**
 * `unsubscribe.drain` iş türü (Aşama 15.7; docs/09 K7/K11): aktarıcının dayanıklı kuyruğundaki çıkış olaylarını
 * imzalı kanaldan ÇEKER, uygulamada işler ve ancak işlendikten sonra onaylar; ardından kuyruk sağlığını kaydeder.
 *
 * GÜVENLİK: Varsayılan KAPALI. İki koşul birlikte gerekir: `UM_UNSUBSCRIBE_DRAIN_ENABLED=1` VE yapılandırılmış çıkış
 * uç noktası (`mail.unsubscribeEndpoint.baseUrl`) ile etkin kanal anahtarı. Kapalıyken veya yapılandırma yokken hiçbir
 * ağ isteği yapılmaz, veritabanına hiçbir şey yazılmaz. Bu sürümde bayrak hiçbir yerde açılmaz (gerçek alan adı yok).
 */

export const UNSUBSCRIBE_DRAIN_JOB = "unsubscribe.drain";
export const UNSUBSCRIBE_DRAIN_FLAG = "UM_UNSUBSCRIBE_DRAIN_ENABLED";
export const UNSUBSCRIBE_DRAIN_INTERVAL_MS = 60_000;
const STALE_LOCK_MS = 5 * 60_000;

export function isUnsubscribeDrainEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const v = env[UNSUBSCRIBE_DRAIN_FLAG];
  return v === "1" || v === "true";
}

export async function scheduleUnsubscribeDrain(
  db: Db,
  opts: { runAt: number; now?: number; exceptJobId?: number },
): Promise<number | null> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB), inArray(jobs.status, ["queued", "running"])),
      );
    if (existing.some((j) => j.id !== opts.exceptJobId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({
        type: UNSUBSCRIBE_DRAIN_JOB,
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

export interface DrainSourceBundle {
  source: UnsubscribeEventSource;
  stats: { getStats(): Promise<{ depth: number; oldestAgeMs: number | null; corrupt: number }> };
}

/** Yapılandırmadan kaynak kurar; yapılandırma/anahtar yoksa null (hiçbir şey yapılmaz). */
export async function buildHttpSource(db: Db): Promise<DrainSourceBundle | null> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  const signer = await getChannelSigner(db);
  if (!cfg.baseUrl || !signer) return null;
  const http = new HttpEventSource({
    baseUrl: cfg.baseUrl,
    kid: signer.kid,
    privateKey: signer.privateKey,
  });
  return { source: http, stats: http };
}

export function createUnsubscribeDrainHandler(opts: {
  enabled: boolean;
  /** Testler için; verilmezse yapılandırmadan kurulur. */
  sourceFactory?: (db: Db) => Promise<DrainSourceBundle | null>;
  now?: () => number;
}): JobHandler {
  return async (ctx) => {
    if (!opts.enabled) {
      throw new NonRetryableJobError(
        `${UNSUBSCRIBE_DRAIN_FLAG} kapalı: çıkış olayları çekilmedi, hiçbir ağ isteği yapılmadı.`,
      );
    }
    const clock = opts.now ?? Date.now;
    let bundle: DrainSourceBundle | null = null;
    try {
      bundle = await (opts.sourceFactory ?? buildHttpSource)(ctx.db);
    } catch (e) {
      ctx.log(`çıkış kaynağı kurulamadı: ${e instanceof Error ? e.name : "unknown"}`);
    }
    if (!bundle) {
      ctx.log("çıkış uç noktası/kanal anahtarı yapılandırılmadı: olay çekilmedi.");
    } else {
      try {
        const r = await drainUnsubscribeEvents(ctx.db, bundle.source, { now: clock });
        if (r.pulled > 0) {
          ctx.log(
            `çıkış olayları: ${r.pulled} çekildi, ${r.unsubscribed} çıkış, ${r.duplicates} yinelenen, ${r.probes} sınama, ${r.rejected} reddedilen${r.error ? ` (hata: ${r.error})` : ""}`,
          );
        }
      } catch (e) {
        // Kanal/ağ hatası: olaylar onaylanmadı, kuyrukta kalır.
        ctx.log(`çıkış olayları çekilemedi: ${e instanceof Error ? e.name : "unknown"}`);
      }
      // Sağlık denetimi çekme hatasından BAĞIMSIZ yapılır: erişilemeyen kanal kayda (ve denetime) geçer, sessiz kalmaz.
      try {
        await checkDeliveryHealth(ctx.db, bundle.stats, clock());
      } catch (e) {
        ctx.log(`kuyruk sağlığı kaydedilemedi: ${e instanceof Error ? e.name : "unknown"}`);
      }
    }
    if (ctx.shouldStop()) return;
    try {
      await scheduleUnsubscribeDrain(ctx.db, {
        runAt: clock() + UNSUBSCRIBE_DRAIN_INTERVAL_MS,
        now: clock(),
        exceptJobId: ctx.job.id,
      });
    } catch (e) {
      ctx.log(`sonraki tur planlanamadı: ${e instanceof Error ? e.name : "unknown"}`);
    }
  };
}

/** Worker başlangıcı: bayrak VE yapılandırma varsa turu planlar; aksi halde veritabanına HİÇ yazmaz. */
export async function startUnsubscribeDrain(
  db: Db,
  opts: { env: NodeJS.ProcessEnv | Record<string, string | undefined>; now?: () => number },
): Promise<{ enabled: boolean }> {
  if (!isUnsubscribeDrainEnabled(opts.env)) return { enabled: false };
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (!cfg.baseUrl) return { enabled: false };
  const clock = opts.now ?? Date.now;
  await db
    .update(jobs)
    .set({ status: "queued", lockedBy: null, lockedAt: null, runAt: clock(), updatedAt: clock() })
    .where(
      and(
        eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB),
        eq(jobs.status, "running"),
        lt(jobs.lockedAt, clock() - STALE_LOCK_MS),
      ),
    );
  await scheduleUnsubscribeDrain(db, { runAt: clock(), now: clock() });
  return { enabled: true };
}
