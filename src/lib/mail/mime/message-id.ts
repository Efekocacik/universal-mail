import crypto from "node:crypto";
import { normalizeDomain } from "@/lib/compliance/suppression";
import { MimeError } from "./headers";

/**
 * Message-ID (RFC 5322 3.6.4): `<zaman36.rastgele128bit@alanadi>`.
 * Benzersizlik kriptografik rastgelelikten gelir; veritabanındaki benzersiz dizin (`messages_rfc_uq`) ikinci güvencedir.
 * Alan adı: live için gönderen posta kutusunun alan adı, demo için hiçbir zaman çözülmeyen `universal-mail.invalid`.
 */

export const DEMO_MESSAGE_ID_DOMAIN = "universal-mail.invalid";

/** dot-atom-text @ dot-atom-text, köşeli parantez içinde; RFC 5322 id-left/id-right'ın pratik alt kümesi. */
const MESSAGE_ID_RE =
  /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+>$/;

export function isValidMessageId(value: string): boolean {
  return value.length <= 250 && MESSAGE_ID_RE.test(value);
}

export function generateMessageId(
  domain: string,
  now: number,
  random: (size: number) => Buffer = crypto.randomBytes,
): string {
  const host = normalizeDomain(domain);
  if (!host) throw new MimeError("invalid_message_id", "Message-ID için geçersiz alan adı.");
  const id = `<${Math.max(0, Math.floor(now)).toString(36)}.${random(16).toString("hex")}@${host}>`;
  if (!isValidMessageId(id)) throw new MimeError("invalid_message_id", "Message-ID üretilemedi.");
  return id;
}
