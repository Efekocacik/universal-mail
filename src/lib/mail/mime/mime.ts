import crypto from "node:crypto";
import {
  CRLF,
  encodeUnstructured,
  foldHeader,
  formatAddress,
  formatDate,
  HARD_LINE,
  MimeError,
} from "./headers";
import { isValidMessageId } from "./message-id";
import { encodeQuotedPrintable } from "./transfer-encoding";

/**
 * `multipart/alternative` (RFC 2046 5.1.4) ileti: önce düz metin, sonra HTML; ikisi de UTF-8 ve quoted-printable.
 *
 *  - Başlık adları bu dosyadaki sabit listeden gelir; çağıran rastgele başlık ekleyemez. Çıkış başlıkları yalnızca
 *    `buildUnsubscribeHeaders` çıktısı olarak kabul edilir.
 *  - Tek alıcı (`To`); `Cc`/`Bcc` yoktur.
 *  - Ayraç rastgeledir ve "=_" ile başlar: quoted-printable gövde "=" karakterini her zaman "=3D" yazdığından ayraç
 *    gövdede oluşamaz; ayrıca açıkça denetlenir.
 *  - Satır sonları CRLF; hiçbir satır 998 karakteri aşmaz.
 *  - Bu modül iletiyi yalnızca METİN olarak üretir; hiçbir yere göndermez.
 */

export const MAX_MESSAGE_BYTES = 256 * 1024;

export interface MimeAddress {
  address: string;
  name?: string | null;
}

export interface MimeInput {
  from: MimeAddress;
  to: MimeAddress;
  subject: string;
  date: number;
  messageId: string;
  inReplyTo?: string | null;
  references?: readonly string[];
  /** BCP 47 dil etiketi (ör. "tr"). */
  language?: string | null;
  text: string;
  /** Tam HTML belgesi. */
  html: string;
  /** Yalnızca `buildUnsubscribeHeaders` çıktısı. */
  unsubscribeHeaders?: readonly [string, string][];
}

export interface MimeMessage {
  raw: string;
  sizeBytes: number;
  boundary: string;
}

const UNSUBSCRIBE_HEADER_NAMES = new Set(["List-Unsubscribe", "List-Unsubscribe-Post"]);
const MAX_REFERENCES = 20;

export function buildMimeMessage(
  input: MimeInput,
  random: (size: number) => Buffer = crypto.randomBytes,
): MimeMessage {
  if (!isValidMessageId(input.messageId)) {
    throw new MimeError("invalid_message_id", "Geçersiz Message-ID.");
  }
  if (input.inReplyTo && !isValidMessageId(input.inReplyTo)) {
    throw new MimeError("invalid_message_id", "Geçersiz In-Reply-To.");
  }
  const refs = input.references ?? [];
  if (refs.length > MAX_REFERENCES || refs.some((r) => !isValidMessageId(r))) {
    throw new MimeError("invalid_message_id", "Geçersiz References.");
  }
  if (input.language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language)) {
    throw new MimeError("invalid_input", "Geçersiz dil etiketi.");
  }
  if (!input.subject.trim()) throw new MimeError("invalid_input", "Konu boş olamaz.");

  const headers: [string, string][] = [
    ["From", formatAddress(input.from.address, input.from.name)],
    ["To", formatAddress(input.to.address, input.to.name)],
    ["Subject", encodeUnstructured(input.subject)],
    ["Date", formatDate(input.date)],
    ["Message-ID", input.messageId],
  ];
  if (input.inReplyTo) headers.push(["In-Reply-To", input.inReplyTo]);
  if (refs.length > 0) headers.push(["References", refs.join(" ")]);
  for (const [name, value] of input.unsubscribeHeaders ?? []) {
    if (!UNSUBSCRIBE_HEADER_NAMES.has(name)) {
      throw new MimeError("invalid_input", `İzin verilmeyen başlık: ${name}`);
    }
    headers.push([name, value]);
  }
  if (input.language) headers.push(["Content-Language", input.language]);

  const boundary = `=_um_${random(18).toString("hex")}`;
  headers.push(["MIME-Version", "1.0"]);
  headers.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);

  const textBody = encodeQuotedPrintable(input.text);
  const htmlBody = encodeQuotedPrintable(input.html);
  if (textBody.includes(boundary) || htmlBody.includes(boundary)) {
    throw new MimeError("invalid_input", "Ayraç gövdede geçiyor.");
  }

  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=utf-8`,
      "Content-Transfer-Encoding: quoted-printable",
      "",
      body,
    ].join(CRLF);

  const raw = [
    ...headers.map(([n, v]) => foldHeader(n, v)),
    "",
    "This is a multi-part message in MIME format.",
    "",
    part("text/plain", textBody),
    part("text/html", htmlBody),
    `--${boundary}--`,
    "",
  ].join(CRLF);

  // Son güvence: çıplak CR/LF yok, satır uzunluğu sınırı aşılmıyor, yalnızca 7 bit ASCII.
  if (/\r(?!\n)|(?<!\r)\n/.test(raw)) throw new MimeError("header_injection", "Çıplak CR/LF.");
  if (raw.split(CRLF).some((l) => l.length > HARD_LINE)) {
    throw new MimeError("line_too_long", "Satır 998 karakteri aşıyor.");
  }
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(raw)) {
    throw new MimeError("invalid_input", "İleti 7 bit ASCII olmalıdır.");
  }
  const sizeBytes = Buffer.byteLength(raw, "ascii");
  if (sizeBytes > MAX_MESSAGE_BYTES) {
    throw new MimeError("too_large", `İleti ${MAX_MESSAGE_BYTES} baytı aşıyor.`);
  }
  return { raw, sizeBytes, boundary };
}
