import { database, intParam, json, route } from "@/lib/api/http";
import { getRun } from "@/lib/registry/service";
import { registryCall } from "../../guard";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const id = intParam((await ctx.params).id);
  const db = await database();
  return json({ run: await registryCall(() => getRun(db, id)) });
});
