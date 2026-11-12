import { asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { savedFilters } from "@/lib/db/schema";
import {
  SAVED_FILTER_LIMIT,
  savedFilterNameKey,
  savedFilterNameSchema,
  savedFilterPayloadSchema,
  savedFilterSortSchema,
  type SavedFilterPayload,
  type SavedFilterSortValue,
} from "./saved-filter-payload";

/**
 * Kaydedilmiş süzgeçler servisi. Ad tekliği veritabanındaki `saved_filters_name_uq` (Türkçe büyük/küçük harf duyarsız
 * `name_key`) ile sağlanır; önce-kontrol-sonra-yaz yarışı yoktur: benzersizlik ihlali yakalanıp 409'a çevrilir. En fazla
 * 50 kayıt sınırı ekleme ile aynı işlemde (transaction) denetlenir. Değişiklikler denetim kaydına yazılır (yalnızca ad;
 * süzgeç içeriği yazılmaz, arama metni kişisel bilgi içerebilir).
 */

export const createSavedFilterSchema = z
  .object({
    name: savedFilterNameSchema,
    payload: savedFilterPayloadSchema,
    sort: savedFilterSortSchema.default("novelty"),
    /** `overwrite: true`: aynı adda kayıt varsa üzerine yazılır (409 yerine). */
    overwrite: z.boolean().optional(),
  })
  .strict();
export type CreateSavedFilterInput = z.input<typeof createSavedFilterSchema>;

export const patchSavedFilterSchema = z
  .object({
    name: savedFilterNameSchema.optional(),
    payload: savedFilterPayloadSchema.optional(),
    sort: savedFilterSortSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Değiştirilecek bir alan gerekli.");
export type PatchSavedFilterInput = z.input<typeof patchSavedFilterSchema>;

export interface SavedFilterItem {
  id: number;
  name: string;
  /** Doğrulanmış yük; `invalid` ise ham değer (arayüz yalnızca silmeyi önerir). */
  payload: SavedFilterPayload | unknown;
  sort: SavedFilterSortValue;
  includeArea: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** Yük artık geçerli değil (süzgeç seçenekleri değişmiş olabilir). */
  invalid: boolean;
}

const isUniqueViolation = (e: unknown): boolean => {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    const err = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (
      /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(
        `${String(err.code ?? "")} ${String(err.message ?? "")}`,
      )
    )
      return true;
    cur = err.cause;
  }
  return false;
};

const notFound = () =>
  new HttpError(404, "Kayıtlı süzgeç bulunamadı. Silinmiş olabilir.", {
    code: "SAVED_FILTER_NOT_FOUND",
  });
const exists = () =>
  new HttpError(409, "Bu adla kayıtlı bir süzgeç zaten var. Başka bir ad seçin.", {
    code: "SAVED_FILTER_EXISTS",
  });

function toItem(r: typeof savedFilters.$inferSelect): SavedFilterItem {
  const parsed = savedFilterPayloadSchema.safeParse(r.payload);
  return {
    id: r.id,
    name: r.name,
    payload: parsed.success ? parsed.data : r.payload,
    sort: r.sort,
    includeArea: r.includeArea,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastUsedAt: r.lastUsedAt,
    invalid: !parsed.success,
  };
}

/** Son kullanılan önce (hiç kullanılmamışlar sonda), sonra ada göre. */
export async function listSavedFilters(db: Db): Promise<SavedFilterItem[]> {
  const rows = await db
    .select()
    .from(savedFilters)
    .orderBy(
      sql`${savedFilters.lastUsedAt} IS NULL`,
      desc(savedFilters.lastUsedAt),
      asc(savedFilters.nameKey),
    )
    .limit(SAVED_FILTER_LIMIT * 2);
  return rows.map(toItem);
}

export async function createSavedFilter(
  db: Db,
  raw: CreateSavedFilterInput,
  opts: { now?: number } = {},
): Promise<{ item: SavedFilterItem; created: boolean }> {
  const input = createSavedFilterSchema.parse(raw);
  const now = opts.now ?? Date.now();
  const nameKey = savedFilterNameKey(input.name);
  const includeArea = input.payload.bbox !== undefined;
  try {
    return await db.transaction(async (tx) => {
      if (input.overwrite) {
        const [updated] = await tx
          .update(savedFilters)
          .set({
            name: input.name,
            payload: input.payload,
            sort: input.sort,
            includeArea,
            updatedAt: now,
          })
          .where(eq(savedFilters.nameKey, nameKey))
          .returning();
        if (updated) {
          await audit(
            tx,
            "saved_filter.updated",
            "saved_filter",
            updated.id,
            { name: input.name },
            now,
          );
          return { item: toItem(updated), created: false };
        }
      }
      const [{ n }] = (await tx.select({ n: count() }).from(savedFilters)) as [{ n: number }];
      if (n >= SAVED_FILTER_LIMIT)
        throw new HttpError(
          409,
          `En fazla ${SAVED_FILTER_LIMIT} süzgeç kaydedilebilir. Kullanmadığınız birini silip yeniden deneyin.`,
          { code: "SAVED_FILTER_LIMIT", limit: SAVED_FILTER_LIMIT },
        );
      const [row] = await tx
        .insert(savedFilters)
        .values({
          name: input.name,
          nameKey,
          payload: input.payload,
          sort: input.sort,
          includeArea,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await audit(tx, "saved_filter.created", "saved_filter", row!.id, { name: input.name }, now);
      return { item: toItem(row!), created: true };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw exists();
    throw e;
  }
}

export async function updateSavedFilter(
  db: Db,
  id: number,
  raw: PatchSavedFilterInput,
  opts: { now?: number } = {},
): Promise<SavedFilterItem> {
  const patch = patchSavedFilterSchema.parse(raw);
  const now = opts.now ?? Date.now();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(savedFilters)
        .set({
          ...(patch.name !== undefined
            ? { name: patch.name, nameKey: savedFilterNameKey(patch.name) }
            : {}),
          ...(patch.payload !== undefined
            ? { payload: patch.payload, includeArea: patch.payload.bbox !== undefined }
            : {}),
          ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
          updatedAt: now,
        })
        .where(eq(savedFilters.id, id))
        .returning();
      if (!row) throw notFound();
      await audit(
        tx,
        "saved_filter.updated",
        "saved_filter",
        id,
        { name: row.name, fields: Object.keys(patch) },
        now,
      );
      return toItem(row);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw exists();
    throw e;
  }
}

/** İdempotent: zaten silinmişse `false` döner (uç nokta yine 204 verir). */
export async function deleteSavedFilter(
  db: Db,
  id: number,
  opts: { now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .delete(savedFilters)
      .where(eq(savedFilters.id, id))
      .returning({ id: savedFilters.id, name: savedFilters.name });
    if (!row) return false;
    await audit(tx, "saved_filter.deleted", "saved_filter", id, { name: row.name }, now);
    return true;
  });
}

/** "Uygula" anında son kullanım zamanını işler (sıralama için; denetim kaydı yazılmaz). */
export async function touchSavedFilter(
  db: Db,
  id: number,
  opts: { now?: number } = {},
): Promise<boolean> {
  const rows = await db
    .update(savedFilters)
    .set({ lastUsedAt: opts.now ?? Date.now() })
    .where(eq(savedFilters.id, id))
    .returning({ id: savedFilters.id });
  return rows.length > 0;
}
