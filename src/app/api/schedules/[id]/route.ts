import { body, database, intParam, json, route } from "@/lib/api/http";
import { deleteSchedule, patchScheduleSchema, updateSchedule } from "@/lib/scan/schedule-service";
import { scheduleErrors } from "../errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Düzenle: `{intervalDays?: 7|14|30, enabled?: boolean, maxCostUsd?: number|null}` (katı; en az bir alan).
 * 200 `{schedule}`; 404 SCHEDULE_NOT_FOUND; 400 geçersiz gövde.
 */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const patch = await body(req, patchScheduleSchema);
  const schedule = await scheduleErrors(() => updateSchedule(db, id, patch));
  return json({ schedule });
});

/** Sil: 204. Geçmiş taramalar kalır; bağlı bildirimler silinir. 404 SCHEDULE_NOT_FOUND. */
export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  await scheduleErrors(() => deleteSchedule(db, id));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
