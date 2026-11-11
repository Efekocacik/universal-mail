import type { Attestation } from "./evidence";
import type { InboundEnvelope } from "./process";
import type { InboxFetchResult, InboxReader } from "./sync";

/**
 * Demo gelen kutusu. Ağa HİÇ çıkmaz; iletiler yalnızca bellekte tutulur (süreç kapanınca kaybolur).
 *
 * DÜRÜSTLÜK: Buradaki tasdik (`demo_simulated`) bir SİMÜLASYONDUR; gerçek SPF/DKIM/DMARC doğrulaması değildir.
 * Gerçek sağlayıcı bağdaştırıcıları kendi tasdiklerini üretmelidir.
 */

export class FakeInbox implements InboxReader {
  readonly id = "demo" as const;
  private readonly queue: InboundEnvelope[] = [];

  deliver(env: InboundEnvelope): void {
    this.queue.push(env);
  }

  get size(): number {
    return this.queue.length;
  }

  async fetch(mailboxId: number, cursor: string | null, limit: number): Promise<InboxFetchResult> {
    const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const all = this.queue.map((e, i) => ({ e, i })).filter((x) => x.e.mailboxId === mailboxId);
    const slice = all.filter((x) => x.i >= start).slice(0, limit);
    const last = slice.at(-1);
    return {
      items: slice.map((x) => x.e),
      nextCursor: last ? String(last.i + 1) : cursor,
    };
  }
}

let demoInbox: FakeInbox | null = null;
/** Uygulama genelinde tek demo gelen kutusu. */
export function getDemoInbox(): FakeInbox {
  demoInbox ??= new FakeInbox();
  return demoInbox;
}

/** Simülasyon tasdikleri. Etiketleri, bunların gerçek doğrulama OLMADIĞINI açıkça taşır. */
export const SIMULATED_PASS: Attestation = {
  source: "demo_simulated",
  senderAuth: "pass",
  nullReturnPath: false,
};
export const SIMULATED_DSN_PASS: Attestation = { ...SIMULATED_PASS, nullReturnPath: true };

export type DemoScenario =
  | "hard_bounce"
  | "hard_bounce_unattested"
  | "soft_bounce"
  | "reply"
  | "reply_unattested"
  | "unsubscribe"
  | "negative"
  | "auto_reply";

export interface ScenarioInput {
  scenario: DemoScenario;
  mailboxAddress: string;
  /** Hedef giden iletinin Message-ID'si ve alıcı adresi (demo kampanya alıcısı). */
  outboundMessageId: string;
  recipient: string;
  /** Benzersizlik için (ham özet). */
  nonce: string;
}

const CRLF = "\r\n";

/** Demo senaryosu için ham ileti ve tasdik üretir (yalnızca demo gelen kutusu ve testlerde kullanılır). */
export function buildScenario(i: ScenarioInput): { raw: string; attestation: Attestation | null } {
  const b = `um-${i.nonce}`;
  const common = (from: string, subject: string, extra: string[] = []) => [
    `From: ${from}`,
    `To: ${i.mailboxAddress}`,
    `Subject: ${subject}`,
    `Date: Mon, 02 Nov 2026 10:05:00 +0000`,
    ...extra,
  ];

  if (
    i.scenario === "hard_bounce" ||
    i.scenario === "hard_bounce_unattested" ||
    i.scenario === "soft_bounce"
  ) {
    const hard = i.scenario !== "soft_bounce";
    const raw = [
      ...common(
        "MAILER-DAEMON <mailer-daemon@mx.demo.invalid>",
        "Delivery Status Notification (Failure)",
        [
          `Message-ID: <dsn-${i.nonce}@mx.demo.invalid>`,
          `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
        ],
      ),
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Delivery failed.",
      `--${b}`,
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.demo.invalid",
      "",
      `Final-Recipient: rfc822; ${i.recipient}`,
      `Action: ${hard ? "failed" : "delayed"}`,
      `Status: ${hard ? "5.1.1" : "4.2.2"}`,
      "",
      `--${b}`,
      "Content-Type: message/rfc822",
      "",
      `Message-ID: ${i.outboundMessageId}`,
      `From: ${i.mailboxAddress}`,
      `To: ${i.recipient}`,
      "",
      `--${b}--`,
      "",
    ].join(CRLF);
    return {
      raw,
      attestation: i.scenario === "hard_bounce_unattested" ? null : SIMULATED_DSN_PASS,
    };
  }

  const reply = (subject: string, body: string, extra: string[] = [], from = i.recipient) =>
    [
      ...common(from, subject, [
        `Message-ID: <rep-${i.nonce}@mail.demo.invalid>`,
        `In-Reply-To: ${i.outboundMessageId}`,
        `References: ${i.outboundMessageId}`,
        "Content-Type: text/plain; charset=utf-8",
        ...extra,
      ]),
      "",
      body,
      "",
    ].join(CRLF);

  switch (i.scenario) {
    case "reply":
      return {
        raw: reply("Re: Hello", "Thanks, we would like to see your catalogue."),
        attestation: SIMULATED_PASS,
      };
    case "reply_unattested":
      return {
        raw: reply("Re: Hello", "Thanks, we would like to see your catalogue."),
        attestation: null,
      };
    case "unsubscribe":
      return {
        raw: reply("Re: Hello", "Please unsubscribe me from your list."),
        attestation: SIMULATED_PASS,
      };
    case "negative":
      return {
        raw: reply("Re: Hello", "Thank you, but we are not interested."),
        attestation: SIMULATED_PASS,
      };
    default:
      return {
        raw: reply("Automatic reply: Hello", "I am out of office.", [
          "Auto-Submitted: auto-replied",
        ]),
        attestation: SIMULATED_PASS,
      };
  }
}
