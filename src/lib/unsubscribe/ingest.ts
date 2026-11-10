import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { suppressEmailInTx } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, messages } from "@/lib/db/schema";
import { LINKABLE_FROM } from "@/lib/mail/inbound/process";
import { loadPublicKeys, recipientTag, tagsEqual } from "./keys";
import { CLOCK_SKEW_MS, MAX_TOKEN_LENGTH, MAX_TTL_MS, verifyToken } from "./token";

/**
 * Abonelikten çıkış olaylarını uygulamaya işleme (Aşama 15.6) — uygulama tarafı, aktarıcıya GÜVENMEZ.
 *
 * Aktarıcı (relay) yalnızca imzayı denetleyip olayı kuyruğa koyar. Uygulama olayı yeniden doğrular:
 *  1. Olay biçimi (katı şema) ve olay zamanı (ileri sapma ve aşırı eski değil).
 *  2. Belirteç: Ed25519 imzası uygulamanın genel anahtarlarıyla, süre TIKLAMA ANINA göre (aktarıcının aldığı an).
 *  3. Kapsam ve bağ: kampanya alıcısı var, (varsa) ileti o alıcının giden kampanya iletisi, ve alıcı etiketi
 *     (gizli anahtarlı HMAC) kaydın GÜNCEL alıcısıyla eşleşiyor — yanlış alıcı/yeniden kullanılmış kimlik reddedilir.
 *  4. Tekrar oynatma: `jti` başına tek satır (`messages` gelen ileti kaydı, benzersiz dizin) → tam bir kez işlenir;
 *     tekrar gelen olay "duplicate" döner, ikinci suppression/denetim kaydı OLUŞMAZ.
 *  5. Etki: mevcut suppression sistemiyle (`unsubscribe`, kaynak `link`; mevcut kaydı yalnızca güçlendirir), aynı
 *     alıcının bekleyen dizileri durur, denetim kaydı yazılır (adres ve belirteç yazılmaz).
 *
 * DÜRÜSTLÜK / GÜVENLİK NOTU: Çıkış, kısıtlayıcı (güvenli) yöndedir. Ele geçirilmiş bir aktarıcı geçerli imzalı olayları
 * geriye tarihleyebilir veya yeniden iletebilir; bu, yalnızca o belirteçlerin zaten çıkarmak istediği alıcıyı çıkarır.
 * Aktarıcının olayları geciktirmesi/atması (erişilebilirlik) bu katmanla ÇÖZÜLMEZ (bkz. docs/09).
 */

export const MAX_EVENT_AGE_MS = MAX_TTL_MS + 86_400_000;

const eventSchema = z
  .object({
    v: z.literal(1),
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    receivedAt: z.number().int().positive(),
    via: z.literal("one_click"),
  })
  .strict();

export type RejectReason =
  | "invalid_event"
  | "event_time_invalid"
  | "invalid_token"
  | "unknown_key"
  | "expired"
  | "not_yet_valid"
  | "lead_not_found"
  | "no_mailbox"
  | "message_mismatch"
  | "recipient_mismatch";

export type IngestOutcome =
  | { outcome: "unsubscribed"; stopped: number; suppression: "added" | "strengthened" | "existing" }
  /** Alıcı silinmiş (adres yok) veya zaten engelli ve durdurulacak dizi yok. */
  | { outcome: "already" }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: RejectReason };

const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(
    String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? ""),
  );

export async function ingestUnsubscribeEvent(
  db: Db,
  rawEvent: unknown,
  opts: { now?: number } = {},
): Promise<IngestOutcome> {
  const now = opts.now ?? Date.now();
  const parsedEvent = eventSchema.safeParse(rawEvent);
  if (!parsedEvent.success) return { outcome: "rejected", reason: "invalid_event" };
  const event = parsedEvent.data;
  const at = event.receivedAt;
  if (at > now + CLOCK_SKEW_MS || at < now - MAX_EVENT_AGE_MS) {
    return { outcome: "rejected", reason: "event_time_invalid" };
  }

  const keys = await loadPublicKeys(db);
  const verdict = verifyToken(event.token, keys, at);
  if (!verdict.ok) {
    const reason: RejectReason =
      verdict.reason === "expired"
        ? "expired"
        : verdict.reason === "not_yet_valid"
          ? "not_yet_valid"
          : verdict.reason === "unknown_key"
            ? "unknown_key"
            : "invalid_token";
    return { outcome: "rejected", reason };
  }
  const claims = verdict.claims;

  try {
    return await db.transaction(async (tx): Promise<IngestOutcome> => {
      const [row] = await tx
        .select({ cl: campaignLeads, mailboxId: campaigns.mailboxId })
        .from(campaignLeads)
        .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
        .where(eq(campaignLeads.id, claims.c))
        .limit(1);
      if (!row) return { outcome: "rejected", reason: "lead_not_found" };
      const { cl } = row;

      let mailboxId = row.mailboxId;
      if (claims.m !== null) {
        const [m] = await tx
          .select({
            direction: messages.direction,
            purpose: messages.purpose,
            campaignLeadId: messages.campaignLeadId,
            mailboxId: messages.mailboxId,
          })
          .from(messages)
          .where(eq(messages.id, claims.m))
          .limit(1);
        if (!m || m.direction !== "out" || m.purpose !== "campaign" || m.campaignLeadId !== cl.id) {
          await audit(
            tx,
            "unsubscribe.rejected",
            "campaign_lead",
            cl.id,
            { reason: "message_mismatch", kid: claims.k },
            now,
          );
          return { outcome: "rejected", reason: "message_mismatch" };
        }
        mailboxId = m.mailboxId ?? mailboxId;
      }

      // Alıcı silinmişse (adres ve özet boşaltılmış) yapılacak bir şey yok; engel silme kaydında zaten var.
      if (!cl.recipientEmail || !cl.recipientHash) return { outcome: "already" };

      // Alıcı bağı: etiket kaydın GÜNCEL alıcısına ait olmalı.
      if (!tagsEqual(claims.r, recipientTag(cl.recipientHash))) {
        await audit(
          tx,
          "unsubscribe.rejected",
          "campaign_lead",
          cl.id,
          { reason: "recipient_mismatch", kid: claims.k },
          now,
        );
        return { outcome: "rejected", reason: "recipient_mismatch" };
      }

      // Gelen ileti kaydı bir posta kutusuna bağlanır; kutusuz kampanya hiç gönderim yapmamıştır.
      if (mailboxId === null) return { outcome: "rejected", reason: "no_mailbox" };

      // Tekrar oynatma / tekilleştirme: jti başına tek gelen ileti kaydı (benzersiz dizin). Önce yazılır;
      // çakışırsa işlem geri alınır ve hiçbir etki uygulanmaz.
      const [inbound] = await tx
        .insert(messages)
        .values({
          direction: "in",
          purpose: "inbound",
          campaignId: cl.campaignId,
          campaignLeadId: cl.id,
          leadId: cl.leadId,
          mailboxId,
          rfcMessageId: `<unsub-${claims.j}@unsubscribe.invalid>`,
          peerHash: cl.recipientHash,
          peerDomain: cl.recipientDomain ?? "unknown.invalid",
          bodySha256: crypto.createHash("sha256").update(claims.j).digest("hex"),
          status: "matched",
          classification: "unsubscribe",
          createdAt: now,
          receivedAt: at,
        })
        .returning({ id: messages.id });
      const inboundId = inbound!.id;

      const res = await suppressEmailInTx(
        tx,
        { email: cl.recipientEmail, reason: "unsubscribe", source: "link", messageId: inboundId },
        now,
      );
      const stopped = await tx
        .update(campaignLeads)
        .set({ status: "unsubscribed", nextSendAt: null, updatedAt: now })
        .where(
          and(
            eq(campaignLeads.recipientHash, cl.recipientHash),
            inArray(campaignLeads.status, [...LINKABLE_FROM]),
          ),
        )
        .returning({ id: campaignLeads.id });
      await audit(
        tx,
        "unsubscribe.one_click",
        "message",
        inboundId,
        { suppression: res.outcome, stopped: stopped.length, via: event.via, kid: claims.k },
        now,
      );
      if (res.outcome === "existing" && stopped.length === 0) return { outcome: "already" };
      return { outcome: "unsubscribed", stopped: stopped.length, suppression: res.outcome };
    });
  } catch (e) {
    if (isUnique(e)) return { outcome: "duplicate" };
    throw e;
  }
}

/* ---------------------------------------------------------------------------------------------- */

export interface UnsubscribeEventSource {
  pull(limit: number): Promise<{ id: string; event: unknown }[]>;
  ack(ids: string[]): Promise<void>;
}

export interface DrainSummary {
  pulled: number;
  unsubscribed: number;
  already: number;
  duplicates: number;
  rejected: number;
  /** Altyapı hatası (ör. veritabanı) olduysa güvenli kod; işlenmeyen olaylar onaylanmadan kalır ve tekrar çekilir. */
  error: string | null;
}

/**
 * Kuyruktaki olayları işler. Bir olay ancak İŞLENDİKTEN (kabul, tekrar veya KALICI ret) sonra onaylanır; altyapı hatası
 * olursa o ve sonrakiler onaylanmaz, bir sonraki turda yeniden çekilir (tekilleştirme sayesinde çift etki yok).
 */
export async function drainUnsubscribeEvents(
  db: Db,
  source: UnsubscribeEventSource,
  opts: { now?: () => number; batch?: number; maxBatches?: number } = {},
): Promise<DrainSummary> {
  const clock = opts.now ?? Date.now;
  const batch = Math.min(Math.max(opts.batch ?? 100, 1), 500);
  const s: DrainSummary = {
    pulled: 0,
    unsubscribed: 0,
    already: 0,
    duplicates: 0,
    rejected: 0,
    error: null,
  };
  for (let n = 0; n < (opts.maxBatches ?? 20); n++) {
    const items = await source.pull(batch);
    if (items.length === 0) break;
    s.pulled += items.length;
    const done: string[] = [];
    let failed = false;
    for (const it of items) {
      try {
        const r = await ingestUnsubscribeEvent(db, it.event, { now: clock() });
        if (r.outcome === "unsubscribed") s.unsubscribed++;
        else if (r.outcome === "already") s.already++;
        else if (r.outcome === "duplicate") s.duplicates++;
        else s.rejected++;
        done.push(it.id);
      } catch {
        s.error = "ingest_failed";
        failed = true;
        break;
      }
    }
    if (done.length > 0) await source.ack(done);
    if (failed) break;
  }
  return s;
}
