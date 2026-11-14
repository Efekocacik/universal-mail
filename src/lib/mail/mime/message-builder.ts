import crypto from "node:crypto";
import { isLiveSendingPermitted } from "@/lib/compliance/live-gate";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
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
 *  - `live` yalnızca canlı gönderim kapısı (`isLiveSendingPermitted`) açıkken kabul edilir (kendine test hariç); kapı
 *    açıkken de güvenli çıkış bağlantısı ve alt bilgi ile başlıktaki bağlantının aynı olması zorunludur.
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
  /** Takip iletisi: önceki adımın Message-ID'si ve zinciri. Oluşturucu konuya "Re:" EKLEMEZ (konu devamı compose'dadır, 9d). */
  inReplyTo?: string | null;
  references?: readonly string[];
  unsubscribe?: Omit<UnsubscribeHeaderInput, "mode">;
  /**
   * KENDİNE TEST (C11): yalnızca `live` ile. Canlı gönderim kilidinden bağımsızdır AMA alıcı posta kutusunun KENDİ
   * adresiyle birebir aynı olmalıdır (başka alıcı mümkün değildir). Çıkış bağlantısı verilmediyse (uç nokta
   * doğrulanmadı) ileti `List-Unsubscribe` başlığı OLMADAN oluşturulur; verildiyse kampanyadaki kurallar aynen geçerlidir.
   */
  selfTest?: boolean;
  /**
   * Faz 5: açılma pikseli (yalnızca DEMO; `open-tracking.ts`). Gövde temizlendikten SONRA `<body>` sonuna eklenir
   * (temizleyici görselleri siler). Canlı iletide verilirse ileti OLUŞTURULMAZ: canlı açılma izleme bu sürümde yok.
   */
  openPixelUrl?: string;
}

/** Demo iletisindeki açılma pikselinin adresi (RFC 2606 `.invalid`: hiçbir sunucuya çözülmez). */
export const DEMO_OPEN_PIXEL_BASE = "https://open.invalid/demo/o/";

/** Piksel adresi yalnızca demo tabanı + belirteç karakterleri olabilir (HTML'e kaçışsız girer). */
const PIXEL_URL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface BuiltEmail extends MimeMessage {
  messageId: string;
  from: string;
  to: string;
}

export function wrapHtmlDocument(
  fragment: string,
  language: string | null,
  openPixelUrl?: string,
): string {
  const lang = language && /^[a-z]{2,3}$/.test(language) ? ` lang="${escapeHtml(language)}"` : "";
  const pixel = openPixelUrl
    ? `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;border:0">`
    : "";
  const body = sanitizeEmailHtml(fragment).html + pixel;
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
  const selfTest = input.selfTest === true;
  if (selfTest && input.mode !== "live") {
    throw new MessageBuildError(
      "scope_mismatch",
      "Kendine test yalnızca gerçek posta kutusuyla yapılır.",
    );
  }
  if (input.mode === "live" && !selfTest && !isLiveSendingPermitted()) {
    throw new MessageBuildError("live_sending_disabled", "Gerçek gönderim kapısı kapalı.");
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
  if (selfTest && parseEmail(from)!.email !== to.email) {
    throw new MessageBuildError(
      "invalid_recipient",
      "Test iletisi yalnızca posta kutusunun kendi adresine gönderilebilir.",
    );
  }
  if (input.openPixelUrl !== undefined) {
    const token = input.openPixelUrl.startsWith(DEMO_OPEN_PIXEL_BASE)
      ? input.openPixelUrl.slice(DEMO_OPEN_PIXEL_BASE.length)
      : "";
    if (input.mode !== "demo" || selfTest || !PIXEL_URL_RE.test(token)) {
      throw new MessageBuildError(
        "scope_mismatch",
        "Açılma pikseli yalnızca demo kampanya iletisine eklenebilir.",
      );
    }
  }
  const omitUnsubscribe = selfTest && !input.unsubscribe?.url;
  if (input.mode === "live" && !omitUnsubscribe) {
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
    const unsubscribeHeaders = omitUnsubscribe
      ? []
      : buildUnsubscribeHeaders({ ...input.unsubscribe, mode: input.mode });
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
        html: wrapHtmlDocument(input.composed.html, input.composed.language, input.openPixelUrl),
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
