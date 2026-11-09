import { eq } from "drizzle-orm";
import { policyScopeForMailbox } from "@/lib/compliance/policies";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes } from "@/lib/db/schema";
import { processInbound, type InboundEnvelope, type InboundEffects } from "./process";

/**
 * Gelen kutusu okuyucu sözleşmesi ve eşitleme turu (Aşama 13).
 *
 * `InboxReader` gerçek bir posta kutusunu (Gmail, IMAP) okuyacak bağdaştırıcıların arayüzüdür; bu sürümde YALNIZCA
 * bellekteki demo okuyucu vardır. Bağdaştırıcı, `attestation` alanını iletinin DIŞINDAKİ güvenilir kanaldan
 * doldurmakla yükümlüdür; iletinin kendi başlıklarını (Authentication-Results dahil) asla tasdik olarak kullanmaz.
 */

export interface InboxFetchResult {
  items: InboundEnvelope[];
  /** Bir sonraki turun başlangıç imleci; yoksa null. */
  nextCursor: string | null;
}

export interface InboxReader {
  readonly id: "demo";
  fetch(mailboxId: number, cursor: string | null, limit: number): Promise<InboxFetchResult>;
}

/** Tek turda işlenen en çok ileti ve uygulanabilecek en çok otomatik etki (sel koruması). */
export const MAX_MESSAGES_PER_SYNC = 200;
export const MAX_EFFECTS_PER_SYNC = 50;

export interface SyncSummary {
  fetched: number;
  processed: number;
  duplicates: number;
  needsReview: number;
  effects: number;
  floodGuard: boolean;
}

const hasEffect = (e: InboundEffects) =>
  e.suppressed || e.sequenceStopped || e.campaignPaused || e.bounce !== null;

export async function syncInbox(
  db: Db,
  reader: InboxReader,
  mailboxId: number,
  opts: { now?: () => number; maxMessages?: number; maxEffects?: number } = {},
): Promise<SyncSummary> {
  const clock = opts.now ?? Date.now;
  const maxMessages = Math.min(opts.maxMessages ?? MAX_MESSAGES_PER_SYNC, MAX_MESSAGES_PER_SYNC);
  const maxEffects = Math.min(opts.maxEffects ?? MAX_EFFECTS_PER_SYNC, MAX_EFFECTS_PER_SYNC);
  const summary: SyncSummary = {
    fetched: 0,
    processed: 0,
    duplicates: 0,
    needsReview: 0,
    effects: 0,
    floodGuard: false,
  };

  const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (
    !mailbox ||
    mailbox.status !== "connected" ||
    policyScopeForMailbox(mailbox.provider) !== "demo"
  ) {
    return summary;
  }

  const { items, nextCursor } = await reader.fetch(mailboxId, mailbox.syncCursor, maxMessages);
  const batch = items.slice(0, maxMessages);
  summary.fetched = batch.length;

  for (const env of batch) {
    const allowEffects = summary.effects < maxEffects;
    if (!allowEffects) summary.floodGuard = true;
    const r = await processInbound(db, { ...env, mailboxId }, { now: clock(), allowEffects });
    if (r.outcome === "duplicate") summary.duplicates++;
    else if (r.outcome === "processed") {
      summary.processed++;
      if (r.status === "received") summary.needsReview++;
      if (hasEffect(r.effects)) summary.effects++;
    }
  }

  // İmleç, ileti işleme TAMAMLANDIKTAN sonra ilerler; çökme olursa aynı iletiler ham özetle yinelenmiş sayılır.
  if (nextCursor !== mailbox.syncCursor) {
    await db
      .update(mailboxes)
      .set({ syncCursor: nextCursor, updatedAt: clock() })
      .where(eq(mailboxes.id, mailboxId));
  }
  if (summary.floodGuard) {
    await audit(
      db,
      "inbound.flood_guard",
      "mailbox",
      mailboxId,
      {
        processed: summary.processed,
        maxEffects,
      },
      clock(),
    );
  }
  return summary;
}
