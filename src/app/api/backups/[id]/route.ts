import { database, intParam, json } from "@/lib/api/http";
import { deleteBackup } from "@/lib/backup/service";
import { lifecycleRoute } from "../http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Yedeği (satır + dosya) siler; dosya zaten yoksa da satır silinir. 404 NOT_FOUND; 409 BACKUP_IN_PROGRESS. */
export const DELETE = lifecycleRoute(async (_req: Request, ctx: Ctx) => {
  const db = await database();
  await deleteBackup(db, intParam((await ctx.params).id));
  return json({ deleted: true });
});
