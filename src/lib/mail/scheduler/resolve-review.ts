import { and, asc, eq, inArray } from "drizzle-orm";
import { DEFAULT_FREQUENCY_LIMITS, type FrequencyLimits } from "@/lib/compliance/frequency";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { auditLog, campaignLeads, messages, type CampaignLeadStatus } from "@/lib/db/schema";
import { advanceAfterSent, reconcileStaleSendingIn, settleIfCancelled } from "../send-service";
import { wakeDispatchSafely } from "./job";

/**
 * Sonucu kesinleşmemiş (`unknown` veya uzlaştırılmamış eski `sending`) gönderim için kullanıcı kararı (FR-CMP-10).
 * Liste `review.ts`'tedir; bu modül yalnızca kararı uygular. Kararlar:
 *
 *  - `mark_sent`: kullanıcı iletiyi posta kutusunun Gönderilmiş klasöründe gördü. İleti `sent` olur (gönderim anı:
 *    kaydın açıldığı an) ve dizi kabul edilen gönderimle AYNI kurallarla ilerler (`advanceAfterSent`).
 *  - `mark_not_sent`: kullanıcı iletinin GİTMEDİĞİNİ doğruladı. Açık onay (`confirm: true`) ister: yanlış karar aynı
 *    kişiye ikinci e-posta demektir. İleti `failed` (`resolved_not_sent`) olur; bu, aynı adımın tekillik anahtarını ve
 *    alan adı/gün hakkını serbest bırakır. Dizi, adımı yeniden gönderilebilecek duruma döner (adım 0: `scheduled`,
 *    sonrası: `waiting_next`). Burada HİÇBİR ŞEY GÖNDERİLMEZ: adım yalnızca yeniden uygun hâle gelir ve dağıtıcı onu
 *    bütün kapılar (uygunluk, pencere, tavanlar, canlı gönderim kilidi) yeniden uygulanarak normal akışta ele alır.
 *  - `stop_sequence`: en güvenli seçenek. Dizi `failed` olur (bu kampanyadan bu kişiye başka ileti yok); ileti
 *    `unknown` kalır, yani adres diğer kampanyalarda da `unresolved_delivery` ile engelli kalır.
 *
 * Tek işlemde çalışır; önce eski `sending` kayıtları uzlaştırılır. Her karar `send.review_resolved` denetim kaydı yazar
 * (kişisel veri yok: alıcı adresi ve not metni yazılmaz, yalnızca notun uzunluğu). Aynı kararın tekrarı değişiklik
 * yapmadan aynı sonucu döndürür (`alreadyResolved`); başka bir karar reddedilir.
 */

export const UNCERTAIN_SEND_DECISIONS = ["mark_sent", "mark_not_sent", "stop_sequence"] as const;
export type UncertainSendDecision = (typeof UNCERTAIN_SEND_DECISIONS)[number];

export const REVIEW_RESOLVED_ACTION = "send.review_resolved";
/** `mark_not_sent` sonrası iletinin hata kodu ve dizinin son hatası. */
export const RESOLVED_NOT_SENT = "resolved_not_sent";
/** `stop_sequence` sonrası dizinin son hatası. */
export const REVIEW_STOPPED = "review_stopped";
export const REVIEW_NOTE_MAX = 500;

export type ResolveReviewErrorKind =
  | "invalid_input"
  | "unconfirmed"
  | "not_found"
  | "in_progress"
  | "not_uncertain"
  | "already_resolved"
  | "no_sequence";

export class ResolveReviewError extends Error {
  constructor(
    readonly kind: ResolveReviewErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export const RESOLVE_REVIEW_STATUS: Record<ResolveReviewErrorKind, number> = {
  invalid_input: 400,
  unconfirmed: 400,
  not_found: 404,
  in_progress: 409,
  not_uncertain: 409,
  already_resolved: 409,
  no_sequence: 409,
};

export interface ResolveReviewResult {
  messageId: number;
  decision: UncertainSendDecision;
  messageStatus: string;
  /** Test iletisinde dizi yoktur (`null`). */
  sequenceStatus: CampaignLeadStatus | null;
  /** Aynı karar daha önce uygulanmıştı; bu çağrı hiçbir şeyi değiştirmedi. */
  alreadyResolved: boolean;
}

export interface ResolveReviewOptions {
  confirm?: boolean;
  env?: Record<string, string | undefined>;
  note?: string | null;
  now?: number;
  limits?: FrequencyLimits;
}

interface ResolutionDetail {
  decision?: unknown;
}

async function priorDecision(
  tx: DbExecutor,
  messageId: number,
): Promise<UncertainSendDecision | null> {
  const [row] = await tx
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, REVIEW_RESOLVED_ACTION),
        eq(auditLog.entity, "message"),
        eq(auditLog.entityId, String(messageId)),
      ),
    )
    .orderBy(asc(auditLog.id))
    .limit(1);
  if (!row) return null;
  const d = (row.detail as ResolutionDetail | null)?.decision;
  return (UNCERTAIN_SEND_DECISIONS as readonly unknown[]).includes(d)
    ? (d as UncertainSendDecision)
    : null;
}

async function sequenceStatus(
  tx: DbExecutor,
  campaignLeadId: number | null,
): Promise<CampaignLeadStatus | null> {
  if (campaignLeadId === null) return null;
  const [cl] = await tx
    .select({ status: campaignLeads.status })
    .from(campaignLeads)
    .where(eq(campaignLeads.id, campaignLeadId));
  return cl?.status ?? null;
}

export async function resolveUncertainSend(
  db: Db,
  messageId: number,
  decision: UncertainSendDecision,
  opts: ResolveReviewOptions = {},
): Promise<ResolveReviewResult> {
  if (!(UNCERTAIN_SEND_DECISIONS as readonly string[]).includes(decision)) {
    throw new ResolveReviewError("invalid_input", "Geçersiz karar.");
  }
  const note = (opts.note ?? "").trim();
  if (note.length > REVIEW_NOTE_MAX) {
    throw new ResolveReviewError(
      "invalid_input",
      `Not en fazla ${REVIEW_NOTE_MAX} karakter olabilir.`,
    );
  }
  if (decision === "mark_not_sent" && opts.confirm !== true) {
    throw new ResolveReviewError(
      "unconfirmed",
      "Açık onay gerekli: yanlış kararda aynı kişiye ikinci e-posta gider.",
    );
  }
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? DEFAULT_FREQUENCY_LIMITS;

  const result = await db.transaction(async (tx): Promise<ResolveReviewResult> => {
    const load = async () => {
      const [m] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
      return m;
    };
    let m = await load();
    if (!m || m.direction !== "out" || (m.purpose !== "campaign" && m.purpose !== "test")) {
      throw new ResolveReviewError("not_found", "Gönderim kaydı bulunamadı.");
    }

    // Aynı kararın tekrarı (ör. yanıtı kaybolan istek) hiçbir şeyi değiştirmez.
    const prior = await priorDecision(tx, messageId);
    if (prior !== null) {
      if (prior !== decision) {
        throw new ResolveReviewError(
          "already_resolved",
          "Bu gönderim için daha önce farklı bir karar verilmiş.",
        );
      }
      return {
        messageId,
        decision,
        messageStatus: m.status,
        sequenceStatus: await sequenceStatus(tx, m.campaignLeadId),
        alreadyResolved: true,
      };
    }

    // Uzlaştırılmamış eski `sending` önce `unknown` olur; süren (eski olmayan) gönderime karar verilmez.
    if (m.status === "sending") {
      await reconcileStaleSendingIn(tx, now);
      m = (await load())!;
      if (m.status === "sending") {
        throw new ResolveReviewError(
          "in_progress",
          "Bu gönderim hâlâ sürüyor; sonucu birkaç dakika içinde kaydedilecek.",
        );
      }
    }
    if (m.status !== "unknown") {
      throw new ResolveReviewError("not_uncertain", "Bu gönderimin sonucu zaten kesin.");
    }

    const clId = m.campaignLeadId;
    if (decision === "stop_sequence" && clId === null) {
      throw new ResolveReviewError("no_sequence", "Bu gönderim bir kampanya dizisine bağlı değil.");
    }
    const own = and(eq(messages.id, messageId), eq(messages.status, "unknown"));

    if (decision === "mark_sent") {
      // Gönderim anı bilinmez; kaydın açıldığı an (sağlayıcı çağrısından hemen önce) en yakın değerdir.
      await tx
        .update(messages)
        .set({ status: "sent", sentAt: m.createdAt, errorCode: null })
        .where(own);
      if (clId !== null && m.stepIndex !== null) {
        await advanceAfterSent(
          tx,
          {
            campaignLeadId: clId,
            stepIndex: m.stepIndex,
            mailboxId: m.mailboxId,
            sentAt: m.createdAt,
          },
          now,
          limits,
        );
      }
    } else if (decision === "mark_not_sent") {
      await tx.update(messages).set({ status: "failed", errorCode: RESOLVED_NOT_SENT }).where(own);
      if (clId !== null && m.stepIndex !== null) {
        // Adım yalnızca yeniden UYGUN olur; gönderim kararını dağıtıcı bütün kapılarla yeniden verir.
        await tx
          .update(campaignLeads)
          .set({
            status: m.stepIndex === 0 ? "scheduled" : "waiting_next",
            nextSendAt: now,
            lastError: RESOLVED_NOT_SENT,
            updatedAt: now,
          })
          .where(
            and(
              eq(campaignLeads.id, clId),
              eq(campaignLeads.status, "in_flight"),
              eq(campaignLeads.nextStep, m.stepIndex),
            ),
          );
        await settleIfCancelled(tx, clId, now);
      }
    } else {
      await tx
        .update(campaignLeads)
        .set({ status: "failed", nextSendAt: null, lastError: REVIEW_STOPPED, updatedAt: now })
        .where(and(eq(campaignLeads.id, clId!), eq(campaignLeads.status, "in_flight")));
    }

    const after = await load();
    const seqStatus = await sequenceStatus(tx, clId);
    await audit(
      tx,
      REVIEW_RESOLVED_ACTION,
      "message",
      messageId,
      {
        decision,
        purpose: m.purpose,
        campaignId: m.campaignId,
        campaignLeadId: clId,
        stepIndex: m.stepIndex,
        previousErrorCode: m.errorCode,
        sequenceStatus: seqStatus,
        noteLength: note.length,
      },
      now,
    );
    return {
      messageId,
      decision,
      messageStatus: after!.status,
      sequenceStatus: seqStatus,
      alreadyResolved: false,
    };
  });
  // `mark_not_sent` adımı şimdi uygun yaptı: dağıtıcı beklemeden uyandırılır (işlem kaydedildikten SONRA; idempotent).
  // Gönderim kararını yine dağıtıcı bütün kapılarla verir.
  if (
    decision === "mark_not_sent" &&
    !result.alreadyResolved &&
    (result.sequenceStatus === "scheduled" || result.sequenceStatus === "waiting_next")
  ) {
    await wakeDispatchSafely(db, { now, env: opts.env, source: "review.mark_not_sent" });
  }
  return result;
}

/**
 * İnceleme listesinden karara bağlanmış kayıtları çıkarır. Yalnızca `stop_sequence` sonrası ileti `unknown` kaldığı
 * için gereklidir (diğer kararlar iletinin durumunu değiştirir).
 */
export async function withoutResolved<T extends { messageId: number }>(
  db: DbExecutor,
  items: T[],
): Promise<T[]> {
  if (items.length === 0) return items;
  const rows = await db
    .select({ entityId: auditLog.entityId })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, REVIEW_RESOLVED_ACTION),
        eq(auditLog.entity, "message"),
        inArray(
          auditLog.entityId,
          items.map((i) => String(i.messageId)),
        ),
      ),
    );
  const resolved = new Set(rows.map((r) => r.entityId));
  return items.filter((i) => !resolved.has(String(i.messageId)));
}
