import { eq } from "drizzle-orm";
import { LIVE_INBOX_READING_ENABLED, policyScopeForMailbox } from "@/lib/compliance/policies";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { mailboxes } from "@/lib/db/schema";
import { processInbound, type InboundEnvelope, type InboundEffects } from "./process";
import { recordInboxSync } from "./sync-status";

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
  /** Okuyucunun ön elemesi (yalnızca sayılar): ilgisiz, çok büyük, silinmiş, ayrıştırılamayan iletiler. */
  skipped?: { unrelated: number; oversize: number; gone: number; unparseable: number };
  /** Sağlayıcı imleci geçersiz saydı (ör. Gmail historyId süresi doldu); sonraki tur baştan eşitler. */
  resynced?: boolean;
}

export interface InboxReader {
  readonly id: "demo" | "gmail";
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
  /** Okuyucunun ön elemesi (ilgisiz/çok büyük/silinmiş/ayrıştırılamayan); bunlar saklanmaz. */
  skipped: number;
  resynced: boolean;
  /** Okuyucu hata verdiyse güvenli hata kodu. İmleç İLERLETİLMEZ, hiçbir ileti kaybolmaz. */
  error: string | null;
  /** Sağlayıcı hız sınırı uyguladıysa (`rate_limited`) bildirdiği bekleme (ms); çağıran bu kutuyu o kadar ertelemelidir. */
  retryAfterMs?: number;
}

const hasEffect = (e: InboundEffects) =>
  e.suppressed || e.sequenceStopped || e.campaignPaused || e.bounce !== null;

export async function syncInbox(
  db: Db,
  reader: InboxReader,
  mailboxId: number,
  opts: {
    now?: () => number;
    maxMessages?: number;
    maxEffects?: number;
    /** Yalnızca testte: gerçek gelen kutusu okuma kilidini geçersiz kılar (üretimde yok sayılır). */
    liveInboxEnabled?: () => boolean;
  } = {},
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
    skipped: 0,
    resynced: false,
    error: null,
  };

  const [mailbox] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  if (!mailbox || mailbox.status !== "connected") return summary;
  // Okuyucu ve kutu türü eşleşmeli; gerçek (Gmail) kutu yalnızca gelen kutusu okuma kilidi açıkken eşitlenir.
  const demoBox = policyScopeForMailbox(mailbox.provider) === "demo";
  if (demoBox) {
    if (reader.id !== "demo") return summary;
  } else {
    const live = opts.liveInboxEnabled ?? (() => LIVE_INBOX_READING_ENABLED);
    if (mailbox.provider !== "gmail" || reader.id !== "gmail" || !live()) return summary;
  }

  let fetched: Awaited<ReturnType<InboxReader["fetch"]>>;
  try {
    fetched = await reader.fetch(mailboxId, mailbox.syncCursor, maxMessages);
  } catch (e) {
    // Ağ/kimlik/biçim hatası: imleç ilerlemez, hiçbir şey işlenmez; sonraki tur aynı yerden devam eder.
    summary.error =
      typeof (e as { code?: unknown })?.code === "string"
        ? (e as { code: string }).code
        : "fetch_failed";
    const retryAfter = (e as { retryAfterMs?: unknown })?.retryAfterMs;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      summary.retryAfterMs = retryAfter;
    }
    if (!demoBox) await recordInboxSync(db, mailboxId, { ok: false, code: summary.error }, clock());
    return summary;
  }
  const { items, nextCursor } = fetched;
  if (items.length > maxMessages) {
    // Sözleşme ihlali: fazlası sessizce atlanıp imleç ilerletilirse veri kaybolur. İlerletme.
    summary.error = "reader_contract_violation";
    if (!demoBox) await recordInboxSync(db, mailboxId, { ok: false, code: summary.error }, clock());
    return summary;
  }
  const batch = items;
  summary.fetched = batch.length;
  if (fetched.skipped) {
    const k = fetched.skipped;
    summary.skipped = k.unrelated + k.oversize + k.gone + k.unparseable;
  }
  summary.resynced = fetched.resynced === true;

  for (const env of batch) {
    const allowEffects = summary.effects < maxEffects;
    if (!allowEffects) summary.floodGuard = true;
    const r = await processInbound(
      db,
      { ...env, mailboxId },
      { now: clock(), allowEffects, allowGmail: !demoBox },
    );
    if (r.outcome === "rejected") {
      // İleti işlenemedi (kutu pasif, kapsam reddi...): imleci İLERLETME; aksi halde ileti sonsuza dek kaybolur.
      summary.error = `rejected_${r.code}`;
      if (!demoBox)
        await recordInboxSync(db, mailboxId, { ok: false, code: summary.error }, clock());
      return summary;
    }
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
  if (!demoBox) await recordInboxSync(db, mailboxId, { ok: true, code: "ok" }, clock());
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
