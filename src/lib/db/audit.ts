import { auditLog } from "./schema";
import type { DbExecutor } from "./client";

export async function audit(
  db: DbExecutor,
  action: string,
  entity?: string,
  entityId?: string | number,
  detail?: unknown,
  at: number = Date.now(),
): Promise<void> {
  await db.insert(auditLog).values({
    at,
    action,
    entity: entity ?? null,
    entityId: entityId === undefined ? null : String(entityId),
    detail: detail ?? null,
  });
}
