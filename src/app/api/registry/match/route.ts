import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { enqueueMatch } from "@/lib/registry/service";
import { requireCollectionReady } from "../../scans/guard";
import { registryCall } from "../guard";

export const dynamic = "force-dynamic";

/** `POST /api/registry/match` `{ runId? }` → 202 `{ jobId }` ("Yeniden eşleştir"); 409 `REGISTRY_MATCH_ACTIVE`. */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const input = await body(
    req,
    z.object({ runId: z.number().int().positive().optional() }).strict(),
  );
  return json(await registryCall(() => enqueueMatch(db, input.runId ?? null)), { status: 202 });
});
