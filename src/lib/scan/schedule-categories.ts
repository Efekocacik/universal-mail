import { inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "@/lib/db/client";
import { categorySets, scanSchedules } from "@/lib/db/schema";

/**
 * `scan_schedules.category_set_ids` bir JSON kimlik dizisidir ve veritabanı düzeyinde başvuru bütünlüğü YOKTUR (SQLite
 * JSON içindeki kimliğe FK kuramaz). İki güvence:
 *
 * 1. Çalıştırma anı (Paket B zamanlayıcısı): her çalışmadan ÖNCE `checkScheduleCategorySets` çağrılır; eksik kimlik varsa
 *    tarama başlatılmaz, `last_skip_code = CATEGORY_SET_MISSING` yazılır ve `schedule.skipped` bildirimi bu kodla üretilir.
 * 2. Silme anı: bugün kategori setleri yalnızca açılıp kapatılır (silme uç noktası yok). Silme eklenirse
 *    `schedulesUsingCategorySet` doluyken silme 409 ile REDDEDİLMELİDİR.
 */
export const CATEGORY_SET_MISSING = "CATEGORY_SET_MISSING";

export type ScheduleCategoryCheck =
  { ok: true; ids: number[] } | { ok: false; code: typeof CATEGORY_SET_MISSING; missing: number[] };

/** Zamanlamanın kategori seti kimlikleri hâlâ var mı? Boş dizi geçerlidir (yalnızca özel anahtar kelimeler). */
export async function checkScheduleCategorySets(
  db: DbExecutor,
  ids: readonly number[],
): Promise<ScheduleCategoryCheck> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return { ok: true, ids: [] };
  const found = new Set(
    (
      await db
        .select({ id: categorySets.id })
        .from(categorySets)
        .where(inArray(categorySets.id, wanted))
    ).map((r) => r.id),
  );
  const missing = wanted.filter((id) => !found.has(id));
  return missing.length
    ? { ok: false, code: CATEGORY_SET_MISSING, missing }
    : { ok: true, ids: wanted };
}

/** Bu kategori setini kullanan zamanlamaların kimlikleri (silme engeli için). */
export async function schedulesUsingCategorySet(
  db: DbExecutor,
  categorySetId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: scanSchedules.id })
    .from(scanSchedules)
    .where(
      sql`EXISTS (SELECT 1 FROM json_each(${scanSchedules.categorySetIds}) j WHERE j.value = ${categorySetId})`,
    )
    .orderBy(scanSchedules.id);
  return rows.map((r) => r.id);
}
