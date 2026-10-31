import { asc } from "drizzle-orm";
import { database, json, route } from "@/lib/api/http";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { mailboxes } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Posta kutuları (salt okunur). Kimlik bilgisi referansı, SMTP ayrıntıları ve hata metinleri DÖNDÜRÜLMEZ.
 * `sendable`: bu sürümde yalnızca bağlı demo posta kutusu kampanyaya atanabilir.
 */
export const GET = route(async () => {
  const db = await database();
  const rows = await db.select().from(mailboxes).orderBy(asc(mailboxes.id));
  return json({
    items: rows.map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      address: m.address,
      status: m.status,
      dailyCap: m.dailyCap,
      warmupStep: m.warmupStep,
      warmupStartedAt: m.warmupStartedAt,
      scope: policyScopeForMailbox(m.provider),
      sendable: policyScopeForMailbox(m.provider) === "demo" && m.status === "connected",
    })),
  });
});
