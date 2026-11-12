import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { regions, scanSchedules, scans } from "@/lib/db/schema";
import { notify, type NotifyInput } from "@/lib/notifications";
import { errorMessage } from "@/lib/util";

/**
 * Tarama motorunun bildirim üreticileri (Faz 4). Bildirimler en iyi çaba ile yazılır: tarama sonucu zaten kaydedildikten
 * SONRA çağrılır ve bildirim hatası taramayı başarısız yapmaz (yalnızca günlüğe yazılır). İdempotentlik `dedupeKey` ile
 * veritabanındadır; aynı taramanın sonu iki kez işlense bile tek bildirim olur. Metinlerde Google içeriği yoktur:
 * yalnızca sayı ve kullanıcının bölge adı.
 *
 * Bağlantılar (Paket C süzgeç sözleşmesi): `/?scan=<id>&lifecycle=new|opened`.
 */

/** Yeni bir bildirim yazıldığında Electron ana sürecine "hemen yokla" dürtüsü (IPC). Web sürecinde etkisizdir. */
export function nudgeOsNotifications(): void {
  try {
    if (typeof process.send === "function" && process.connected) process.send({ type: "notify" });
  } catch {
    /* ana süreç yoksa 30 sn'lik yoklama yeterlidir */
  }
}

/** Bildirim yazar; hata fırlatmaz. Yeni satır oluştuysa `true`. */
export async function safeNotify(
  db: Db,
  input: NotifyInput,
  now: number,
  log?: (m: string) => void,
): Promise<boolean> {
  try {
    const r = await notify(db, input, { now });
    if (r.created) nudgeOsNotifications();
    return r.created;
  } catch (e) {
    log?.(`bildirim yazılamadı (${input.kind}): ${errorMessage(e).slice(0, 160)}`);
    return false;
  }
}

async function scanContext(db: Db, scanId: number) {
  const rows = await db
    .select({ region: regions.name, origin: scans.origin, scheduleId: scans.scheduleId })
    .from(scans)
    .innerJoin(regions, eq(regions.id, scans.regionId))
    .where(eq(scans.id, scanId))
    .limit(1);
  return rows[0];
}

/**
 * Tamamlanan tarama: karşılaştırılabilir önceki tarama varsa ve yeni işletme bulunduysa `scan.done`, açılış görüldüyse
 * `place.opened` (ikisi de tarama başına TEK, toplu). Zamanlamadan doğduysa zamanlamanın son sonucu `completed` olur.
 */
export async function onScanCompleted(
  db: Db,
  p: { scanId: number; newDetected: number; openedPlaces: number; compared: boolean },
  now: number,
  log?: (m: string) => void,
): Promise<void> {
  const ctx = await scanContext(db, p.scanId);
  if (!ctx) return;
  if (ctx.scheduleId !== null)
    await markScheduleOutcome(db, ctx.scheduleId, p.scanId, "completed", now);
  if (p.compared && p.newDetected > 0) {
    await safeNotify(
      db,
      {
        kind: "scan.done",
        dedupeKey: `scan.done:${p.scanId}`,
        params: { n: p.newDetected, region: ctx.region.slice(0, 200), scanId: p.scanId },
        url: `/?scan=${p.scanId}&lifecycle=new`,
        entity: "scan",
        entityId: p.scanId,
      },
      now,
      log,
    );
  }
  if (p.openedPlaces > 0) {
    await safeNotify(
      db,
      {
        kind: "place.opened",
        dedupeKey: `place.opened:scan:${p.scanId}`,
        params: { n: p.openedPlaces, region: ctx.region.slice(0, 200), scanId: p.scanId },
        url: `/?scan=${p.scanId}&lifecycle=opened`,
        entity: "scan",
        entityId: p.scanId,
      },
      now,
      log,
    );
  }
}

/**
 * Başarısız tarama: yalnızca ZAMANLANMIŞ taramalar bildirim üretir (elle başlatılan taramanın hatası zaten ekrandadır).
 */
export async function onScanFailed(
  db: Db,
  scanId: number,
  now: number,
  log?: (m: string) => void,
): Promise<void> {
  try {
    const ctx = await scanContext(db, scanId);
    if (!ctx || ctx.origin !== "schedule") return;
    if (ctx.scheduleId !== null)
      await markScheduleOutcome(db, ctx.scheduleId, scanId, "failed", now);
    await safeNotify(
      db,
      {
        kind: "scan.failed",
        dedupeKey: `scan.failed:${scanId}`,
        params: { region: ctx.region.slice(0, 200), scanId },
        url: "/scans",
        entity: "scan",
        entityId: scanId,
      },
      now,
      log,
    );
  } catch (e) {
    log?.(`başarısız tarama bildirimi yazılamadı: ${errorMessage(e).slice(0, 160)}`);
  }
}

/** Zamanlamanın son sonucunu günceller; yalnızca bu tarama hâlâ zamanlamanın SON taramasıysa (eski sonuç ezilmez). */
async function markScheduleOutcome(
  db: Db,
  scheduleId: number,
  scanId: number,
  outcome: "completed" | "failed",
  now: number,
): Promise<void> {
  await db
    .update(scanSchedules)
    .set({ lastOutcome: outcome, lastSkipCode: null, updatedAt: now })
    .where(and(eq(scanSchedules.id, scheduleId), eq(scanSchedules.lastScanId, scanId)));
}
