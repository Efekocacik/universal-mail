import { and, eq, gte, sql } from "drizzle-orm";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { hashEmail, maskEmail } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes, messages } from "@/lib/db/schema";
import { parseEmail } from "@/lib/email/address";
import { getSetting, settingSchemas } from "@/lib/settings";
import { prepareSelfTestUnsubscribe } from "@/lib/unsubscribe/endpoint";
import { getSelfTestProvider } from "./gmail/provider";
import { buildEmailMessage, MessageBuildError } from "./mime/message-builder";
import { getProvider, ProviderUnavailableError, type MailProvider } from "./provider/provider";
import { RECORD_RETRIES, STALE_SENDING_MS, isBusyError } from "./send-service";
import { composeEmail, type ComposeIssue } from "./template-service";

/**
 * "Kendime test gönder" (FR-TPL-07, Aşama 13; gerçek kutu: C11). Alıcı HER ZAMAN posta kutusunun KENDİ adresidir
 * (serbest alıcı girilemez; adres birebir eşleşmezse ileti oluşturulmaz ve sağlayıcı ağ isteği atmadan reddeder).
 *
 *  - DEMO kutusu: demo sağlayıcısı (bellek içi), önceki davranış.
 *  - GERÇEK Gmail kutusu (C11, canlıya geçiş öncesi doğrulama adımı): gerçek Gmail bağdaştırıcısıyla GERÇEK bir e-posta
 *    kutunun kendi adresine gider. `LIVE_SENDING_ENABLED` ve `LEGAL_APPROVALS`'tan BAĞIMSIZDIR, ancak şunları ister:
 *    kutu Gmail, bağlı ve gönderim izni (gmail.send) verilmiş; firma profili geçerli. Alt bilgi ve MIME, gerçek
 *    gönderimle AYNI kod yolundan geçer. Çıkış uç noktası doğrulanmışsa iletiye gerçek HTTPS tek tıklamalı çıkış
 *    başlıkları (alıcıya bağlı olmayan SINAMA belirteciyle: kendi adresiniz engellenmez) eklenir; değilse ileti
 *    `List-Unsubscribe` OLMADAN oluşturulur. Her iki durumda da konu "[TEST]" önekli ve alt bilgi "[TEST]" işaretlidir.
 *  - `purpose="test"`: kampanya sayaçlarını, günlük tavanı, temas sıklığını ve alan adı sınırını etkilemez, otomatik
 *    durdurma payına/paydasına girmez ve bu iletiye gelen hiçbir bounce/yanıt etki üretmez.
 *  - Sınırlar: kutu başına saatte 10; gerçek kutuda ayrıca son 24 saatte 10. Aynı kutuda süren (`sending`) bir test
 *    varken yenisi başlatılmaz (çift tıklama iki ileti göndermez).
 *  - Sonuç belirsizse (`unknown`) OTOMATİK YENİDEN GÖNDERİLMEZ; ileti, belirsiz gönderimler inceleme kuyruğunda (C7)
 *    görünür. Denetim kaydında alıcı yalnızca maskeli yazılır.
 */

export const TEST_SEND_HOURLY_LIMIT = 10;
/** Gerçek (Gmail) kutu için son 24 saatteki en fazla kendine test gönderimi. */
export const TEST_SEND_DAILY_LIMIT = 10;
export const TEST_SEND_TIMEOUT_MS = 15_000;
export const TEST_SUBJECT_PREFIX = "[TEST] ";

export type TestSendErrorKind =
  | "mailbox_not_found"
  | "live_scope"
  | "mailbox_not_ready"
  | "send_scope_missing"
  | "profile_incomplete"
  | "rate_limited"
  | "in_progress"
  | "build_failed";

export class TestSendError extends Error {
  constructor(
    readonly kind: TestSendErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type TestSendResult =
  | {
      outcome: "sent";
      messageRowId: number;
      scope: "demo" | "live";
      /** Gerçek kutu: iletiye `List-Unsubscribe` (tek tıklamalı) başlıkları eklendi mi? */
      listUnsubscribe: boolean;
      /**
       * Sağlayıcı sonucu VERİLDİ ama kaydı yazılamadı (veritabanı meşgul): kayıt `sending` kalır ve uzlaştırmada
       * `unknown` olur. Sonuç yine sağlayıcınınkidir; yeniden gönderim önerilmez.
       */
      recordError?: true;
    }
  | { outcome: "not_sendable"; errors: ComposeIssue[] }
  | {
      outcome: "failed" | "unknown";
      messageRowId: number;
      code: string;
      scope: "demo" | "live";
      listUnsubscribe: boolean;
      recordError?: true;
    };

function masked(address: string): string {
  const at = address.lastIndexOf("@");
  return maskEmail(address.slice(0, at), address.slice(at + 1));
}

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
  const scope = policyScopeForMailbox(mailbox.provider);
  if (scope === "live" && mailbox.provider !== "gmail") {
    throw new TestSendError(
      "live_scope",
      "Test gönderimi yalnızca demo veya Gmail posta kutusuyla yapılır.",
    );
  }
  const self = mailbox.address ? parseEmail(mailbox.address) : null;
  if (mailbox.status !== "connected" || !self) {
    throw new TestSendError("mailbox_not_ready", "Posta kutusu hazır değil.");
  }

  if (scope === "live") {
    const grants = await getSetting(db, "mail.gmailGrants");
    if (grants[String(mailbox.id)]?.send !== true) {
      throw new TestSendError(
        "send_scope_missing",
        "Bu Gmail kutusu için gönderim izni verilmemiş; kutuyu gönderim izniyle yeniden bağlayın.",
      );
    }
    const profile = settingSchemas["company.profile"]
      .unwrap()
      .safeParse(await getSetting(db, "company.profile"));
    if (!profile.success) {
      throw new TestSendError("profile_incomplete", "Firma profili eksik veya geçersiz.");
    }
  }

  // Gerçek kutu: uç nokta doğrulanmışsa gerçek tek tıklamalı çıkış bağlantısı (sınama belirteci), değilse yok.
  const unsubscribe = scope === "live" ? await prepareSelfTestUnsubscribe(db, now) : null;

  const composed = await composeEmail(db, {
    templateId: input.templateId,
    leadId: input.leadId,
    mode: scope,
    purpose: "send",
    ...(scope === "live" ? { selfTest: true } : {}),
    ...(unsubscribe ? { unsubscribeUrl: unsubscribe.url } : {}),
  });
  if (!composed.sendable) return { outcome: "not_sendable", errors: composed.errors };

  const profile = await getSetting(db, "company.profile");
  const tagged = { ...composed, subject: `${TEST_SUBJECT_PREFIX}${composed.subject}` };
  let built;
  try {
    built = buildEmailMessage({
      composed: tagged,
      mailbox: { provider: mailbox.provider, address: mailbox.address, status: mailbox.status },
      profile,
      recipient: self.email,
      mode: scope,
      now,
      ...(scope === "live" ? { selfTest: true } : {}),
      ...(unsubscribe
        ? { unsubscribe: { url: unsubscribe.url, oneClickEndpointVerified: unsubscribe.oneClick } }
        : {}),
    });
  } catch (e) {
    if (e instanceof MessageBuildError)
      throw new TestSendError("build_failed", "Test iletisi oluşturulamadı.");
    throw e;
  }
  const listUnsubscribe = unsubscribe !== null;

  // Sınırlar ve kayıt AYNI işlemde: eşzamanlı iki istek sınırı aşamaz, süren test varken ikincisi açılmaz.
  const rowId = await db.transaction(async (tx) => {
    const [inFlight] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.purpose, "test"),
          eq(messages.mailboxId, mailbox.id),
          eq(messages.status, "sending"),
          gte(messages.createdAt, now - STALE_SENDING_MS),
        ),
      );
    if (Number(inFlight?.n ?? 0) > 0) {
      throw new TestSendError("in_progress", "Bu kutuda süren bir test gönderimi var.");
    }
    const countSince = async (since: number) => {
      const [r] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(
            eq(messages.purpose, "test"),
            eq(messages.mailboxId, mailbox.id),
            gte(messages.createdAt, since),
          ),
        );
      return Number(r?.n ?? 0);
    };
    if ((await countSince(now - 3_600_000)) >= TEST_SEND_HOURLY_LIMIT) {
      throw new TestSendError("rate_limited", "Saatlik test gönderimi sınırına ulaşıldı.");
    }
    if (scope === "live" && (await countSince(now - 86_400_000)) >= TEST_SEND_DAILY_LIMIT) {
      throw new TestSendError("rate_limited", "Günlük test gönderimi sınırına ulaşıldı.");
    }
    const [row] = await tx
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
        subjectLogged: `${TEST_SUBJECT_PREFIX}${composed.subjectLogged}`,
        bodySha256: composed.bodySha256,
        status: "sending",
        createdAt: now,
      })
      .returning({ id: messages.id });
    return row!.id;
  });

  let status: "sent" | "failed" | "unknown" = "unknown";
  let code = "unexpected";
  let providerMessageId: string | null = null;
  try {
    const provider =
      opts.provider ?? (scope === "live" ? getSelfTestProvider(db, mailbox) : getProvider(mailbox));
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
  // Belirsiz sonuç (`unknown`) olduğu gibi kaydedilir: yeniden gönderim YOK; inceleme kuyruğunda görünür.
  // Durum ve denetim kaydı TEK işlemde yazılır; veritabanı meşgulse yalnızca KAYIT yeniden denenir. Yine yazılamazsa
  // hata FIRLATILMAZ: sağlayıcının sonucu döndürülür (`recordError`), kayıt `sending` kalır ve uzlaştırmada `unknown`
  // olur. Yalnızca hâlâ `sending` olan kayıt güncellenir (arada çalışmış bir uzlaştırmanın üzerine yazılmaz).
  let recordError = false;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(messages)
          .set({
            status,
            providerMessageId,
            sentAt: status === "sent" ? done : null,
            errorCode: code || null,
          })
          .where(and(eq(messages.id, rowId), eq(messages.status, "sending")));
        await audit(
          tx,
          "mail.test_sent",
          "message",
          rowId,
          {
            status,
            mailboxId: mailbox.id,
            scope,
            to: masked(built.to),
            listUnsubscribe,
            ...(code ? { code } : {}),
          },
          done,
        );
      });
      break;
    } catch (e) {
      if (!isBusyError(e) || attempt >= RECORD_RETRIES) {
        recordError = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 25 * (attempt + 1)));
    }
  }
  const extra = recordError ? ({ recordError: true } as const) : {};
  return status === "sent"
    ? { outcome: "sent", messageRowId: rowId, scope, listUnsubscribe, ...extra }
    : { outcome: status, messageRowId: rowId, code, scope, listUnsubscribe, ...extra };
}
