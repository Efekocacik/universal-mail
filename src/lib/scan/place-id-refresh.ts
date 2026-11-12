import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { canSpend, recordUsage } from "@/lib/budget";
import type { Db, DbExecutor } from "@/lib/db/client";
import { audit } from "@/lib/db/audit";
import { leads, places, placeSnapshots } from "@/lib/db/schema";
import { PlacesApiError } from "@/lib/places/errors";
import { skuFor } from "@/lib/places/fields";
import type { PlacesProvider } from "@/lib/places/provider";
import { PLACE_ID_REFRESH_DAYS } from "@/lib/places/retention";
import { sleep as defaultSleep } from "@/lib/util";

/**
 * Yer kimliği yenileme (Faz 4, madde 2). Google, 12 aydan eski place_id'lerin yenilenmesini önerir; eskimiş kimlik
 * sorulduğunda güncel kimliği döndürür ya da NOT_FOUND verir (kaynak: `PLACE_ID_URL`, retention.ts).
 *
 * - İstek yalnızca `id` alanını ister: "Place Details Essentials (IDs Only)", ücretsiz ve sınırsız SKU.
 * - Aynı kimlik → `place_id_checked_at` damgalanır.
 * - Farklı kimlik → TEK İŞLEMDE yeniden eşlenir: yer satırı yeni kimlikle kopyalanır, lead ve tarama izleri taşınır,
 *   eski satır silinir. Yeni kimlik zaten varsa (aynı işletme iki kez kaydedilmiş): eski lead yeni yere taşınır; iki
 *   tarafta da lead varsa lead'ler birleştirilmez, eski lead `google_id_merged` etiketiyle işaretlenir (kullanıcı karar
 *   verir) ve eski yer `gone_at` ile kapatılır.
 * - NOT_FOUND veya boş yanıt → `gone_at` (lead silinmez; listede "Google'da artık yok" rozeti).
 * - İdempotent: her yer tek güncellemeyle (veya tek işlemle) sonuçlanır; yeniden çalıştırma denetlenmiş yeri atlar.
 */
export const PLACE_ID_REFRESH_JOB = "places.refresh_ids";
export const PLACE_ID_FIELDS = ["id"] as const;
export const MERGED_TAG = "google_id_merged";
const DAY = 86_400_000;

export interface PlaceIdRefreshDeps {
  db: Db;
  provider: PlacesProvider;
  getBudgetUsd: () => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  shouldStop?: () => boolean;
  log?: (m: string) => void;
}

export interface PlaceIdRefreshResult {
  checked: number;
  unchanged: number;
  remapped: number;
  merged: number;
  gone: number;
  stoppedReason?: string;
}

/** Yenilenmesi gereken kimlikler: kaybolmamış ve son denetimi (yoksa ilk görülme) `olderThanDays`'ten eski. */
export async function dueIdRefresh(
  db: Db,
  opts: { now: number; limit: number; olderThanDays?: number },
): Promise<string[]> {
  const cutoff = opts.now - (opts.olderThanDays ?? PLACE_ID_REFRESH_DAYS) * DAY;
  const checked = sql`coalesce(${places.placeIdCheckedAt}, ${places.firstSeenAt})`;
  const rows = await db
    .select({ id: places.placeId })
    .from(places)
    .where(and(isNull(places.goneAt), lt(checked, cutoff)))
    .orderBy(asc(checked))
    .limit(opts.limit);
  return rows.map((r) => r.id);
}

/** Yenilenmesi gereken kimlik sayısı (ayarlar kartı). */
export async function countDueIdRefresh(db: Db, now: number): Promise<number> {
  const cutoff = now - PLACE_ID_REFRESH_DAYS * DAY;
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(places)
    .where(
      and(
        isNull(places.goneAt),
        lt(sql`coalesce(${places.placeIdCheckedAt}, ${places.firstSeenAt})`, cutoff),
      ),
    );
  return Number(r[0]?.n ?? 0);
}

type RemapOutcome = "remapped" | "merged";

/** Eski kimliği yenisine taşır (tek işlem). */
export async function remapPlaceId(
  db: Db,
  oldId: string,
  newId: string,
  now: number,
): Promise<RemapOutcome> {
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(places).where(eq(places.placeId, oldId)).limit(1);
    if (!old) return "remapped";
    const [existing] = await tx.select().from(places).where(eq(places.placeId, newId)).limit(1);
    let outcome: RemapOutcome;
    if (!existing) {
      await tx
        .insert(places)
        .values({ ...old, placeId: newId, placeIdCheckedAt: now, updatedAt: now });
      await tx
        .update(leads)
        .set({ placeId: newId, updatedAt: now })
        .where(eq(leads.placeId, oldId));
      await moveSnapshots(tx, oldId, newId);
      await tx.delete(places).where(eq(places.placeId, oldId));
      outcome = "remapped";
    } else {
      const [oldLead] = await tx.select().from(leads).where(eq(leads.placeId, oldId)).limit(1);
      const [newLead] = await tx.select().from(leads).where(eq(leads.placeId, newId)).limit(1);
      if (oldLead && !newLead) {
        await tx
          .update(leads)
          .set({ placeId: newId, updatedAt: now })
          .where(eq(leads.id, oldLead.id));
      } else if (oldLead && newLead && !oldLead.tags.includes(MERGED_TAG)) {
        await tx
          .update(leads)
          .set({ tags: [...oldLead.tags, MERGED_TAG], updatedAt: now })
          .where(eq(leads.id, oldLead.id));
      }
      await tx
        .update(places)
        .set({ goneAt: now, placeIdCheckedAt: now, updatedAt: now })
        .where(eq(places.placeId, oldId));
      await tx
        .update(places)
        .set({ placeIdCheckedAt: now, updatedAt: now })
        .where(eq(places.placeId, newId));
      outcome = "merged";
    }
    await audit(tx, "places.id_remapped", "places", undefined, { outcome }, now);
    return outcome;
  });
}

/** Tarama izleri (yalnızca kimlik + türetilmiş bayrak) yeni kimliğe taşınır; aynı taramada çakışan iz atılır. */
async function moveSnapshots(tx: DbExecutor, oldId: string, newId: string): Promise<void> {
  await tx.run(
    sql`UPDATE OR IGNORE ${placeSnapshots} SET place_id = ${newId} WHERE place_id = ${oldId}`,
  );
  await tx.delete(placeSnapshots).where(eq(placeSnapshots.placeId, oldId));
}

export async function runPlaceIdRefresh(
  deps: PlaceIdRefreshDeps,
  opts: { limit: number; olderThanDays?: number },
): Promise<PlaceIdRefreshResult> {
  const { db, provider } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => undefined);
  const sku = skuFor("details", PLACE_ID_FIELDS);
  const res: PlaceIdRefreshResult = { checked: 0, unchanged: 0, remapped: 0, merged: 0, gone: 0 };
  const ids = await dueIdRefresh(db, {
    now: now(),
    limit: opts.limit,
    olderThanDays: opts.olderThanDays,
  });

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
    let seen: string | null;
    try {
      const r = await provider.getDetails(id, PLACE_ID_FIELDS);
      await recordUsage(db, provider.id, r.sku, 1, now());
      seen = r.id ?? r.place?.placeId ?? null;
    } catch (e) {
      if (e instanceof PlacesApiError && e.kind === "not_found") seen = null;
      else if (e instanceof PlacesApiError) {
        res.stoppedReason = e.kind;
        log(`yer kimliği yenileme durdu (${e.kind})`);
        break;
      } else throw e;
    }
    const t = now();
    res.checked++;
    if (seen === null) {
      await db
        .update(places)
        .set({ goneAt: t, placeIdCheckedAt: t, updatedAt: t })
        .where(eq(places.placeId, id));
      res.gone++;
    } else if (seen === id) {
      await db
        .update(places)
        .set({ placeIdCheckedAt: t, updatedAt: t })
        .where(eq(places.placeId, id));
      res.unchanged++;
    } else {
      res[await remapPlaceId(db, id, seen, t)]++;
    }
    await sleep(deps.minIntervalMs ?? (provider.id === "mock" ? 0 : 120));
  }

  if (res.checked > 0)
    await audit(db, "places.ids_refreshed", "places", undefined, { ...res }, now());
  log(
    `yer kimliği yenileme: ${res.checked} denetlendi, ${res.unchanged} aynı, ${res.remapped} yeni kimlik, ` +
      `${res.merged} birleşik, ${res.gone} kayboldu` +
      (res.stoppedReason ? ` (durdu: ${res.stoppedReason})` : ""),
  );
  return res;
}
