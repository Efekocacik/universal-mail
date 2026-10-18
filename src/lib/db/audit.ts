import { auditLog } from "./schema";
import type { Db } from "./client";

export async function audit(
  db: Db,
  action: string,
  entity?: string,
  entityId?: string | number,
  detail?: unknown,
): Promise<void> {
  await db.insert(auditLog).values({
    at: Date.now(),
    action,
    entity: entity ?? null,
    entityId: entityId === undefined ? null : String(entityId),
    detail: detail ?? null,
  });
}
