import crypto from "node:crypto";
import { LIVE_SENDING_ENABLED, policyScopeForMailbox } from "@/lib/compliance/policies";
import { parseEmail } from "@/lib/email/address";
import type { SenderProfile } from "../footer";
import { escapeHtml, sanitizeEmailHtml } from "../html";
import { MimeError } from "./headers";
import { buildMimeMessage, type MimeMessage } from "./mime";
import { DEMO_MESSAGE_ID_DOMAIN, generateMessageId, isValidMessageId } from "./message-id";
import { buildUnsubscribeHeaders, type UnsubscribeHeaderInput } from "./unsubscribe";

/**
 * Aşama 6 çıktısından (`composeEmail`, `purpose: "send"`) gönderime hazır MIME iletisi üretir.
 *
 *  - Hiçbir şey GÖNDERMEZ ve veritabanına yazmaz; yalnızca metin döndürür.
 *  - `live` bu sürümde her zaman reddedilir (`LIVE_SENDING_ENABLED = false`). Live yolu açılsa bile güvenli çıkış
 *    bağlantısı ve alt bilgi ile başlıktaki bağlantının aynı olması zorunludur.
 *  - Kapsam posta kutusundan belirlenir; demo kutusu yalnızca demo, gerçek kutu yalnızca live ile kullanılabilir.
 *  - Gönderen adı firma profilinden gelir (`İletişim kişisi – Ticari unvan`); eksikse ileti oluşturulmaz.
 *  - Gövde Aşama 6'da temizlenmiştir; burada yeniden temizlenir ve tam HTML belgesine sarılır (uzak kaynak yok).
 */

export type MessageBuildErrorKind =
  | "live_sending_disabled"
  | "scope_mismatch"
  | "not_sendable"
  | "mailbox_not_ready"
  | "sender_profile_incomplete"
  | "invalid_recipient"
  | "unsubscribe_mismatch"
  | "mime_error";

export class MessageBuildError extends Error {
  constructor(
    readonly kind: MessageBuildErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export interface BuildEmailInput {
  composed: {
    sendable: boolean;
    errors: readonly unknown[];
    subject: string;
    html: string;
    text: string;
    language: string | null;
  };
  mailbox: { provider: string; address: string | null; status: string };
  profile: Pick<SenderProfile, "contactName" | "legalName"> | null;
  /** Alıcı (normalleştirilmiş). Tek alıcı. */
  recipient: string;
  mode: "demo" | "live";
  now: number;
  /** Verilmezse üretilir. */
  messageId?: string;
  /** Takip iletisi: önceki adımın Message-ID'si ve zinciri. Konuya "Re:" eklenmez. */
  inReplyTo?: string | null;
  references?: readonly string[];
  unsubscribe?: Omit<UnsubscribeHeaderInput, "mode">;
}

export interface BuiltEmail extends MimeMessage {
  messageId: string;
  from: string;
  to: string;
}

export function wrapHtmlDocument(fragment: string, language: string | null): string {
  const lang = language && /^[a-z]{2,3}$/.test(language) ? ` lang="${escapeHtml(language)}"` : "";
  const body = sanitizeEmailHtml(fragment).html;
  return [
    "<!DOCTYPE html>",
    `<html${lang}>`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title></title></head>',
    `<body>${body}</body>`,
    "</html>",
  ].join("\n");
}

export function buildEmailMessage(
  input: BuildEmailInput,
  random: (size: number) => Buffer = crypto.randomBytes,
): BuiltEmail {
  if (input.mode === "live" && !LIVE_SENDING_ENABLED) {
    throw new MessageBuildError("live_sending_disabled", "Gerçek gönderim bu sürümde kapalıdır.");
  }
  if (policyScopeForMailbox(input.mailbox.provider) !== input.mode) {
    throw new MessageBuildError("scope_mismatch", "Posta kutusu ile gönderim kapsamı uyuşmuyor.");
  }
  if (!input.composed.sendable || input.composed.errors.length > 0) {
    throw new MessageBuildError("not_sendable", "İçerik gönderime hazır değil.");
  }
  const from = input.mailbox.address;
  if (input.mailbox.status !== "connected" || !from || !parseEmail(from)) {
    throw new MessageBuildError("mailbox_not_ready", "Posta kutusu hazır değil.");
  }
  const contact = input.profile?.contactName?.trim();
  const legal = input.profile?.legalName?.trim();
  if (!contact || !legal) {
    throw new MessageBuildError("sender_profile_incomplete", "Gönderen firma profili eksik.");
  }
  const to = parseEmail(input.recipient);
  if (!to || to.email !== input.recipient) {
    throw new MessageBuildError("invalid_recipient", "Geçersiz veya normalleştirilmemiş alıcı.");
  }
  if (input.mode === "live") {
    // Başlıktaki bağlantı, alıcının gördüğü alt bilgi bağlantısıyla aynı olmalı.
    const url = input.unsubscribe?.url;
    if (!url || !input.composed.text.includes(url)) {
      throw new MessageBuildError(
        "unsubscribe_mismatch",
        "Çıkış bağlantısı alt bilgidekiyle aynı olmalıdır.",
      );
    }
  }

  try {
    const domain =
      input.mode === "demo" ? DEMO_MESSAGE_ID_DOMAIN : from.slice(from.lastIndexOf("@") + 1);
    const messageId = input.messageId ?? generateMessageId(domain, input.now, random);
    if (!isValidMessageId(messageId)) {
      throw new MimeError("invalid_message_id", "Geçersiz Message-ID.");
    }
    const unsubscribeHeaders = buildUnsubscribeHeaders({ ...input.unsubscribe, mode: input.mode });
    const mime = buildMimeMessage(
      {
        from: { address: from, name: `${contact} – ${legal}` },
        to: { address: to.email },
        subject: input.composed.subject,
        date: input.now,
        messageId,
        inReplyTo: input.inReplyTo ?? null,
        references: input.references,
        language: input.composed.language,
        text: input.composed.text,
        html: wrapHtmlDocument(input.composed.html, input.composed.language),
        unsubscribeHeaders,
      },
      random,
    );
    return { ...mime, messageId, from, to: to.email };
  } catch (e) {
    if (e instanceof MimeError) throw new MessageBuildError("mime_error", e.message, e);
    throw e;
  }
}
