import crypto from "node:crypto";
import { DEMO_MESSAGE_ID_DOMAIN } from "../mime/message-id";
import type { MailProvider, ProviderResult, ProviderSendInput } from "./provider";

/**
 * Demo posta sağlayıcısı. Ağa HİÇ çıkmaz; "gönderilen" iletileri yalnızca bellekteki giden kutusunda tutar (diske
 * veya veritabanına yazılmaz; süreç kapanınca kaybolur).
 *
 * Yalnızca demo iletilerini kabul eder: gönderen ve Message-ID `.invalid` alan adında olmalıdır. Aksi halde ileti
 * saklanmaz ve kesin ret döner.
 *
 * Davranış yalnızca kurucuda verilen senaryoyla belirlenir (çalışma anında değiştirilemez). Senaryo sırayla tüketilir;
 * bittiğinde varsayılan `accept` kullanılır.
 */

export type FakeStep =
  | { kind: "accept"; delayMs?: number }
  | { kind: "reject"; code?: string; permanent?: boolean; retryAfterMs?: number }
  /** İleti saklanmadan bağlantı koptu: gönderilmemiş olabilir ama sağlayıcı kesinlik vermiyor. */
  | { kind: "unknown-before" }
  /** İleti saklandı (gerçekte gitti) ama yanıt alınamadı. */
  | { kind: "unknown-after" }
  /** İleti saklandı, ardından beklenmeyen istisna. */
  | { kind: "throw-after" }
  /** Yanıt hiç gelmez; yalnızca iptal (zaman aşımı) ile biter. `deliverOnAbort`: iptal anında ileti gitmiş sayılır. */
  | { kind: "hang"; deliverOnAbort?: boolean };

export interface OutboxEntry {
  providerMessageId: string;
  messageId: string;
  from: string;
  to: string;
  raw: string;
  acceptedAt: number;
}

const DEMO_SUFFIX = ".invalid";

export class FakeMailProvider implements MailProvider {
  readonly id = "demo" as const;
  private readonly script: FakeStep[];
  private readonly box: OutboxEntry[] = [];
  private readonly clock: () => number;
  /** Sağlayıcıya ulaşan çağrı sayısı (test gözlemi için). */
  calls = 0;

  constructor(opts: { script?: readonly FakeStep[]; now?: () => number } = {}) {
    this.script = [...(opts.script ?? [])];
    this.clock = opts.now ?? Date.now;
  }

  /** Giden kutusunun kopyası (yalnızca okuma). */
  get outbox(): readonly OutboxEntry[] {
    return [...this.box];
  }

  private store(input: ProviderSendInput): OutboxEntry {
    const entry: OutboxEntry = {
      providerMessageId: `demo-${crypto.randomBytes(12).toString("hex")}`,
      messageId: input.messageId,
      from: input.from,
      to: input.to,
      raw: input.raw,
      acceptedAt: this.clock(),
    };
    this.box.push(entry);
    return entry;
  }

  async send(input: ProviderSendInput): Promise<ProviderResult> {
    this.calls++;
    if (
      !input.from.endsWith(DEMO_SUFFIX) ||
      !input.messageId.endsWith(`@${DEMO_MESSAGE_ID_DOMAIN}>`)
    ) {
      return { status: "rejected", code: "demo_only", permanent: true };
    }
    if (input.signal.aborted)
      return { status: "rejected", code: "aborted_before_send", permanent: false };

    const step = this.script.shift() ?? { kind: "accept" };
    switch (step.kind) {
      case "accept": {
        if (step.delayMs) await this.wait(step.delayMs, input.signal, () => this.store(input));
        const e = step.delayMs ? this.box[this.box.length - 1]! : this.store(input);
        return {
          status: "accepted",
          providerMessageId: e.providerMessageId,
          acceptedAt: e.acceptedAt,
        };
      }
      case "reject":
        return {
          status: "rejected",
          code: step.code ?? "rejected",
          permanent: step.permanent ?? true,
          ...(step.retryAfterMs !== undefined ? { retryAfterMs: step.retryAfterMs } : {}),
        };
      case "unknown-before":
        return { status: "unknown", code: "connection_lost" };
      case "unknown-after":
        this.store(input);
        return { status: "unknown", code: "no_response" };
      case "throw-after":
        this.store(input);
        throw new Error("demo sağlayıcı: beklenmeyen hata");
      case "hang":
        await new Promise<never>((_, reject) => {
          input.signal.addEventListener(
            "abort",
            () => {
              if (step.deliverOnAbort) this.store(input);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
    }
  }

  /**
   * Gecikmeli tamamlama: süre dolunca ileti saklanır ve kabul döner. İptal edilirse yine de "teslim edilir"
   * (gerçek sağlayıcılarda yanıt geç gelse de ileti gitmiş olabilir) ve istisna fırlatılır.
   */
  private wait(ms: number, signal: AbortSignal, deliver: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        deliver();
        resolve();
      }, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          deliver();
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }
}
