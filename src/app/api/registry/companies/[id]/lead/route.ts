import { z } from "zod";
import { body, database, intParam, json, route } from "@/lib/api/http";
import { promoteToLead } from "@/lib/registry/service";
import { requireCollectionReady } from "../../../../scans/guard";
import { registryCall } from "../../../guard";

export const dynamic = "force-dynamic";

/** `POST /api/registry/companies/:id/lead` `{}` → 201 `{ leadId }`; 409 `REGISTRY_ALREADY_LEAD` / `REGISTRY_MATCHED`. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = intParam((await ctx.params).id);
  const db = await database();
  await requireCollectionReady(db);
  await body(req, z.object({}).strict());
  return json(await registryCall(() => promoteToLead(db, id)), { status: 201 });
});
