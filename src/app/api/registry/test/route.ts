import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { testRegistry } from "@/lib/registry/service";
import { requireCollectionReady } from "../../scans/guard";
import { registryCall } from "../guard";

export const dynamic = "force-dynamic";

/** `POST /api/registry/test` `{ source }` → `{ ok: true, demo }`. Anahtar asla yanıta/günlüğe yazılmaz. */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const { source } = await body(
    req,
    z.object({ source: z.enum(["companies_house", "insee"]) }).strict(),
  );
  return json(await registryCall(() => testRegistry(db, source)));
});
