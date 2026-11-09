import { and, eq, gte, sql } from "drizzle-orm";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { hashEmail } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes, messages } from "@/lib/db/schema";
import { parseEmail } from "@/lib/email/address";
import { getSetting } from "@/lib/settings";
import { buildEmailMessage, MessageBuildError } from "./mime/message-builder";
import { getProvider, ProviderUnavailableError, type MailProvider } from "./provider/provider";
import { composeEmail, type ComposeIssue } from "./template-service";

/**
 * "Kendime test gönder" (FR-TPL-07, Aşama 13). YALNIZCA demo posta kutusu ve demo sağlayıcısı; alıcı her zaman
 * posta kutusunun KENDİ adresidir (serbest alıcı girilemez). `purpose="test"` olduğundan kampanya sayaçlarını,
 * günlük tavanı, temas sıklığını ve alan adı sınırını etkilemez, otomatik durdurma payına/paydasına girmez ve
 * bu iletiye gelen hiçbir bounce/yanıt etki üretmez. İçerik ve alt bilgi, gerçek gönderimle AYNI kod yolundan geçer.
 */

export const TEST_SEND_HOURLY_LIMIT = 10;
export const TEST_SEND_TIMEOUT_MS = 15_000;

export type TestSendErrorKind =
  "mailbox_not_found" | "live_scope" | "mailbox_not_ready" | "rate_limited" | "build_failed";

export class TestSendError extends Error {
  constructor(
    readonly kind: TestSendErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type TestSendResult =
  | { outcome: "sent"; messageRowId: number }
  | { outcome: "not_sendable"; errors: ComposeIssue[] }
  | { outcome: "failed" | "unknown"; messageRowId: number; code: string };

export async function sendTestEmail(
  db: Db,
  input: { mailboxId: number; templateId: number; leadId: number },
  opts: { now?: () => number; provider?: MailProvider; timeoutMs?: number } = {},
): Promise<TestSendResult> {
  const clock = opts.now ?? Date.now;
  const now = clock();

  const [mailbox] = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.id, input.mailboxId))
    .limit(1);
  if (!mailbox) throw new TestSendError("mailbox_not_found", "Posta kutusu bulunamadı.");
  if (policyScopeForMailbox(mailbox.provider) !== "demo") {
    throw new TestSendError(
      "live_scope",
      "Test gönderimi bu sürümde yalnızca demo posta kutusuyla yapılır.",
    );
  }
  const self = mailbox.address ? parseEmail(mailbox.address) : null;
  if (mailbox.status !== "connected" || !self) {
    throw new TestSendError("mailbox_not_ready", "Posta kutusu hazır değil.");
  }

  const hourAgo = now - 3_600_000;
  const [recent] = await db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .where(
      and(
        eq(messages.purpose, "test"),
        eq(messages.mailboxId, mailbox.id),
        gte(messages.createdAt, hourAgo),
      ),
    );
  if (Number(recent?.n ?? 0) >= TEST_SEND_HOURLY_LIMIT) {
    throw new TestSendError("rate_limited", "Saatlik test gönderimi sınırına ulaşıldı.");
  }

  const composed = await composeEmail(db, {
    templateId: input.templateId,
    leadId: input.leadId,
    mode: "demo",
    purpose: "send",
  });
  if (!composed.sendable) return { outcome: "not_sendable", errors: composed.errors };

  const profile = await getSetting(db, "company.profile");
  const tagged = { ...composed, subject: `[TEST] ${composed.subject}` };
  let built;
  try {
    built = buildEmailMessage({
      composed: tagged,
      mailbox: { provider: mailbox.provider, address: mailbox.address, status: mailbox.status },
      profile,
      recipient: self.email,
      mode: "demo",
      now,
    });
  } catch (e) {
    if (e instanceof MessageBuildError)
      throw new TestSendError("build_failed", "Test iletisi oluşturulamadı.");
    throw e;
  }

  const [row] = await db
    .insert(messages)
    .values({
      direction: "out",
      purpose: "test",
      leadId: input.leadId,
      mailboxId: mailbox.id,
      templateId: composed.templateId,
      templateVersion: composed.templateVersion,
      rfcMessageId: built.messageId,
      fromAddress: built.from,
      toAddress: built.to,
      peerHash: hashEmail(built.to),
      peerDomain: built.to.slice(built.to.lastIndexOf("@") + 1),
      subjectLogged: `[TEST] ${composed.subjectLogged}`,
      bodySha256: composed.bodySha256,
      status: "sending",
      createdAt: now,
    })
    .returning({ id: messages.id });
  const rowId = row!.id;

  let status: "sent" | "failed" | "unknown" = "unknown";
  let code = "unexpected";
  let providerMessageId: string | null = null;
  try {
    const provider = opts.provider ?? getProvider(mailbox);
    const res = await provider.send({
      raw: built.raw,
      from: built.from,
      to: built.to,
      messageId: built.messageId,
      signal: AbortSignal.timeout(
        Math.min(opts.timeoutMs ?? TEST_SEND_TIMEOUT_MS, TEST_SEND_TIMEOUT_MS),
      ),
    });
    if (res.status === "accepted") {
      status = "sent";
      code = "";
      providerMessageId = res.providerMessageId;
    } else if (res.status === "rejected") {
      status = "failed";
      code = res.code;
    } else {
      code = res.code;
    }
  } catch (e) {
    if (e instanceof ProviderUnavailableError) {
      status = "failed";
      code = "provider_unavailable";
    } else code = "provider_error";
  }

  const done = clock();
  await db
    .update(messages)
    .set({
      status,
      providerMessageId,
      sentAt: status === "sent" ? done : null,
      errorCode: code || null,
    })
    .where(eq(messages.id, rowId));
  await audit(db, "mail.test_sent", "message", rowId, { status, mailboxId: mailbox.id }, done);
  return status === "sent"
    ? { outcome: "sent", messageRowId: rowId }
    : { outcome: status, messageRowId: rowId, code };
}
