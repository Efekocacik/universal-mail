import { and, eq, inArray, lt } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { NonRetryableJobError, type JobHandler } from "@/lib/jobs/registry";
import { getSetting, setSetting } from "@/lib/settings";
import { HttpEventSource, channelPrivateKeyMissing, getChannelSigner } from "./channel";
import {
  checkDeliveryHealth,
  recordDeliveryProblem,
  verifyOneClickEndpoint,
  type VerifyOutcome,
} from "./endpoint";
import { drainUnsubscribeEvents, type UnsubscribeEventSource } from "./ingest";

/**
 * `unsubscribe.drain` iş türü (Aşama 15.7; docs/09 K7/K11): aktarıcının dayanıklı kuyruğundaki çıkış olaylarını
 * imzalı kanaldan ÇEKER, uygulamada işler ve ancak işlendikten sonra onaylar; ardından kuyruk sağlığını kaydeder.
 *
 * GÜVENLİK: Varsayılan KAPALI. İki koşul birlikte gerekir: açma anahtarı (`UM_UNSUBSCRIBE_DRAIN_ENABLED=1` ortam
 * bayrağı VEYA kullanıcının Ayarlar'dan açtığı `mail.unsubscribeDrain.enabled`) VE yapılandırılmış çıkış uç noktası
 * (`mail.unsubscribeEndpoint.baseUrl`) ile etkin kanal anahtarı. Anahtar her turda yeniden okunur (worker yeniden
 * başlatılmadan açılıp kapatılabilir). Kapalıyken veya yapılandırma yokken hiçbir ağ isteği yapılmaz. Bu iş gönderimi
 * AÇMAZ; yalnızca çıkış taleplerinin uygulamaya ulaşmasını sağlar.
 *
 * Kendiliğinden yeniden doğrulama (C4): uçtan uca kanıt 30 gün geçerlidir. İş açıkken kanıt 25 günden eskiyse tur
 * sonunda sınama yeniden yapılır (kanıt sessizce dolup canlı gönderim her ay kendiliğinden durmasın diye). Kanıt yoksa
 * yalnızca daha önceki yeniden denenebilir bir başarısızlıktan en az 1 saat sonra denenir; hiç denenmemiş bir uç nokta
 * için İLK doğrulama her zaman kullanıcı eylemidir.
 */

export const UNSUBSCRIBE_DRAIN_JOB = "unsubscribe.drain";
export const UNSUBSCRIBE_DRAIN_FLAG = "UM_UNSUBSCRIBE_DRAIN_ENABLED";
export const UNSUBSCRIBE_DRAIN_INTERVAL_MS = 60_000;
/** Kanıt bu yaştan büyükse tur sonunda yeniden doğrulanır (geçerlilik 30 gün). */
export const AUTO_REVERIFY_AFTER_MS = 25 * 86_400_000;
/** Başarısız (yeniden denenebilir) bir doğrulamadan sonra kendiliğinden yeniden deneme aralığı. */
export const AUTO_REVERIFY_RETRY_MS = 3_600_000;
/** Kendiliğinden yeniden denenebilen sonuçlar (yapılandırma eksikliği değil; geçici/aktarıcı sorunları). */
const RETRYABLE_VERIFY_CODES: ReadonlySet<string> = new Set([
  "post_failed",
  "bad_status",
  "not_delivered",
  "channel_failed",
]);
const STALE_LOCK_MS = 5 * 60_000;

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function isUnsubscribeDrainEnabled(env: Env): boolean {
  const v = env[UNSUBSCRIBE_DRAIN_FLAG];
  return v === "1" || v === "true";
}

/** Çekme işi açık mı: ortam bayrağı VEYA kullanıcı ayarı (her çağrıda okunur). */
export async function isUnsubscribeDrainActive(db: Db, env: Env): Promise<boolean> {
  if (isUnsubscribeDrainEnabled(env)) return true;
  return (await getSetting(db, "mail.unsubscribeDrain")).enabled;
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

/**
 * Yapılandırma değiştikten sonra (temel adres, anahtar açıldı): iş açıksa VE temel adres varsa hemen bir tur planlar
 * (idempotent; kuyrukta tur varsa yenisi eklenmez). Aksi halde veritabanına yazmaz.
 */
export async function scheduleUnsubscribeDrainIfActive(
  db: Db,
  opts: { env: Env; now?: number },
): Promise<boolean> {
  if (!(await isUnsubscribeDrainActive(db, opts.env))) return false;
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (!cfg.baseUrl) return false;
  const now = opts.now ?? Date.now();
  return (await scheduleUnsubscribeDrain(db, { runAt: now, now })) !== null;
}

/**
 * Kullanıcı anahtarını yazar ve denetime geçirir. Açılırsa (ve temel adres varsa) hemen bir tur planlanır; kapatılırsa
 * kuyrukta BEKLEYEN turlar iptal edilir (ortam bayrağı açıksa iş yine çalışır, o durumda iptal edilmez).
 */
export async function setUnsubscribeDrainEnabled(
  db: Db,
  enabled: boolean,
  opts: { env: Env; now?: number },
): Promise<{ enabled: boolean; active: boolean; scheduled: boolean }> {
  const now = opts.now ?? Date.now();
  await setSetting(db, "mail.unsubscribeDrain", { enabled });
  await audit(
    db,
    "unsubscribe.drain_toggled",
    "setting",
    "mail.unsubscribeDrain",
    { enabled },
    now,
  );
  const active = enabled || isUnsubscribeDrainEnabled(opts.env);
  let scheduled = false;
  if (active) {
    scheduled = await scheduleUnsubscribeDrainIfActive(db, { env: opts.env, now });
  } else {
    await db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now, lockedBy: null })
      .where(and(eq(jobs.type, UNSUBSCRIBE_DRAIN_JOB), eq(jobs.status, "queued")));
  }
  return { enabled, active, scheduled };
}

/** Kanıt kendiliğinden yeniden doğrulanmalı mı (bkz. modül açıklaması)? Yalnızca okur. */
export async function needsAutoReverify(db: Db, now: number): Promise<boolean> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (!cfg.baseUrl) return false;
  if (cfg.verified) return now - cfg.verified.verifiedAt > AUTO_REVERIFY_AFTER_MS;
  const last = cfg.lastAttempt;
  return (
    last !== null &&
    !last.ok &&
    RETRYABLE_VERIFY_CODES.has(last.code) &&
    now - last.at >= AUTO_REVERIFY_RETRY_MS
  );
}

export interface DrainSourceBundle {
  source: UnsubscribeEventSource;
  stats: { getStats(): Promise<{ depth: number; oldestAgeMs: number | null; corrupt: number }> };
}

/**
 * Kaynak neden kurulamıyor? `not_configured`: temel adres veya etkin kanal anahtarı yok (kullanıcı henüz tanımlamadı).
 * `no_channel_key`: ikisi de tanımlı ama etkin kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlandı):
 * kullanıcı "Yeni anahtara geç" ile yeni anahtar üretip anahtar dosyasını yeniden yüklemelidir.
 */
export async function httpSourceProblem(db: Db): Promise<"not_configured" | "no_channel_key"> {
  const cfg = await getSetting(db, "mail.unsubscribeEndpoint");
  if (cfg.baseUrl && (await channelPrivateKeyMissing(db))) return "no_channel_key";
  return "not_configured";
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
  /** Sabit değer veya HER TURDA okunan karar (worker: ortam bayrağı VEYA kullanıcı ayarı). */
  enabled: boolean | ((db: Db) => Promise<boolean>);
  /** Testler için; verilmezse yapılandırmadan kurulur. */
  sourceFactory?: (db: Db) => Promise<DrainSourceBundle | null>;
  now?: () => number;
  /** Kendiliğinden yeniden doğrulama (testler için değiştirilebilir); verilmezse gerçek uçtan uca sınama. */
  reverify?: (db: Db, source: UnsubscribeEventSource) => Promise<VerifyOutcome>;
}): JobHandler {
  const isOn = (db: Db): Promise<boolean> =>
    typeof opts.enabled === "function" ? opts.enabled(db) : Promise.resolve(opts.enabled);
  return async (ctx) => {
    const clock = opts.now ?? Date.now;
    // Açma anahtarı okunamazsa (ör. geçici SQLITE_BUSY) zincir KOPMAMALI: iş tek denemelidir (maxAttempts 1), fırlatılan
    // hata sonraki turu planlamadan işi bitirirdi. Okuma hatasında bu tur atlanır ve yine de sonraki tur planlanır;
    // sonraki tur anahtarı yeniden okur (gerçekten kapalıysa orada durur).
    let on: boolean;
    try {
      on = await isOn(ctx.db);
    } catch (e) {
      ctx.log(`çekme anahtarı okunamadı: ${e instanceof Error ? e.name : "unknown"}; tur atlandı.`);
      await rescheduleNext(ctx, clock);
      return;
    }
    if (!on) {
      throw new NonRetryableJobError(
        `Çıkış olayı çekme kapalı (${UNSUBSCRIBE_DRAIN_FLAG} / Ayarlar): çıkış olayları çekilmedi, hiçbir ağ isteği yapılmadı.`,
      );
    }
    let bundle: DrainSourceBundle | null = null;
    try {
      bundle = await (opts.sourceFactory ?? buildHttpSource)(ctx.db);
    } catch (e) {
      ctx.log(`çıkış kaynağı kurulamadı: ${e instanceof Error ? e.name : "unknown"}`);
    }
    if (!bundle) {
      let problem: "not_configured" | "no_channel_key" = "not_configured";
      try {
        if (!opts.sourceFactory) problem = await httpSourceProblem(ctx.db);
        // Kanal anahtarı okunamıyorsa (gizli bilgiler sıfırlandı) bu SESSİZ kalmamalı: sağlık kaydına geçer, uyarı
        // bandı ve hazırlık ekranı gösterir.
        if (problem === "no_channel_key") await recordDeliveryProblem(ctx.db, problem, clock());
      } catch (e) {
        ctx.log(`kanal durumu kaydedilemedi: ${e instanceof Error ? e.name : "unknown"}`);
      }
      ctx.log(
        problem === "no_channel_key"
          ? "kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlanmış olabilir): olay çekilmedi; Ayarlar'dan yeni kanal anahtarına geçin."
          : "çıkış uç noktası/kanal anahtarı yapılandırılmadı: olay çekilmedi.",
      );
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
      // Kanıt eskiyorsa (25 gün) sessizce dolmasın: tur sonunda uçtan uca yeniden doğrula.
      if (!ctx.shouldStop()) {
        try {
          if (await needsAutoReverify(ctx.db, clock())) {
            const reverify =
              opts.reverify ??
              ((db: Db, source: UnsubscribeEventSource) =>
                verifyOneClickEndpoint(db, { source, now: clock }));
            const out = await reverify(ctx.db, bundle.source);
            ctx.log(`çıkış uç noktası kendiliğinden yeniden doğrulandı: ${out.code}`);
          }
        } catch (e) {
          ctx.log(
            `kendiliğinden yeniden doğrulama yapılamadı: ${e instanceof Error ? e.name : "unknown"}`,
          );
        }
      }
    }
    if (ctx.shouldStop()) return;
    // Tur sürerken kullanıcı kapattıysa sonraki tur planlanmaz. Anahtar okunamazsa yine planlanır (bkz. yukarı).
    try {
      if (!(await isOn(ctx.db))) return;
    } catch (e) {
      ctx.log(`çekme anahtarı okunamadı: ${e instanceof Error ? e.name : "unknown"}`);
    }
    await rescheduleNext(ctx, clock);
  };
}

async function rescheduleNext(
  ctx: { db: Db; job: { id: number }; log(msg: string): void },
  clock: () => number,
): Promise<void> {
  try {
    await scheduleUnsubscribeDrain(ctx.db, {
      runAt: clock() + UNSUBSCRIBE_DRAIN_INTERVAL_MS,
      now: clock(),
      exceptJobId: ctx.job.id,
    });
  } catch (e) {
    ctx.log(`sonraki tur planlanamadı: ${e instanceof Error ? e.name : "unknown"}`);
  }
}

/** Worker başlangıcı: anahtar (bayrak veya ayar) VE yapılandırma varsa turu planlar; aksi halde veritabanına HİÇ yazmaz. */
export async function startUnsubscribeDrain(
  db: Db,
  opts: { env: Env; now?: () => number },
): Promise<{ enabled: boolean }> {
  if (!(await isUnsubscribeDrainActive(db, opts.env))) return { enabled: false };
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
