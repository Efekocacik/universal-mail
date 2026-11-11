import { asc } from "drizzle-orm";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { mailboxes } from "@/lib/db/schema";
import { createGmailMailbox } from "@/lib/mail/mailbox-service";
import { requireConsent } from "../campaigns/schema";
import { createMailboxSchema } from "../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Posta kutuları. Kimlik bilgisi referansı, SMTP ayrıntıları ve hata metinleri DÖNDÜRÜLMEZ.
 * `sendable`: bu sürümde yalnızca bağlı demo posta kutusu kampanyaya atanabilir.
 * `editable`: demo olmayan ve bağlı olmayan kutular ad/durum değişikliğine ve silmeye açıktır.
 */
export const GET = domainRoute(async () => {
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
      editable: m.provider !== "demo" && m.status !== "connected",
    })),
  });
});

/** Gmail posta kutusu ekler (`not_configured`). Hiçbir dış servise bağlanmaz; kimlik bilgisi saklanmaz. */
export const POST = domainRoute(async (req: Request) => {
  const db = await database();
  const input = await body(req, createMailboxSchema);
  await requireConsent(db);
  const { id } = await createGmailMailbox(db, input);
  return json({ id }, { status: 201 });
});
