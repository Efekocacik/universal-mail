import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { FakeMailProvider } from "./fake-provider";

/**
 * Posta sağlayıcısı sözleşmesi.
 *
 * Sonuç üç türlüdür ve yeniden deneme güvenliği buna dayanır:
 *  - `accepted`: sağlayıcı iletiyi kabul etti.
 *  - `rejected`: ileti KESİNLİKLE gönderilmedi (sağlayıcı açıkça bildirdi). Yalnızca bu sonuç yeniden denenebilir.
 *  - `unknown`: gönderilmiş olabilir. Çağrı başladıktan sonraki her beklenmeyen hata, iptal ve zaman aşımı da
 *    `unknown` sayılır. Otomatik yeniden gönderilmez.
 */

export interface ProviderSendInput {
  /** RFC 5322 ileti (CRLF, 7 bit). */
  raw: string;
  from: string;
  to: string;
  messageId: string;
  signal: AbortSignal;
}

export type ProviderResult =
  | { status: "accepted"; providerMessageId: string; acceptedAt: number }
  /** `retryAfterMs`: sağlayıcının bildirdiği bekleme süresi (ör. 429); geçici retlerde bundan önce denenmez. */
  | { status: "rejected"; code: string; permanent: boolean; retryAfterMs?: number }
  | { status: "unknown"; code: string };

export interface MailProvider {
  readonly id: "demo";
  send(input: ProviderSendInput): Promise<ProviderResult>;
}

export class ProviderUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`Posta sağlayıcısı kullanılamıyor: ${provider}`);
  }
}

/** Uygulama genelinde tek demo sağlayıcısı (giden kutusu yalnızca bellekte). */
let demoProvider: FakeMailProvider | null = null;

/**
 * Posta kutusuna göre sağlayıcı. Bu sürümde YALNIZCA demo kutusu için sahte sağlayıcı döner; Gmail, SMTP ve diğer
 * her sağlayıcı için hata verir (gerçek gönderim kapalıdır). Testler kendi sağlayıcısını doğrudan verebilir.
 */
export function getProvider(mailbox: { provider: string }): MailProvider {
  if (policyScopeForMailbox(mailbox.provider) === "demo") {
    demoProvider ??= new FakeMailProvider();
    return demoProvider;
  }
  // Gerçek sağlayıcı (Gmail, SMTP) bu sürümde YAZILMADI; LIVE_SENDING_ENABLED açılsa bile kullanılamaz.
  throw new ProviderUnavailableError(mailbox.provider);
}
