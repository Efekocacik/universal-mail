import { database, json, route } from "@/lib/api/http";
import { listAudit } from "@/lib/audit-list";
import { AUDIT_PARAMS, auditQuerySchema, paramsObject, strictParams } from "../mail/schema";

export const dynamic = "force-dynamic";

/** İşlem günlüğü. Ham ayrıntı döndürülmez; yalnızca güvenli alanların özeti gösterilir. */
export const GET = route(async (req: Request) => {
  const db = await database();
  const sp = new URL(req.url).searchParams;
  strictParams(sp, AUDIT_PARAMS);
  const q = auditQuerySchema.parse(paramsObject(sp));
  return json(
    await listAudit(db, { actionPrefix: q.prefix }, { beforeId: q.beforeId, limit: q.limit }),
  );
});
