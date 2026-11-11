import { parseEmail } from "@/lib/email/address";
import { isSafeLiveUnsubscribeUrl } from "../footer";
import { MimeError } from "./headers";

/**
 * Çıkış başlıkları (RFC 2369 List-Unsubscribe, RFC 8058 List-Unsubscribe-Post; SRS FR-CMP-08).
 *
 *  - DEMO: hiçbir çıkış başlığı eklenmez. Demo bağlantısı (`.invalid`) çalışan bir hizmet değildir; posta
 *    istemcilerinin "Abonelikten çık" düğmesi gibi gerçek bir işlev izlenimi verilmez. Çıkış bilgisi demo alt
 *    bilgisinde "DEMO" işaretiyle yer alır.
 *  - LIVE: `List-Unsubscribe` yalnızca güvenli HTTPS bağlantısıyla (ve isteğe bağlı gerçek bir çıkış adresiyle).
 *    `List-Unsubscribe-Post` (tek tıklamalı çıkış) YALNIZCA çağıran, POST isteklerini işleyen çalışan bir uç
 *    noktanın varlığını açıkça bildirdiğinde (`oneClickEndpointVerified: true`) eklenir; varsayılan olarak eklenmez.
 *  - Bağlantı veya adres yoksa başlık uydurulmaz; live için bu durum hatadır.
 */

export interface UnsubscribeHeaderInput {
  mode: "demo" | "live";
  /** Alt bilgideki çıkış bağlantısıyla AYNI olmalıdır. */
  url?: string | null;
  /** Şirketin gerçek çıkış e-posta adresi (ör. optout@…); yoksa eklenmez. */
  mailto?: string | null;
  /** Bağlantının RFC 8058 tek tıklamalı POST isteğini işleyen çalışan bir uç nokta olduğu doğrulandı mı? */
  oneClickEndpointVerified?: boolean;
}

export function buildUnsubscribeHeaders(input: UnsubscribeHeaderInput): [string, string][] {
  if (input.mode === "demo") return [];

  if (!isSafeLiveUnsubscribeUrl(input.url)) {
    throw new MimeError(
      "invalid_input",
      "Gerçek gönderim için güvenli (HTTPS) çıkış bağlantısı gerekir.",
    );
  }
  const url = input.url!;
  if (/[<>,\s]/.test(url)) {
    throw new MimeError("header_injection", "Çıkış bağlantısı başlığa uygun değil.");
  }
  const entries = [`<${url}>`];
  if (input.mailto) {
    const parsed = parseEmail(input.mailto);
    if (!parsed || parsed.email !== input.mailto) {
      throw new MimeError("invalid_address", "Geçersiz çıkış e-posta adresi.");
    }
    entries.push(`<mailto:${parsed.email}?subject=unsubscribe>`);
  }
  const headers: [string, string][] = [["List-Unsubscribe", entries.join(", ")]];
  if (input.oneClickEndpointVerified === true) {
    headers.push(["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"]);
  }
  return headers;
}
