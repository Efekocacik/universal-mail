import { and, count, eq, ne } from "drizzle-orm";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { campaigns, mailboxes, messages, settings } from "@/lib/db/schema";
import { parseEmail } from "@/lib/email/address";
import { getSetting } from "@/lib/settings";
import {
  deleteSecret,
  mailboxRefreshTokenName,
  OAUTH_CLIENT_SECRET,
  secretExists,
  setSecret,
} from "@/lib/secrets/store";

/**
 * Posta kutusu yapılandırması (FR-SET-02; Aşama 15.2). YALNIZCA yerel kayıt yönetimidir: hiçbir dış servise
 * bağlanmaz, hesap açmaz, ileti göndermez.
 *
 *  - Eklenen Gmail kutusu `not_configured` durumunda başlar. `connected` durumuna YALNIZCA OAuth tamamlanınca
 *    (sonraki aşama) geçilir; bu servis `connected` yazmaz.
 *  - Kimlik bilgisi (yenileme belirteci, istemci sırrı) SQLite'a YAZILMAZ; gizli depoda tutulur.
 *  - Demo kutusu eklenemez, değiştirilemez, silinemez. Canlı kutu kampanyaya atanamaz (kampanya servisi demo ister).
 *  - Gerçek gönderim `LIVE_SENDING_ENABLED=false` ile kapalıdır; kutu eklemek bunu değiştirmez.
 */

const GMAIL_OAUTH_SETTING = "mail.gmailOAuth";
export const MAX_REAL_MAILBOXES = 5;
export const LABEL_MAX = 60;
const RESERVED_TLDS = ["invalid", "example", "test", "localhost"];
/** Google OAuth istemci kimliği biçimi: "<sayı>-<rastgele>.apps.googleusercontent.com". */
const CLIENT_ID_RE = /^[0-9]{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;

export type MailboxServiceErrorKind =
  | "invalid_input"
  | "invalid_email"
  | "reserved_domain"
  | "duplicate"
  | "limit"
  | "not_found"
  | "not_editable"
  | "in_use"
  | "invalid_status"
  | "invalid_client";

export class MailboxServiceError extends Error {
  constructor(
    readonly kind: MailboxServiceErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const hasControl = (s: string) =>
  [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

function cleanLabel(raw: string): string {
  const label = raw.trim();
  if (label.length < 2 || label.length > LABEL_MAX || hasControl(label)) {
    throw new MailboxServiceError("invalid_input", `Ad 2–${LABEL_MAX} karakter olmalı.`);
  }
  return label;
}

export async function createGmailMailbox(
  db: Db,
  input: { label: string; address: string },
  now = Date.now(),
): Promise<{ id: number }> {
  const label = cleanLabel(input.label);
  const parsed = parseEmail(input.address.trim().toLowerCase());
  if (!parsed) throw new MailboxServiceError("invalid_email", "Geçersiz e-posta adresi.");
  const tld = parsed.domain.split(".").pop() ?? "";
  if (RESERVED_TLDS.includes(tld)) {
    throw new MailboxServiceError(
      "reserved_domain",
      "Bu alan adı gerçek bir posta kutusu için kullanılamaz.",
    );
  }
  return db.transaction(async (tx) => {
    const [n] = await tx
      .select({ n: count() })
      .from(mailboxes)
      .where(ne(mailboxes.provider, "demo"));
    if (Number(n?.n ?? 0) >= MAX_REAL_MAILBOXES) {
      throw new MailboxServiceError(
        "limit",
        `En çok ${MAX_REAL_MAILBOXES} gerçek posta kutusu eklenebilir.`,
      );
    }
    const dup = await tx
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.address, parsed.email)))
      .limit(1);
    if (dup.length > 0) throw new MailboxServiceError("duplicate", "Bu adres zaten ekli.");
    const [row] = await tx
      .insert(mailboxes)
      .values({
        provider: "gmail",
        label,
        address: parsed.email,
        status: "not_configured",
        credentialsRef: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: mailboxes.id });
    // Adres denetim kaydına yazılmaz; yalnızca kimlik ve sağlayıcı.
    await audit(tx, "mailbox.created", "mailbox", row!.id, { provider: "gmail" }, now);
    return { id: row!.id };
  });
}

/** Ad ve (yalnızca `not_configured` ↔ `disabled`) durum değişikliği. `connected` bu servisle verilemez. */
export async function updateMailbox(
  db: Db,
  id: number,
  patch: { label?: string; status?: "not_configured" | "disabled" },
  now = Date.now(),
): Promise<void> {
  if (patch.label === undefined && patch.status === undefined) {
    throw new MailboxServiceError("invalid_input", "Değiştirilecek bir alan belirtilmedi.");
  }
  await db.transaction(async (tx) => {
    const [mb] = await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    if (!mb) throw new MailboxServiceError("not_found", "Posta kutusu bulunamadı.");
    if (mb.provider === "demo") {
      throw new MailboxServiceError("not_editable", "Demo posta kutusu değiştirilemez.");
    }
    const set: Partial<typeof mailboxes.$inferInsert> = { updatedAt: now };
    if (patch.label !== undefined) set.label = cleanLabel(patch.label);
    if (patch.status !== undefined) {
      if (mb.status === "connected" || mb.status === "error") {
        throw new MailboxServiceError(
          "invalid_status",
          "Bağlı kutunun durumu bu işlemle değiştirilemez.",
        );
      }
      set.status = patch.status;
    }
    await tx.update(mailboxes).set(set).where(eq(mailboxes.id, id));
    await audit(tx, "mailbox.updated", "mailbox", id, { status: patch.status ?? "same" }, now);
  });
}

/**
 * Kutuyu siler. Demo kutusu ve bağlı kutu silinemez; kampanya veya ileti geçmişi olan kutu silinemez
 * (gönderim geçmişi korunur). Kutunun gizli depodaki belirteci de temizlenir.
 */
export async function deleteMailbox(db: Db, id: number, now = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    const [mb] = await tx.select().from(mailboxes).where(eq(mailboxes.id, id)).limit(1);
    if (!mb) throw new MailboxServiceError("not_found", "Posta kutusu bulunamadı.");
    if (mb.provider === "demo") {
      throw new MailboxServiceError("not_editable", "Demo posta kutusu silinemez.");
    }
    if (mb.status === "connected") {
      throw new MailboxServiceError(
        "invalid_status",
        "Bağlı kutu silinemez; önce bağlantıyı kesin.",
      );
    }
    const [c] = await tx.select({ n: count() }).from(campaigns).where(eq(campaigns.mailboxId, id));
    const [m] = await tx.select({ n: count() }).from(messages).where(eq(messages.mailboxId, id));
    if (Number(c?.n ?? 0) + Number(m?.n ?? 0) > 0) {
      throw new MailboxServiceError(
        "in_use",
        "Kampanya veya gönderim geçmişi olan kutu silinemez.",
      );
    }
    await tx.delete(mailboxes).where(eq(mailboxes.id, id));
    await audit(tx, "mailbox.deleted", "mailbox", id, undefined, now);
  });
  await deleteSecret(mailboxRefreshTokenName(id)); // veritabanı silindikten sonra; yoksa sorun değil
}

export interface GmailClientStatus {
  /** İstemci kimliği kayıtlı mı? Kimliğin kendisi gizli değildir ama arayüze kısaltılarak verilir. */
  clientIdConfigured: boolean;
  clientIdPreview: string | null;
  /** Sır gizli depoda mı? Değer (maskeli bile) ASLA döndürülmez. */
  secretConfigured: boolean;
}

export async function getGmailClientStatus(db: Db): Promise<GmailClientStatus> {
  const { clientId } = await getSetting(db, "mail.gmailOAuth");
  return {
    clientIdConfigured: CLIENT_ID_RE.test(clientId),
    clientIdPreview: CLIENT_ID_RE.test(clientId)
      ? `${clientId.split("-")[0]!.slice(0, 4)}…apps.googleusercontent.com`
      : null,
    secretConfigured: await secretExists(OAUTH_CLIENT_SECRET),
  };
}

/**
 * OAuth istemci kimliği ve (isteğe bağlı) sırrı kaydeder. HİÇBİR dış çağrı yapılmaz; geçerlilik burada sınanmaz.
 * Sır yalnızca gizli depoya yazılır, denetim kaydında yer almaz.
 */
export async function setGmailClient(
  db: Db,
  input: { clientId: string; clientSecret?: string },
  now = Date.now(),
): Promise<void> {
  const clientId = input.clientId.trim();
  if (!CLIENT_ID_RE.test(clientId)) {
    throw new MailboxServiceError("invalid_client", "İstemci kimliği geçerli biçimde değil.");
  }
  const secret = input.clientSecret?.trim();
  if (
    secret !== undefined &&
    (secret.length < 8 || secret.length > 200 || /\s/.test(secret) || hasControl(secret))
  ) {
    throw new MailboxServiceError("invalid_client", "İstemci sırrı geçerli biçimde değil.");
  }
  if (secret) await setSecret(OAUTH_CLIENT_SECRET, secret);
  await db
    .insert(settings)
    .values({ key: GMAIL_OAUTH_SETTING, value: { clientId }, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: { clientId }, updatedAt: now } });
  await audit(
    db,
    "mailbox.gmail_client_set",
    "setting",
    "mail.gmailOAuth",
    { secretUpdated: !!secret },
    now,
  );
}

export async function clearGmailClient(db: Db, now = Date.now()): Promise<void> {
  await deleteSecret(OAUTH_CLIENT_SECRET);
  await db
    .insert(settings)
    .values({ key: GMAIL_OAUTH_SETTING, value: { clientId: "" }, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: { clientId: "" }, updatedAt: now } });
  await audit(db, "mailbox.gmail_client_cleared", "setting", "mail.gmailOAuth", undefined, now);
}
