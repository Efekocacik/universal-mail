import { z } from "zod";
import { body, database, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { markRead, unreadCount } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const readSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

/**
 * Okundu işaretle: `{ids:number[]}` (1–200) veya `{all:true}`. Zaten okunmuşlar değişmez (idempotent).
 * Yanıt: `{updated, unread}`. Geçersiz gövde 400.
 */
export const POST = route(async (req: Request) => {
  const db = await database();
  const sel = await body(req, readSchema);
  const updated = await markRead(db, sel);
  if (updated > 0)
    await audit(db, "notifications.read", "notification", undefined, {
      updated,
      all: "all" in sel,
    });
  return json({ updated, unread: await unreadCount(db) });
});
