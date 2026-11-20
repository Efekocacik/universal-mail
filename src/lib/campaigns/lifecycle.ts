import { and, count, eq, inArray, like } from "drizzle-orm";
import type { FrequencyLimits } from "@/lib/compliance/frequency";
import {
  loadRecipientRestriction,
  RESTRICTION_PAUSE_REASON,
  RESTRICTION_RECHECK_MS,
} from "@/lib/compliance/recipient-restriction";
import { audit } from "@/lib/db/audit";
import { chunk } from "@/lib/util";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, type CampaignStatus } from "@/lib/db/schema";
import { wakeDispatchSafely, type WakeOutcome } from "@/lib/mail/scheduler/job";
import { bumpUpdatedAt, CampaignError } from "./errors";
import { COUNTRY_REVOKED_PAUSE_REASON } from "@/lib/compliance/live-country-constants";
import { campaignBlockers, computeStartPlan, type BlockerCode } from "./preflight";

/**
 * Kampanya durum geçişleri (FR-CMP-04, FR-CMP-05).
 *
 *   draft ──ready──▶ ready ──start──▶ running ⇄ paused
 *     ▲               │                 │         │
 *     └────draft──────┘                 └─cancel──┴──▶ cancelled   (draft/ready da iptal edilebilir)
 *   running ──(dağıtıcı: bütün diziler bitti)──▶ completed;  `stopped` sistem için ayrılmıştır.
 *
 * Her geçiş TEK işlemde yapılır: durum karşılaştırmalı güncellenir, `updated_at` kesin artar, diziler güncellenir ve
 * audit kaydı yazılır. Hedef duruma zaten ulaşılmışsa `{ changed: false }` döner (idempotent).
 *
 * ÖNEMLİ — ayrılmış gönderim: Dağıtıcı bir adımı ayırma işleminde `sending` olarak kaydettikten SONRA sağlayıcı çağrısı
 * işlem dışında sürer. Bu çağrı duraklatma veya iptalden etkilenmez: geçiş kaydedilmeden önce ayrılmış EN FAZLA BİR
 * ileti (posta kutusu başına bir dağıtıcı turu) yine de tamamlanabilir ve sonucu normal kaydedilir. Geçiş
 * kaydedildikten sonra yeni ayırma YAPILAMAZ, çünkü uygunluk denetimi kampanya durumunu ayırma işleminin içinde okur.
 * İptal edilmiş kampanyada tamamlanan dizinin durumu sonuç kaydında `cancelled` yapılır.
 */

export type CampaignAction = "ready" | "draft" | "start" | "pause" | "resume" | "cancel";

const TARGET: Record<CampaignAction, CampaignStatus> = {
  ready: "ready",
  draft: "draft",
  start: "running",
  pause: "paused",
  resume: "running",
  cancel: "cancelled",
};

const FROM: Record<CampaignAction, readonly CampaignStatus[]> = {
  ready: ["draft"],
  draft: ["ready"],
  start: ["ready"],
  pause: ["running"],
  resume: ["paused"],
  cancel: ["draft", "ready", "running", "paused"],
};

/** `ready` için gereken yapılandırma (dizi değerlendirmesi ve zamanlayıcı bayrağı hariç). */
const CONFIG_BLOCKERS: ReadonlySet<BlockerCode> = new Set<BlockerCode>([
  "mailbox_missing",
  "live_disabled",
  "mailbox_not_ready",
  "steps_missing",
  "steps_invalid",
  "invalid_send_window",
]);

export interface TransitionResult {
  changed: boolean;
  status: CampaignStatus;
  updatedAt: number;
  scheduled?: number;
  excluded?: number;
  /** Test alıcı sınırı nedeniyle bekletilen (dışlanmayan) dizi sayısı (başlatma). */
  held?: number;
  /** Başlatma/devamdan sonra dağıtıcı uyandırma sonucu (gözlemlenebilirlik; gönderim kararı değildir). */
  wake?: WakeOutcome | "failed";
}

export interface TransitionOptions {
  now?: number;
  /** `start` için zorunlu: `runPreflight` sonucundaki belirteç. */
  confirmToken?: string;
  /**
   * `resume` için: test alıcı sınırı değiştiği için duraklatılmış (`pause_reason = restriction`) kampanyayı sürdürmeye
   * AÇIK onay. Yoksa devam reddedilir (ertelenen alıcılar kendiliğinden gönderime başlamaz).
   */
  restrictionAck?: boolean;
  env?: Record<string, string | undefined>;
  limits?: FrequencyLimits;
}

export async function transitionCampaign(
  db: Db,
  id: number,
  action: CampaignAction,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;

  const result = await db.transaction(async (tx): Promise<TransitionResult> => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    const target = TARGET[action];
    if (c.status === target) return { changed: false, status: c.status, updatedAt: c.updatedAt };
    if (!FROM[action].includes(c.status)) {
      throw new CampaignError("invalid_transition", "Bu durumda bu işlem yapılamaz.", {
        status: c.status,
        action,
      });
    }

    const values: Partial<typeof campaigns.$inferInsert> = { status: target };
    let scheduled: number | undefined;
    let excluded: number | undefined;
    let held: number | undefined;

    if (action === "ready") {
      const blockers = (await campaignBlockers(tx, c, env)).filter((b) => CONFIG_BLOCKERS.has(b));
      if (blockers.length > 0) {
        throw new CampaignError("preflight_failed", "Kampanya hazır değil.", { blockers });
      }
    }

    if (action === "start") {
      const plan = await computeStartPlan(tx, id, { now, env, limits: opts.limits });
      if (plan.blockers.length > 0) {
        throw new CampaignError(
          plan.blockers.includes("scheduler_disabled") ? "scheduler_disabled" : "preflight_failed",
          plan.blockers.includes("scheduler_disabled")
            ? "Demo gönderim zamanlayıcısı kapalı; kampanya başlatılamaz."
            : "Başlatma öncesi denetimler geçmedi.",
          { blockers: plan.blockers },
        );
      }
      if (!opts.confirmToken || opts.confirmToken !== plan.token) {
        throw new CampaignError(
          "preflight_stale",
          "Başlatma özeti güncel değil; özeti yeniden alıp onaylayın.",
        );
      }
      // Toplu yazım: uygunlar dil başına, uygun olmayanlar aynı gerekçe kümesi başına tek UPDATE (500'lük parçalar).
      const byLanguage = new Map<string, number[]>();
      for (const e of plan.eligible)
        byLanguage.set(e.language, [...(byLanguage.get(e.language) ?? []), e.id]);
      for (const [language, ids] of byLanguage)
        for (const part of chunk(ids, 500))
          await tx
            .update(campaignLeads)
            .set({ status: "scheduled", language, nextSendAt: null, updatedAt: now })
            .where(and(inArray(campaignLeads.id, part), eq(campaignLeads.status, "pending")));
      // Test alıcı sınırı nedeniyle bekletilenler DIŞLANMAZ: `scheduled` olur ve dağıtıcı sınır sürdükçe ertelemeye devam eder.
      const heldByLanguage = new Map<string, number[]>();
      for (const h of plan.held)
        heldByLanguage.set(h.language, [...(heldByLanguage.get(h.language) ?? []), h.id]);
      for (const [language, ids] of heldByLanguage)
        for (const part of chunk(ids, 500))
          await tx
            .update(campaignLeads)
            .set({
              status: "scheduled",
              language,
              nextSendAt: now + RESTRICTION_RECHECK_MS,
              lastError: "recipient_not_allowed",
              updatedAt: now,
            })
            .where(and(inArray(campaignLeads.id, part), eq(campaignLeads.status, "pending")));
      const byReasons = new Map<string, { reasons: string[]; ids: number[] }>();
      for (const i of plan.ineligible) {
        const key = JSON.stringify(i.reasons);
        const g = byReasons.get(key) ?? { reasons: i.reasons, ids: [] };
        g.ids.push(i.id);
        byReasons.set(key, g);
      }
      for (const g of byReasons.values())
        for (const part of chunk(g.ids, 500))
          await tx
            .update(campaignLeads)
            .set({
              status: "excluded",
              exclusionReasons: g.reasons,
              updatedAt: now,
            })
            .where(and(inArray(campaignLeads.id, part), eq(campaignLeads.status, "pending")));
      scheduled = plan.eligible.length;
      excluded = plan.ineligible.length;
      held = plan.held.length;
      Object.assign(values, {
        startConfirmedAt: now,
        startedAt: c.startedAt ?? now,
        pausedAt: null,
        pauseReason: null,
      });
    }

    if (action === "resume") {
      // Test alıcı sınırı: ertelenmiş (bekletilen) alıcılar kendiliğinden gönderime BAŞLAMAMALI. Kampanya sınır değişikliği
      // nedeniyle duraklatılmışsa (`restriction`) VEYA sınır nedeniyle bekletilen alıcısı varsa (ör. kullanıcı kendisi
      // duraklatmışken sınır kalktı/genişledi), devam yalnızca açık yeniden başlatma onayıyla yapılır; arayüz bekleyen alıcı
      // sayısını gösterip onay alır.
      if (opts.restrictionAck !== true) {
        const [heldNow] = await tx
          .select({ n: count() })
          .from(campaignLeads)
          .where(
            and(
              eq(campaignLeads.campaignId, id),
              inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
              like(campaignLeads.lastError, "%recipient_not_allowed%"),
            ),
          );
        const held = Number(heldNow?.n ?? 0);
        // Ülke geri alındığı için duraklatılan kampanya da yalnızca açık onayla sürdürülür: o ülkenin alıcıları sürdürmede
        // `country_blocked` ile kalıcı olarak dışlanır (ülke yeniden açılmadıkça).
        const countryRevoked = c.pauseReason === COUNTRY_REVOKED_PAUSE_REASON;
        if (c.pauseReason === RESTRICTION_PAUSE_REASON || countryRevoked || held > 0) {
          const restriction = await loadRecipientRestriction(tx);
          const [waiting] = await tx
            .select({ n: count() })
            .from(campaignLeads)
            .where(
              and(
                eq(campaignLeads.campaignId, id),
                inArray(campaignLeads.status, ["scheduled", "waiting_next"]),
              ),
            );
          throw new CampaignError(
            "restriction_ack_required",
            "Test alıcı sınırı nedeniyle bekleyen alıcılar var; kampanyayı sürdürmek için açık onay gerekir.",
            {
              waiting: Number(waiting?.n ?? 0),
              held,
              restrictionEnabled: restriction.enabled,
              allowedAddresses: restriction.addresses.size,
              countryRevoked,
            },
          );
        }
      }
      const blockers = await campaignBlockers(tx, c, env);
      if (blockers.length > 0) {
        throw new CampaignError(
          blockers.includes("scheduler_disabled") ? "scheduler_disabled" : "preflight_failed",
          "Kampanya devam ettirilemez; engeller giderilmeli.",
          { blockers, pauseReason: c.pauseReason },
        );
      }
      Object.assign(values, { pausedAt: null, pauseReason: null });
    }

    if (action === "pause") Object.assign(values, { pausedAt: now, pauseReason: "user" });

    if (action === "cancel") {
      Object.assign(values, { finishedAt: now });
      // Henüz gönderimde olmayan diziler iptal edilir; `in_flight` (sürmekte veya inceleme bekleyen) dokunulmaz.
      await tx
        .update(campaignLeads)
        .set({ status: "cancelled", nextSendAt: null, updatedAt: now })
        .where(
          and(
            eq(campaignLeads.campaignId, id),
            inArray(campaignLeads.status, ["pending", "scheduled", "waiting_next"]),
          ),
        );
    }

    const rows = await tx
      .update(campaigns)
      .set({ ...values, updatedAt: bumpUpdatedAt(now) })
      .where(and(eq(campaigns.id, id), eq(campaigns.status, c.status)))
      .returning({ status: campaigns.status, updatedAt: campaigns.updatedAt });
    if (rows.length !== 1) {
      throw new CampaignError(
        "conflict",
        "Kampanya başka bir işlemle değiştirildi; yeniden yükleyin.",
      );
    }
    await audit(
      tx,
      `campaign.${action}`,
      "campaign",
      id,
      { from: c.status, to: target, scheduled, excluded, ...(held ? { held } : {}) },
      now,
    );
    return {
      changed: true,
      status: rows[0]!.status,
      updatedAt: rows[0]!.updatedAt,
      scheduled,
      excluded,
      held,
    };
  });

  // Başlatılan/devam eden kampanya için dağıtıcıyı HEMEN uyandır (kuyruktaki iş öne çekilir; ikinci iş eklenmez).
  // Başarısız olursa worker bakımı işi yeniden kurar. Aralık ve tavanlar gönderim anında yine uygulanır.
  if (result.changed && (action === "start" || action === "resume")) {
    result.wake = await wakeDispatchSafely(db, { now, env, source: `campaign.${action}` });
  }
  return result;
}
