import { body, database, json, route } from "@/lib/api/http";
import {
  createSavedFilter,
  createSavedFilterSchema,
  listSavedFilters,
} from "@/lib/leads/saved-filters";

export const dynamic = "force-dynamic";

/** Kaydedilmiş süzgeçler: son kullanılan önce. Geçersizleşmiş kayıtlar `invalid: true` ile döner (silinmez). */
export const GET = route(async () => {
  const db = await database();
  return json({ items: await listSavedFilters(db) });
});

/**
 * Yeni kayıt: `{name, payload, sort?, overwrite?}`. 201 `{item}`; aynı ad 409 `SAVED_FILTER_EXISTS`
 * (`overwrite: true` ile üzerine yazılır, 200); 50 kayıt sınırı 409 `SAVED_FILTER_LIMIT`.
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  const input = await body(req, createSavedFilterSchema);
  const { item, created } = await createSavedFilter(db, input);
  return json({ item }, { status: created ? 201 : 200 });
});
