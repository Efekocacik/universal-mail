import { z } from "zod";
import { body, database, HttpError, intParam, json, route } from "@/lib/api/http";
import { cancelScan, pauseScan, resumeScan } from "@/lib/scan/service";
import { requireCollectionReady } from "../../guard";

export const dynamic = "force-dynamic";

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
  if (!res.ok) throw new HttpError(409, res.error);
  return json({ ok: true });
});
