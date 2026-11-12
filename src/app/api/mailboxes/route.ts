import { asc } from "drizzle-orm";
import { body, database, json } from "@/lib/api/http";
import { domainRoute } from "@/lib/api/domain-route";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { mailboxes } from "@/lib/db/schema";
import { isConsumerGmailAddress } from "@/lib/mail/consumer-gmail";
import { createGmailMailbox } from "@/lib/mail/mailbox-service";
import { effectiveMailboxCap, mailboxLimitProfile } from "@/lib/mail/scheduler/throttle";
import { getSetting } from "@/lib/settings";
import { requireConsent } from "../campaigns/schema";
import { createMailboxSchema } from "../mail/schema";

export const dynamic = "force-dynamic";

/**
 * Posta kutuları. Kimlik bilgisi referansı, SMTP ayrıntıları ve hata metinleri DÖNDÜRÜLMEZ.
 * `sendable`: kampanyaya atanabilir mi (`assertSendableMailbox` ile aynı kural): bağlı demo kutusu her zaman; Gmail kutusu
 * yalnızca canlı gönderim kapısı açıkken (bu sürümde açık), bağlı ve gönderim izinliyse.
 * `editable`: demo olmayan ve bağlı olmayan kutular ad/durum değişikliğine ve silmeye açıktır.
 * `consumerGmail`: adres kişisel Gmail (`@gmail.com`/`@googlemail.com`); DNS Google'ca yönetilir, sınırlar daha sıkıdır.
 * `reauthorizationRequired`: Google yetkisi geçersiz/iptal (ör. `invalid_grant`); kutu yeniden bağlanana kadar bu
 * kutunun kampanya gönderimleri ERTELENİR. `limits`: bugünkü geçerli günlük tavan ve profilin ısınma tabanı/üst sınırı.
 */
export const GET = domainRoute(async () => {
  const db = await database();
  const now = Date.now();
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
      consumerGmail: m.provider === "gmail" && isConsumerGmailAddress(m.address),
      reauthorizationRequired: m.status === "error" && m.lastError === "reauthorization_required",
      limits: {
        todayCap: effectiveMailboxCap(m, now),
        warmupBase: mailboxLimitProfile(m).warmupBase,
        maxDaily: Math.min(mailboxLimitProfile(m).maxDaily, m.dailyCap),
      },
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
