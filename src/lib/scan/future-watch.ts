import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { canSpend, recordUsage } from "@/lib/budget";
import type { Db } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { places } from "@/lib/db/schema";
import type { NoveltyConfig } from "@/lib/novelty/score";
import { PlacesApiError } from "@/lib/places/errors";
import { skuFor } from "@/lib/places/fields";
import type { PlacesProvider } from "@/lib/places/provider";
import { sleep as defaultSleep } from "@/lib/util";
import { recomputeNovelty } from "./novelty-sync";
import { safeNotify } from "./scan-notifications";
import { statusFlags } from "./status-flags";

/**
 * "Yakında açılacak" izleme (Faz 4, madde 3). Bölge taramasında sıralama/doygunluk yüzünden yeniden görünmeyen
 * FUTURE_OPENING yerlerin açılışı kaçmasın diye, durumu `everyDays` günden eski olanlar Place Details ile (yalnızca
 * `id,businessStatus`: Pro sınıfı, aylık 5.000 ücretsiz) yeniden denetlenir.
 *
 * - Her çağrıdan önce bütçe denetlenir (`canSpend`); bütçe dolarsa iş kısmi biter, hata vermez.
 * - Ad, açılış tarihi gibi Google içeriği SAKLANMAZ; yalnızca türetilmiş bayraklar ve `status_checked_at`.
 * - NOT_FOUND → `gone_at` (lead silinmez).
 * - Açılanlar tek bir toplu `place.opened` bildirimi üretir (gün başına tekil anahtar).
 * - İdempotent: her sonuç tek UPDATE ile yazılır; yeniden çalıştırma aynı değerleri yazar, açılış bir kez kaydedilir
 *   (ikinci gözlemde önceki bayrak artık "yakında açılacak" değildir).
 */
export const FUTURE_WATCH_JOB = "places.watch_future";
export const FUTURE_WATCH_FIELDS = ["id", "businessStatus"] as const;
const DAY = 86_400_000;

export interface FutureWatchDeps {
  db: Db;
  provider: PlacesProvider;
  getBudgetUsd: () => Promise<number>;
  getNoveltyConfig: () => Promise<NoveltyConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  shouldStop?: () => boolean;
  log?: (m: string) => void;
}

export interface FutureWatchResult {
  checked: number;
  opened: number;
  stillFuture: number;
  gone: number;
  /** Bütçe/kota/ağ nedeniyle erken durduysa kısa neden. */
  stoppedReason?: string;
}

/** Denetlenmesi gereken yerler: yakında açılacak, kapalı değil, kaybolmamış ve durumu `everyDays`'ten eski. */
export async function dueFutureWatch(
  db: Db,
  opts: { now: number; everyDays: number; limit: number },
): Promise<string[]> {
  const cutoff = opts.now - opts.everyDays * DAY;
  const checkedAt = sql`coalesce(${places.statusCheckedAt}, ${places.coordsFetchedAt})`;
  const rows = await db
    .select({ id: places.placeId })
    .from(places)
    .where(
      and(
        eq(places.wasFuture, true),
        eq(places.isClosed, false),
        isNull(places.goneAt),
        lt(checkedAt, cutoff),
      ),
    )
    .orderBy(asc(checkedAt))
    .limit(opts.limit);
  return rows.map((r) => r.id);
}

export async function runFutureWatch(
  deps: FutureWatchDeps,
  opts: { everyDays: number; maxPerRun: number },
): Promise<FutureWatchResult> {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => undefined);
  const sku = skuFor("details", FUTURE_WATCH_FIELDS);
  const ids = await dueFutureWatch(db, {
    now: now(),
    everyDays: opts.everyDays,
    limit: opts.maxPerRun,
  });
  const res: FutureWatchResult = { checked: 0, opened: 0, stillFuture: 0, gone: 0 };
  const touched: string[] = [];

  for (const id of ids) {
    if (deps.shouldStop?.()) {
      res.stoppedReason = "stopped";
      break;
    }
    const spend = await canSpend(db, provider.id, await deps.getBudgetUsd(), sku, 1);
    if (!spend.ok) {
      res.stoppedReason = "BUDGET_BLOCKED";
      break;
    }
    const prev = (
      await db
        .select({ wasFuture: places.wasFuture, isClosed: places.isClosed })
        .from(places)
        .where(eq(places.placeId, id))
        .limit(1)
    )[0];
    if (!prev) continue;
    let status: string | undefined;
    try {
      const r = await provider.getDetails(id, FUTURE_WATCH_FIELDS);
      await recordUsage(db, provider.id, r.sku, 1, now());
      // Konum istenmediği için Google yanıtı tam kayda dönüşmez (`place` null); kimlik ve durum ayrı okunur.
      const seenId = r.id ?? r.place?.placeId ?? null;
      if (!seenId) {
        await markGone(db, id, now());
        res.gone++;
        res.checked++;
        touched.push(id);
        continue;
      }
      status = r.businessStatus ?? r.place?.businessStatus;
    } catch (e) {
      if (e instanceof PlacesApiError && e.kind === "not_found") {
        await markGone(db, id, now());
        res.gone++;
        res.checked++;
        touched.push(id);
        continue;
      }
      if (e instanceof PlacesApiError) {
        // Kota/hız/ağ/yetki: bu tur biter, sonraki gün yeniden denenir (yarım kalan yerlerin durumu eski kalır).
        res.stoppedReason = e.kind;
        log(`açılış izleme durdu (${e.kind})`);
        break;
      }
      throw e;
    }
    const t = now();
    const f = statusFlags(status, prev);
    await db
      .update(places)
      .set({
        wasFuture: f.wasFuture,
        isClosed: f.isClosed,
        statusCheckedAt: f.observed ? t : sql`${places.statusCheckedAt}`,
        ...(f.opened ? { openedDetectedAt: t } : {}),
        updatedAt: t,
      })
      .where(eq(places.placeId, id));
    res.checked++;
    if (f.opened) res.opened++;
    else if (f.wasFuture) res.stillFuture++;
    touched.push(id);
    await sleep(deps.minIntervalMs ?? (provider.id === "mock" ? 0 : 120));
  }

  const t = now();
  if (touched.length > 0)
    await recomputeNovelty(db, await deps.getNoveltyConfig(), { placeIds: touched, now: t });
  if (res.opened > 0) {
    const day = new Date(t).toISOString().slice(0, 10);
    await safeNotify(
      db,
      {
        kind: "place.opened",
        dedupeKey: `place.opened:watch:${day}`,
        params: { n: res.opened },
        url: `/?lifecycle=opened&detectedSince=${t - DAY}`,
        entity: "watch",
        entityId: day,
      },
      t,
      log,
    );
  }
  if (res.checked > 0) await audit(db, "places.future_watched", "places", undefined, { ...res }, t);
  log(
    `açılış izleme: ${res.checked} denetlendi, ${res.opened} açıldı, ${res.stillFuture} hâlâ yakında, ${res.gone} kayboldu` +
      (res.stoppedReason ? ` (durdu: ${res.stoppedReason})` : ""),
  );
  return res;
}

async function markGone(db: Db, id: string, t: number): Promise<void> {
  await db
    .update(places)
    .set({ goneAt: t, updatedAt: t })
    .where(inArray(places.placeId, [id]));
}
