import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import { cancelScan, pauseScan, resumeScan, SCAN_CONTROL_STATUS } from "@/lib/scan/service";
import { requireCollectionReady } from "../../guard";

export const dynamic = "force-dynamic";

/**
 * Taramayı duraklat/sürdür/iptal et. 200 `{ok: true}`; 404 SCAN_NOT_FOUND; 409 SCAN_NOT_PAUSABLE / SCAN_NOT_RESUMABLE /
 * SCAN_PROVIDER_CHANGED / BUDGET_BLOCKED / SCAN_CHANGED / SCAN_FINISHED (kodlar `SCAN_CONTROL_STATUS`).
 */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const id = intParam((await ctx.params).id);
  const { action } = await body(req, z.object({ action: z.enum(["pause", "resume", "cancel"]) }));
  if (action === "resume") await requireCollectionReady(db);
  const res =
    action === "pause"
      ? await pauseScan(db, id)
      : action === "resume"
        ? await resumeScan(db, id)
        : await cancelScan(db, id);
  if (!res.ok) throw new HttpError(SCAN_CONTROL_STATUS[res.code], res.error, { code: res.code });
  return json({ ok: true });
});
