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
  /**
   * Faz 4 (9d): takip iletisinin ait olduğu sağlayıcı konuşması (Gmail `threadId`). Yalnızca aynı dizinin önceki
   * kabul edilmiş iletisinden gelir; yoksa veya geçersizse sağlayıcı yok sayar (bugünkü davranış).
   */
  threadId?: string;
}

export type ProviderResult =
  | { status: "accepted"; providerMessageId: string; acceptedAt: number; threadId?: string }
  /** `retryAfterMs`: sağlayıcının bildirdiği bekleme süresi (ör. 429); geçici retlerde bundan önce denenmez. */
  | { status: "rejected"; code: string; permanent: boolean; retryAfterMs?: number }
  | { status: "unknown"; code: string };

export interface MailProvider {
  readonly id: "demo" | "gmail";
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
 * DEMO kapsamındaki posta kutusu için sağlayıcı: yalnızca demo kutusuna sahte sağlayıcı döner; Gmail, SMTP ve diğer
 * her sağlayıcı için hata verir. Testler kendi sağlayıcısını doğrudan verebilir.
 *
 * Canlı kapsam bu fabrikadan GEÇMEZ: `sendCampaignStep` canlı kutu için önce canlı gönderim kapısını
 * (`isLiveSendingPermitted`) denetler, sonra `getLiveProvider` (`../gmail/provider`) ile Gmail bağdaştırıcısını kurar.
 */
export function getProvider(mailbox: { provider: string }): MailProvider {
  if (policyScopeForMailbox(mailbox.provider) === "demo") {
    demoProvider ??= new FakeMailProvider();
    return demoProvider;
  }
  // Canlı sağlayıcı burada kurulmaz (bkz. `getLiveProvider`); SMTP sağlayıcısı yoktur.
  throw new ProviderUnavailableError(mailbox.provider);
}
