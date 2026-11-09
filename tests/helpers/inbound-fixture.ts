import { eq } from "drizzle-orm";
import { hashEmail } from "@/lib/compliance/suppression";
import { utcDay } from "@/lib/compliance/frequency";
import type { Db } from "@/lib/db/client";
import { campaignLeads, mailboxes, messages } from "@/lib/db/schema";
import { SIMULATED_DSN_PASS, SIMULATED_PASS } from "@/lib/mail/inbound/fake-inbox";
import type { Attestation } from "@/lib/mail/inbound/evidence";
import { generateMessageId } from "@/lib/mail/mime/message-id";
import { addSequence, DEMO_MAILBOX, T0 } from "./campaign-fixture";

export { SIMULATED_DSN_PASS, SIMULATED_PASS };
export const NOW = T0 + 3_600_000; // gönderimden 1 saat sonra

export interface Sent {
  cl: number;
  leadId: number;
  email: string;
  rfc: string;
  outboundId: number;
}

/** Bir kampanya alıcısı ve ona "gönderilmiş" (kabul edilmiş) kampanya iletisi ekler. */
export async function seedSent(
  db: Db,
  campaignId: number,
  o: {
    email?: string;
    sentAt?: number;
    purpose?: "campaign" | "test";
    mailboxId?: number;
    status?: "sent" | "failed" | "unknown" | "queued";
    step?: number;
    clId?: number;
    leadId?: number;
  } = {},
): Promise<Sent> {
  const base = o.clId
    ? { cl: o.clId, leadId: o.leadId!, email: o.email! }
    : await addSequence(db, campaignId, { email: o.email });
  const step = o.step ?? 0;
  const sentAt = o.sentAt ?? T0 + step * 5 * 86_400_000;
  const rfc = generateMessageId("universal-mail.invalid", sentAt);
  const purpose = o.purpose ?? "campaign";
  const [m] = await db
    .insert(messages)
    .values({
      direction: "out",
      purpose,
      campaignId: purpose === "campaign" ? campaignId : null,
      campaignLeadId: purpose === "campaign" ? base.cl : null,
      leadId: base.leadId,
      mailboxId: o.mailboxId ?? DEMO_MAILBOX,
      stepIndex: step,
      idempotencyKey: purpose === "campaign" ? `cl:${base.cl}:s:${step}` : null,
      rfcMessageId: rfc,
      fromAddress: "demo@universal-mail.invalid",
      toAddress: base.email,
      peerHash: hashEmail(base.email),
      peerDomain: base.email.split("@")[1]!,
      sendDay: purpose === "campaign" ? utcDay(sentAt) : null,
      subjectLogged: "Merhaba",
      bodySha256: "x".repeat(64),
      status: o.status ?? "sent",
      createdAt: sentAt,
      sentAt: (o.status ?? "sent") === "sent" ? sentAt : null,
    })
    .returning({ id: messages.id });
  await db
    .update(campaignLeads)
    .set({ status: "waiting_next", nextSendAt: sentAt + 5 * 86_400_000, lastSentAt: sentAt })
    .where(eq(campaignLeads.id, base.cl));
  return { cl: base.cl, leadId: base.leadId, email: base.email, rfc, outboundId: m!.id };
}

export async function addMailbox(
  db: Db,
  o: { provider: "demo" | "gmail"; address: string; status?: "connected" | "not_configured" },
): Promise<number> {
  const [r] = await db
    .insert(mailboxes)
    .values({
      provider: o.provider,
      label: "Test",
      address: o.address,
      status: o.status ?? "connected",
      credentialsRef: o.provider === "demo" ? null : "x",
      createdAt: T0,
      updatedAt: T0,
    })
    .returning({ id: mailboxes.id });
  return r!.id;
}

const CRLF = "\r\n";

/** Serbest biçimli yanıt/çıkış iletisi (gönderen ve kimlikler çağıran tarafından seçilir). */
export function rawMessage(o: {
  from: string;
  to?: string;
  subject?: string;
  inReplyTo?: string | null;
  body?: string;
  extraHeaders?: string[];
  nonce: string;
}): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to ?? "demo@universal-mail.invalid"}`,
    `Subject: ${o.subject ?? "Re: Hello"}`,
    `Message-ID: <m-${o.nonce}@mail.demo.invalid>`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    "Content-Type: text/plain; charset=utf-8",
    ...(o.extraHeaders ?? []),
    "",
    o.body ?? "Thanks.",
    "",
  ].join(CRLF);
}

/** DSN; alıcı/durum/yapı çağıran tarafından değiştirilebilir. */
export function rawDsn(o: {
  outboundMessageId: string;
  recipient: string;
  status?: string;
  action?: string;
  nonce: string;
  structural?: boolean;
  from?: string;
}): string {
  const b = `b-${o.nonce}`;
  return [
    `From: ${o.from ?? "MAILER-DAEMON <mailer-daemon@mx.demo.invalid>"}`,
    "To: demo@universal-mail.invalid",
    "Subject: Delivery Status Notification (Failure)",
    `Message-ID: <dsn-${o.nonce}@mx.demo.invalid>`,
    o.structural === false
      ? "Content-Type: text/plain"
      : `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
    "",
    ...(o.structural === false
      ? ["Delivery failed."]
      : [
          `--${b}`,
          "Content-Type: text/plain",
          "",
          "Delivery failed.",
          `--${b}`,
          "Content-Type: message/delivery-status",
          "",
          "Reporting-MTA: dns; mx.demo.invalid",
          "",
          `Final-Recipient: rfc822; ${o.recipient}`,
          `Action: ${o.action ?? "failed"}`,
          `Status: ${o.status ?? "5.1.1"}`,
          "",
          `--${b}`,
          "Content-Type: message/rfc822",
          "",
          `Message-ID: ${o.outboundMessageId}`,
          "",
          `--${b}--`,
        ]),
    "",
  ].join(CRLF);
}

export const FAIL_AUTH: Attestation = {
  source: "demo_simulated",
  senderAuth: "fail",
  nullReturnPath: true,
};
export const NO_NULL_PATH: Attestation = {
  source: "demo_simulated",
  senderAuth: "pass",
  nullReturnPath: false,
};
