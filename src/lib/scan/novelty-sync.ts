import { eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { leads, placeSnapshots, places } from "@/lib/db/schema";
import { computeNovelty, type NoveltyConfig } from "@/lib/novelty/score";
import { chunk } from "@/lib/util";

export interface RecomputeOptions {
  /** Yalnızca bu taramada görülen işletmeler. */
  scanId?: number;
  placeIds?: string[];
  now?: number;
}

/**
 * Lead yenilik skorlarını yeniden hesaplar ve YALNIZCA değişenleri yazar. Zamanla sona eren sinyaller
 * (ör. "son 60 gün") bu fonksiyonun periyodik çağrılmasıyla düşer.
 * Dönen değer: güncellenen lead sayısı.
 */
export async function recomputeNovelty(
  db: Db,
  config: NoveltyConfig,
  opts: RecomputeOptions = {},
): Promise<number> {
  let ids: string[] | undefined = opts.placeIds;
  if (opts.scanId !== undefined) {
    const rows = await db
      .select({ placeId: placeSnapshots.placeId })
      .from(placeSnapshots)
      .where(eq(placeSnapshots.scanId, opts.scanId));
    ids = rows.map((r) => r.placeId);
  }

  let updated = 0;
  const process = async (
    rows: {
      id: number;
      score: number;
      label: string;
      signals: unknown;
      p: typeof places.$inferSelect;
    }[],
  ) => {
    const statements = [];
    for (const row of rows) {
      const res = computeNovelty(
        {
          businessStatus: row.p.businessStatus,
          openingDate: row.p.openingDate,
          userRatingCount: row.p.userRatingCount,
          newDetectedAt: row.p.newDetectedAt,
          openedDetectedAt: row.p.openedDetectedAt,
          now: opts.now,
        },
        config,
      );
      const changed =
        res.score !== row.score ||
        res.label !== row.label ||
        JSON.stringify(res.signals) !== JSON.stringify(row.signals);
      if (!changed) continue;
      statements.push(
        db
          .update(leads)
          .set({
            noveltyScore: res.score,
            noveltyLabel: res.label,
            noveltySignals: res.signals,
            updatedAt: opts.now ?? Date.now(),
          })
          .where(eq(leads.id, row.id)),
      );
    }
    if (statements.length > 0) {
      await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
      updated += statements.length;
    }
  };

  const select = () =>
    db
      .select({
        id: leads.id,
        score: leads.noveltyScore,
        label: leads.noveltyLabel,
        signals: leads.noveltySignals,
        p: places,
      })
      .from(leads)
      .innerJoin(places, eq(leads.placeId, places.placeId));

  if (ids) {
    for (const part of chunk(ids, 400)) {
      await process(await select().where(inArray(places.placeId, part)));
    }
  } else {
    // Tüm lead'ler: sayfa sayfa.
    let lastId = 0;
    for (;;) {
      const page = await select().where(gt(leads.id, lastId)).orderBy(leads.id).limit(500);
      if (page.length === 0) break;
      await process(page);
      lastId = page[page.length - 1]!.id;
    }
  }
  return updated;
}
