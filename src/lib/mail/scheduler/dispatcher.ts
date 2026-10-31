import { and, asc, eq, exists, gt, inArray, isNull, lte, min, not, or, sql } from "drizzle-orm";
import type { IneligibleCode, IneligibleReason } from "@/lib/compliance/eligibility";
import { DAY_MS, type FrequencyLimits } from "@/lib/compliance/frequency";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, mailboxes, type CampaignLeadStatus } from "@/lib/db/schema";
import type { MailProvider } from "../provider/provider";
import { MIN_GAP_S } from "./throttle";
import {
  isBusyError,
  retryPendingRecord,
  sendCampaignStep,
  STALE_SENDING_MS,
  type PendingRecord,
  type SendStepOutcome,
} from "../send-service";

/**
 * Kampanya gönderim dağıtıcısı (Aşama 9). Her çağrıda EN FAZLA BİR ileti gönderir; zamanlamanın doğru kaynağı
 * `campaign_leads` / `messages` tablolarıdır, iş kuyruğu yalnızca dağıtıcıyı uyandırır.
 *
 * - Yalnızca `running` durumundaki ve DEMO posta kutulu kampanyalar seçilir (gerçek gönderim kapalıdır).
 * - Her aday için bütün kurallar (uygunluk, suppression, ülke politikası, pencere, tavanlar, ısınma, bekleme)
 *   gönderimden hemen önce `sendCampaignStep` içinde, ayırma işleminde yeniden denetlenir.
 * - `unknown`/`sending`/`sent` olan adımlar seçilmez ve yeniden gönderilmez (dizi `in_flight` kalır).
 * - Uygunsuzluk sonuçları: ERTELE (geçici/belirsiz), ÇIKAR (kesin ve kalıcı veri gerçekleri), DURAKLAT (sistem veya
 *   yapılandırma). Güvenle sınıflandırılamayan her durum ertelenir; lead kalıcı olarak dışlanmaz.
 */

export type ReasonAction = "pause" | "skip" | "exclude" | "defer";

/** Kampanyanın tamamını durduran sistem/yapılandırma nedenleri (lead'lere dokunulmaz). */
const PAUSE_CODES: ReadonlySet<IneligibleCode> = new Set<IneligibleCode>([
  "consent_missing",
  "sender_profile_incomplete",
  "live_sending_disabled",
  "invalid_limits",
  "mailbox_missing",
  "mailbox_not_ready",
]);
/** Kampanya bu arada durum değiştirdi (yarış): hiçbir şey değiştirilmez. */
const SKIP_CODES: ReadonlySet<IneligibleCode> = new Set<IneligibleCode>([
  "campaign_not_found",
  "campaign_not_active",
  "campaign_closed",
]);
/** Kesin ve kalıcı nedenler: dizi sonlandırılır (lead'in diğer kampanyalardaki durumu değişmez). */
const EXCLUDE_CODES: ReadonlySet<IneligibleCode> = new Set<IneligibleCode>([
  "suppressed",
  "country_blocked",
  "country_generic_only",
  "email_invalid",
  "email_consumer",
  "email_personal",
  "email_removed",
  "no_email",
  "recipient_redacted",
  "recipient_mismatch",
  "reply_received",
  "sequence_limit",
  "lead_status_blocked",
]);
/** Belirsiz/sistem kaynaklı: kısa erteleme; asla dışlama. */
const UNCERTAIN_CODES: ReadonlySet<IneligibleCode> = new Set<IneligibleCode>(["evaluation_error"]);

const SHORT_DEFER_MS = 15 * 60_000;

export function classifyReasons(
  reasons: readonly IneligibleReason[],
  now: number,
): { action: ReasonAction; retryAt?: number } {
  const codes = reasons.map((r) => r.code);
  if (codes.some((c) => PAUSE_CODES.has(c))) return { action: "pause" };
  if (codes.some((c) => SKIP_CODES.has(c))) return { action: "skip" };
  if (codes.length === 0 || codes.some((c) => UNCERTAIN_CODES.has(c))) {
    return { action: "defer", retryAt: now + SHORT_DEFER_MS };
  }
  if (codes.some((c) => EXCLUDE_CODES.has(c))) return { action: "exclude" };
  // Geri kalan her şey (zamanla değişebilir veya güvenle sınıflandırılamaz): bildirilen en geç ana, yoksa 1 gün.
  const untils = reasons.map((r) => r.until).filter((u): u is number => typeof u === "number");
  const retryAt = untils.length > 0 ? Math.max(...untils) : now + DAY_MS;
  return { action: "defer", retryAt: Math.max(retryAt, now + 60_000) };
}

export interface DispatchOptions {
  now?: () => number;
  /** Testler için; verilmezse posta kutusuna göre (yalnızca demo). */
  provider?: MailProvider;
  timeoutMs?: number;
  limits?: FrequencyLimits;
  /** Bir çağrıda değerlendirilecek en fazla aday. */
  batchSize?: number;
  log?: (message: string) => void;
}

export interface DispatchResult {
  /** Sağlayıcıya ulaşan gönderim sonucu (yoksa `null`). */
  send: Extract<SendStepOutcome, { outcome: "sent" | "failed" | "unknown" }> | null;
  deferred: number;
  excluded: number;
  pausedCampaigns: number[];
  completedCampaigns: number[];
  busy: boolean;
  pendingRecords: number;
  /** Dağıtıcının tekrar çalışması gereken an. */
  nextWakeAt: number;
}

const MIN_WAKE_MS = 5_000;
const MAX_WAKE_MS = 5 * 60_000;
const BUSY_WAKE_MS = 10_000;
const MAX_PENDING_TRIES = 50;

/** Yalnızca güvenli, kişisel veri içermeyen kısa metin (kod listesi). */
function codesText(codes: readonly string[]): string {
  return codes.join(",").slice(0, 200);
}

export class MailDispatcher {
  /** Kabul edilmiş ama kaydı yazılamamış sonuçlar (yalnızca bellekte; ham ileti ve alıcı yok). */
  private pending: { record: PendingRecord; tries: number; since: number }[] = [];

  constructor(private readonly db: Db) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Bir dağıtım turu. Veritabanı meşgulse (başka işlem/süreç) tur güvenle yarıda bırakılır ve `busy` döner; o ana
   * kadar yapılmış bir gönderimin kaydı zaten yazılmıştır, ileti yeniden gönderilmez.
   */
  async dispatchOnce(opts: DispatchOptions = {}): Promise<DispatchResult> {
    const now = (opts.now ?? Date.now)();
    const res: DispatchResult = {
      send: null,
      deferred: 0,
      excluded: 0,
      pausedCampaigns: [],
      completedCampaigns: [],
      busy: false,
      pendingRecords: 0,
      nextWakeAt: now + MAX_WAKE_MS,
    };
    try {
      await this.run(opts, now, res);
    } catch (e) {
      if (!isBusyError(e)) throw e;
      res.busy = true;
      res.nextWakeAt = now + BUSY_WAKE_MS;
      res.pendingRecords = this.pending.length;
    }
    return res;
  }

  private async run(opts: DispatchOptions, now: number, res: DispatchResult): Promise<void> {
    const clock = opts.now ?? Date.now;
    const log = opts.log ?? (() => undefined);
    const wakeCandidates: number[] = [];

    await this.flushPending(now, opts.limits, log);

    const candidates = await this.db
      .select({
        id: campaignLeads.id,
        campaignId: campaignLeads.campaignId,
        nextStep: campaignLeads.nextStep,
        mailboxId: campaigns.mailboxId,
      })
      .from(campaignLeads)
      .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
      .innerJoin(mailboxes, eq(mailboxes.id, campaigns.mailboxId))
      .where(
        and(
          eq(campaigns.status, "running"),
          eq(mailboxes.provider, "demo"),
          inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
          or(isNull(campaignLeads.nextSendAt), lte(campaignLeads.nextSendAt, now)),
        ),
      )
      .orderBy(asc(sql`coalesce(${campaignLeads.nextSendAt}, 0)`), asc(campaignLeads.id))
      .limit(opts.batchSize ?? 50);

    const blockedMailboxes = new Set<number>();
    const blockedCampaigns = new Set<number>();

    for (const c of candidates) {
      if (c.mailboxId === null || blockedMailboxes.has(c.mailboxId)) continue;
      if (blockedCampaigns.has(c.campaignId)) continue;

      const out = await sendCampaignStep(
        this.db,
        { campaignLeadId: c.id, stepIndex: c.nextStep },
        { now: clock, provider: opts.provider, timeoutMs: opts.timeoutMs, limits: opts.limits },
      );

      if (out.outcome === "sent" || out.outcome === "failed" || out.outcome === "unknown") {
        res.send = out;
        log(`dizi #${c.id} adım ${c.nextStep}: ${out.outcome}${out.code ? ` (${out.code})` : ""}`);
        if (out.recordError && out.pendingRecord) {
          this.pending.push({ record: out.pendingRecord, tries: 0, since: clock() });
          log(
            `ileti #${out.messageRowId}: sonuç kaydı yazılamadı; yalnızca kayıt yeniden denenecek`,
          );
        }
        wakeCandidates.push(clock() + MIN_GAP_S * 1000);
        break; // çağrı başına en fazla bir gönderim
      }
      if (out.outcome === "busy") {
        res.busy = true;
        wakeCandidates.push(now + BUSY_WAKE_MS);
        break;
      }
      if (out.outcome === "already_reserved") {
        // Başka bir çağrı/süreç bu adımı ayırdı; ona bırakılır.
        wakeCandidates.push(now + MIN_WAKE_MS);
        continue;
      }
      if (out.outcome === "ineligible") {
        const verdict = classifyReasons(out.reasons, now);
        const codes = out.reasons.map((r) => r.code);
        if (verdict.action === "pause") {
          if (await this.pauseCampaign(c.campaignId, codes, now)) {
            res.pausedCampaigns.push(c.campaignId);
            log(`kampanya #${c.campaignId} duraklatıldı: ${codesText(codes)}`);
          }
          blockedCampaigns.add(c.campaignId);
        } else if (verdict.action === "exclude") {
          if (await this.excludeSequence(c.id, codes, now)) res.excluded++;
          log(`dizi #${c.id} sonlandırıldı: ${codesText(codes)}`);
        } else if (verdict.action === "defer") {
          if (await this.defer(c.id, verdict.retryAt!, codesText(codes), now)) res.deferred++;
          wakeCandidates.push(verdict.retryAt!);
        }
        continue;
      }

      if (out.outcome !== "not_sendable") continue;
      switch (out.code) {
        case "mailbox_gap":
        case "mailbox_daily_cap":
          blockedMailboxes.add(c.mailboxId);
          wakeCandidates.push(out.retryAt ?? now + MAX_WAKE_MS);
          break;
        case "campaign_daily_cap":
          blockedCampaigns.add(c.campaignId);
          wakeCandidates.push(out.retryAt ?? now + MAX_WAKE_MS);
          break;
        case "not_due":
        case "outside_window": {
          const at = out.retryAt ?? now + DAY_MS;
          if (await this.defer(c.id, at, out.code, now)) res.deferred++;
          wakeCandidates.push(at);
          break;
        }
        case "timezone_unknown":
        case "step_template_missing":
        case "compose_failed":
          // Lead'e özgü olabilir; kalıcı dışlama yok, bir gün sonra yeniden değerlendirilir.
          if (await this.defer(c.id, now + DAY_MS, out.code, now)) res.deferred++;
          break;
        case "invalid_send_window":
        case "provider_unavailable":
        case "build_failed":
          if (await this.pauseCampaign(c.campaignId, [out.code], now)) {
            res.pausedCampaigns.push(c.campaignId);
            log(`kampanya #${c.campaignId} duraklatıldı: ${out.code}`);
          }
          blockedCampaigns.add(c.campaignId);
          break;
      }
    }

    res.completedCampaigns = await this.completeFinishedCampaigns(now);

    // Planlanmış en yakın dizi.
    const [next] = await this.db
      .select({ at: min(campaignLeads.nextSendAt) })
      .from(campaignLeads)
      .innerJoin(campaigns, eq(campaigns.id, campaignLeads.campaignId))
      .where(
        and(
          eq(campaigns.status, "running"),
          inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
          gt(campaignLeads.nextSendAt, now),
        ),
      );
    if (next?.at != null) wakeCandidates.push(next.at);
    if (this.pending.length > 0) wakeCandidates.push(now + MIN_WAKE_MS);

    const wake = wakeCandidates.length > 0 ? Math.min(...wakeCandidates) : now + MAX_WAKE_MS;
    res.nextWakeAt = Math.min(Math.max(wake, now + MIN_WAKE_MS), now + MAX_WAKE_MS);
    res.pendingRecords = this.pending.length;
  }

  /** Bekleyen kayıtları yalnızca veritabanına yeniden yazmayı dener. İleti asla yeniden gönderilmez. */
  private async flushPending(
    now: number,
    limits: FrequencyLimits | undefined,
    log: (m: string) => void,
  ): Promise<void> {
    const keep: typeof this.pending = [];
    for (const p of this.pending) {
      const r = await retryPendingRecord(this.db, p.record, { now, limits });
      if (r === "recorded") {
        log(`ileti #${p.record.rowId}: sonuç kaydı yazıldı`);
        continue;
      }
      p.tries++;
      // Uzlaştırma eşiği geçtiyse kayıt artık `unknown` inceleme akışındadır; bellekteki sonuç bırakılır.
      if (p.tries >= MAX_PENDING_TRIES || now - p.since > STALE_SENDING_MS) {
        log(`ileti #${p.record.rowId}: sonuç kaydedilemedi; inceleme gerekecek`);
        continue;
      }
      keep.push(p);
    }
    this.pending = keep;
  }

  private async defer(id: number, at: number, reason: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(campaignLeads)
      .set({ nextSendAt: at, lastError: reason, updatedAt: now })
      .where(
        and(eq(campaignLeads.id, id), inArray(campaignLeads.status, ["scheduled", "waiting_next"])),
      )
      .returning({ id: campaignLeads.id });
    return rows.length > 0;
  }

  private async excludeSequence(id: number, codes: string[], now: number): Promise<boolean> {
    const rows = await this.db
      .update(campaignLeads)
      .set({
        status: codes.includes("reply_received") ? "replied" : "removed",
        exclusionReasons: codes,
        nextSendAt: null,
        lastError: codesText(codes),
        updatedAt: now,
      })
      .where(
        and(eq(campaignLeads.id, id), inArray(campaignLeads.status, ["scheduled", "waiting_next"])),
      )
      .returning({ id: campaignLeads.id });
    return rows.length > 0;
  }

  private async pauseCampaign(id: number, codes: string[], now: number): Promise<boolean> {
    const rows = await this.db
      .update(campaigns)
      .set({
        status: "paused",
        pausedAt: now,
        pauseReason: `auto:${codesText(codes)}`,
        updatedAt: now,
      })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, "running")))
      .returning({ id: campaigns.id });
    return rows.length > 0;
  }

  /** Gönderilecek, gönderimde veya incelemede dizisi kalmayan çalışan kampanyalar tamamlanır. */
  private async completeFinishedCampaigns(now: number): Promise<number[]> {
    const sequences = (statuses?: readonly CampaignLeadStatus[]) =>
      this.db
        .select({ one: sql`1` })
        .from(campaignLeads)
        .where(
          and(
            eq(campaignLeads.campaignId, campaigns.id),
            statuses ? inArray(campaignLeads.status, [...statuses]) : undefined,
          ),
        );
    const rows = await this.db
      .update(campaigns)
      .set({ status: "completed", finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(campaigns.status, "running"),
          exists(sequences()),
          not(exists(sequences(["pending", "scheduled", "waiting_next", "in_flight"]))),
        ),
      )
      .returning({ id: campaigns.id });
    return rows.map((r) => r.id);
  }
}
