import { asc } from "drizzle-orm";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { mailboxes } from "@/lib/db/schema";
import { createGmailMailbox } from "@/lib/mail/mailbox-service";
import { getSetting } from "@/lib/settings";
import { requireConsent } from "../campaigns/schema";
import { createMailboxSchema } from "../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Posta kutuları. Kimlik bilgisi referansı, SMTP ayrıntıları ve hata metinleri DÖNDÜRÜLMEZ.
 * `sendable`: kampanyaya atanabilir mi (`assertSendableMailbox` ile aynı kural): bağlı demo kutusu her zaman; Gmail kutusu
 * yalnızca canlı gönderim kapısı açıkken (bu sürümde açık), bağlı ve gönderim izinliyse.
 * `editable`: demo olmayan ve bağlı olmayan kutular ad/durum değişikliğine ve silmeye açıktır.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  const rows = await db.select().from(mailboxes).orderBy(asc(mailboxes.id));
  // Kapı kapalıyken izin kaydı hiç okunmaz (önceki davranış).
  const live = isLiveSendingPermitted();
  const grants = live ? await getSetting(db, "mail.gmailGrants") : {};
  const sendable = (m: (typeof rows)[number]) =>
    m.status === "connected" &&
    (policyScopeForMailbox(m.provider) === "demo" ||
      (live && m.provider === "gmail" && grants[String(m.id)]?.send === true));
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
      sendable: sendable(m),
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
