import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/lib/db/client";
import { initDatabase } from "@/lib/db/init";
import { categorySets, regions, scanSchedules } from "@/lib/db/schema";
import {
  CATEGORY_SET_MISSING,
  checkScheduleCategorySets,
  schedulesUsingCategorySet,
} from "@/lib/scan/schedule-categories";
import { createTestDb, type TestDb } from "./helpers/db";

/**
 * Faz 4 P0: `scan_schedules.category_set_ids` JSON dizisinin başvuru bütünlüğü veritabanında yoktur; çalıştırma anı
 * denetimi (CATEGORY_SET_MISSING) ve silme engeli için kullanım sorgusu.
 */

let t: TestDb;
let db: Db;
beforeEach(async () => {
  t = await createTestDb();
  await initDatabase();
  db = await getDb();
});
afterEach(async () => {
  await t.cleanup();
});

async function schedule(key: string, ids: number[]) {
  const now = Date.now();
  let region = (await db.select({ id: regions.id }).from(regions).limit(1))[0];
  if (!region)
    [region] = await db
      .insert(regions)
      .values({
        name: "Londra",
        kind: "bbox",
        geometry: { bbox: { south: 51.4, west: -0.2, north: 51.6, east: 0.1 } },
        createdAt: now,
      })
      .returning({ id: regions.id });
  const [row] = await db
    .insert(scanSchedules)
    .values({
      regionId: region!.id,
      scanKey: key,
      categorySetIds: ids,
      strategy: "text",
      fieldProfile: "discovery",
      intervalDays: 14,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: scanSchedules.id });
  return row!.id;
}

describe("zamanlama kategori setleri", () => {
  it("var olan kimlikler geçer (yinelenenler tekilleşir); boş dizi geçerlidir", async () => {
    const ids = (await db.select({ id: categorySets.id }).from(categorySets)).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(await checkScheduleCategorySets(db, [ids[0]!, ids[1]!, ids[0]!])).toEqual({
      ok: true,
      ids: [ids[0], ids[1]],
    });
    expect(await checkScheduleCategorySets(db, [])).toEqual({ ok: true, ids: [] });
  });

  it("silinmiş (sarkan) kimlik CATEGORY_SET_MISSING ile raporlanır", async () => {
    const ids = (await db.select({ id: categorySets.id }).from(categorySets)).map((r) => r.id);
    const ghost = Math.max(...ids) + 1000;
    expect(await checkScheduleCategorySets(db, [ids[0]!, ghost])).toEqual({
      ok: false,
      code: CATEGORY_SET_MISSING,
      missing: [ghost],
    });
    expect(CATEGORY_SET_MISSING).toMatch(/^[A-Z0-9_]{1,40}$/); // last_skip_code / pause_code biçimi
  });

  it("bir kategori setini kullanan zamanlamalar JSON içinden bulunur", async () => {
    const ids = (await db.select({ id: categorySets.id }).from(categorySets)).map((r) => r.id);
    const a = await schedule("k-a", [ids[0]!, ids[1]!]);
    const b = await schedule("k-b", [ids[1]!]);
    await schedule("k-c", []);
    expect(await schedulesUsingCategorySet(db, ids[0]!)).toEqual([a]);
    expect(await schedulesUsingCategorySet(db, ids[1]!)).toEqual([a, b]);
    expect(await schedulesUsingCategorySet(db, ids[2]!)).toEqual([]);
  });
});
