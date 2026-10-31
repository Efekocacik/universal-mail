import { and, eq, inArray } from "drizzle-orm";
import type { FrequencyLimits } from "@/lib/compliance/frequency";
import { audit } from "@/lib/db/audit";
import type { Db } from "@/lib/db/client";
import { campaignLeads, campaigns, type CampaignStatus } from "@/lib/db/schema";
import { scheduleDispatch } from "@/lib/mail/scheduler/job";
import { bumpUpdatedAt, CampaignError } from "./errors";
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
  "invalid_send_window",
]);

export interface TransitionResult {
  changed: boolean;
  status: CampaignStatus;
  updatedAt: number;
  scheduled?: number;
  excluded?: number;
}

export interface TransitionOptions {
  now?: number;
  /** `start` için zorunlu: `runPreflight` sonucundaki belirteç. */
  confirmToken?: string;
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
      for (const e of plan.eligible) {
        await tx
          .update(campaignLeads)
          .set({ status: "scheduled", language: e.language, nextSendAt: null, updatedAt: now })
          .where(and(eq(campaignLeads.id, e.id), eq(campaignLeads.status, "pending")));
      }
      for (const i of plan.ineligible) {
        await tx
          .update(campaignLeads)
          .set({ status: "excluded", exclusionReasons: i.reasons, updatedAt: now })
          .where(and(eq(campaignLeads.id, i.id), eq(campaignLeads.status, "pending")));
      }
      scheduled = plan.eligible.length;
      excluded = plan.ineligible.length;
      Object.assign(values, {
        startConfirmedAt: now,
        startedAt: c.startedAt ?? now,
        pausedAt: null,
        pauseReason: null,
      });
    }

    if (action === "resume") {
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
      { from: c.status, to: target, scheduled, excluded },
      now,
    );
    return {
      changed: true,
      status: rows[0]!.status,
      updatedAt: rows[0]!.updatedAt,
      scheduled,
      excluded,
    };
  });

  // Başlatılan/devam eden kampanya için dağıtıcıyı uyandır. Başarısız olursa worker bakımı işi yeniden kurar.
  if (result.changed && (action === "start" || action === "resume")) {
    try {
      await scheduleDispatch(db, { runAt: now, now });
    } catch {
      /* worker'ın periyodik bakımı dağıtım işini planlar */
    }
  }
  return result;
}
