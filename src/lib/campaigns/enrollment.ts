import { and, asc, count, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  prepareEnrollmentBatch,
  type EnrollmentBatch,
  type IneligibleCode,
} from "@/lib/compliance/eligibility";
import type { FrequencyLimits } from "@/lib/compliance/frequency";
import { hashEmail, maskEmail } from "@/lib/compliance/suppression";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import {
  campaignLeads,
  campaigns,
  type CampaignLeadStatus,
  type SequenceStopReason,
} from "@/lib/db/schema";
import { effectiveStopReason } from "@/lib/mail/inbound/complaint";
import { suggestLanguage } from "@/lib/mail/language";
import { chunk } from "@/lib/util";
import { bumpUpdatedAt, CampaignError } from "./errors";

/**
 * Kampanyaya lead ekleme ve çıkarma (FR-CMP-02, FR-CMP-05).
 *
 * - Ekleme yalnızca `draft`/`ready` kampanyada yapılır. Her lead `evaluateEnrollment` kurallarıyla (toplu ön yüklemeyle) denetlenir: uygun olanlar
 *   alıcının o anki görüntüsüyle `pending`, olmayanlar gerekçe kodlarıyla `excluded` eklenir.
 * - Aynı lead aynı kampanyaya ikinci kez eklenemez (çıkarılmış olsa bile): benzersiz dizin + `already_in_campaign`.
 *   İstisna: `excluded` satır yeni satır açılmadan YENİDEN DEĞERLENDİRİLİR (gerekçelerin çoğu geçicidir: posta kutusu,
 *   gönderen profili, doğrulama, dinlenme süresi, canlı gönderim kapısı…). Uygunsa `pending` olur, değilse gerekçeleri
 *   yenilenir. `removed` kesindir; yeniden değerlendirilmez.
 * - Filtreyle seçim eklendiği andaki görüntüdür; sonradan oluşan lead'ler kampanyaya kendiliğinden girmez.
 * - Çıkarma, henüz gönderimde olmayan diziler içindir (`in_flight` çıkarılamaz); dağıtıcının ayırmasıyla aynı
 *   karşılaştırmalı güncelleme kullanıldığı için çıkarılan dizi gönderilmez.
 */

export const MAX_ADD_BATCH = 500;
const ADDABLE: readonly string[] = ["draft", "ready"];
const REMOVABLE: readonly CampaignLeadStatus[] = [
  "pending",
  "excluded",
  "scheduled",
  "waiting_next",
];

export interface AddLeadsResult {
  /** `pending` olan diziler (yeni eklenen + yeniden değerlendirmede uygun çıkan). */
  added: number;
  excluded: { leadId: number; reasons: IneligibleCode[] }[];
  /** Kampanyada zaten `excluded` dışındaki bir durumda bulunan lead'ler. */
  duplicates: number[];
  /** Daha önce `excluded` olup bu istekte yeniden değerlendirilen diziler (sonuçları `added`/`excluded` içindedir). */
  reevaluated: number;
  updatedAt: number;
}

/** Süzgeçle (sayfa sayfa) ekleme yanıtı: `remaining` ekleme sonrası kampanyaya hiç eklenmemiş, süzgece uyan lead sayısı. */
export interface AddLeadsByFilterResult extends AddLeadsResult {
  matched: number;
  taken: number;
  remaining: number;
}

type CampaignLeadRow = typeof campaignLeads.$inferSelect;

/** Yeniden denetimde hâlâ uygun olmayan diziler: aynı gerekçe kümesi tek UPDATE ile yazılır (bkz. `flushExcluded`). */
type ExcludedUpdates = Map<string, { reasons: IneligibleCode[]; ids: number[] }>;

/**
 * Bir `excluded` diziyi aynı işlem içinde yeniden değerlendirir (toplu ön yüklemeyle; bkz. `prepareEnrollmentBatch`).
 * Kendi satırı "zaten kampanyada" sayılmaz; diğer bütün denetimler (alan adı, başka kampanyada süren dizi, sıklık,
 * politika, kapılar) aynen uygulanır. Uygunsa alıcının O ANKİ görüntüsüyle `pending` olur (satır başına güncelleme;
 * alıcı sütunları satıra özgüdür) ve bellek içi kampanya görüntüsüne yansıtılır; değilse gerekçeleri `pendingExcluded`
 * kümesine eklenir ve döngü sonunda gruplanarak yazılır. Karşılaştırmalı güncelleme: satır bu arada başka bir duruma
 * geçtiyse dokunulmaz (`null`).
 */
async function reevaluateRow(
  tx: DbExecutor,
  row: CampaignLeadRow,
  batch: EnrollmentBatch,
  pendingExcluded: ExcludedUpdates,
  now: number,
): Promise<{ eligible: true } | { eligible: false; reasons: IneligibleCode[] } | null> {
  const verdict = batch.evaluate({ leadId: row.leadId, ignoreCampaignLeadId: row.id });
  const lead = batch.leadOf(row.leadId);
  const primary = verdict.eligible ? batch.primaryOf(row.leadId) : undefined;
  if (verdict.eligible && primary && lead) {
    const hash = hashEmail(primary.email);
    const updated = await tx
      .update(campaignLeads)
      .set({
        status: "pending",
        emailId: primary.id,
        recipientEmail: primary.email,
        recipientHash: hash,
        recipientDomain: primary.domain,
        countryCode: lead.countryCode,
        language: suggestLanguage(lead.countryCode),
        exclusionReasons: [],
        nextStep: 0,
        nextSendAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(excludedGuard(row.id))
      .returning({ id: campaignLeads.id });
    if (updated.length === 0) return null;
    // Sonraki satırların değerlendirmesi bu değişikliği görür (ör. aynı alan adı).
    const mem = batch.inCampaign.find((r) => r.id === row.id);
    if (mem) Object.assign(mem, { status: "pending", hash, domain: primary.domain });
    return { eligible: true };
  }
  const reasons = verdict.eligible
    ? (["no_email"] as IneligibleCode[])
    : [...new Set(verdict.reasons.map((r) => r.code))];
  const key = JSON.stringify(reasons);
  const g = pendingExcluded.get(key) ?? { reasons, ids: [] };
  g.ids.push(row.id);
  pendingExcluded.set(key, g);
  return { eligible: false, reasons };
}

function excludedGuard(id: number | number[]) {
  return and(
    Array.isArray(id) ? inArray(campaignLeads.id, id) : eq(campaignLeads.id, id),
    eq(campaignLeads.status, "excluded"),
    isNull(campaignLeads.redactedAt),
  );
}

/** Hâlâ uygun olmayan dizilerin gerekçeleri: gerekçe kümesi başına (500'lük parçalarla) tek UPDATE. */
async function flushExcluded(
  tx: DbExecutor,
  pendingExcluded: ExcludedUpdates,
  now: number,
): Promise<Set<number>> {
  const written = new Set<number>();
  for (const g of pendingExcluded.values())
    for (const part of chunk(g.ids, 500)) {
      const rows = await tx
        .update(campaignLeads)
        .set({ exclusionReasons: g.reasons, updatedAt: now })
        .where(excludedGuard(part))
        .returning({ id: campaignLeads.id });
      for (const r of rows) written.add(r.id);
    }
  return written;
}

/** Çok satırlı ekleme parçası (SQLite değişken sınırının çok altında). */
const INSERT_CHUNK = 50;

export async function addLeadsToCampaign(
  db: Db,
  campaignId: number,
  leadIds: readonly number[],
  opts: { now?: number; limits?: FrequencyLimits; selection?: unknown } = {},
): Promise<AddLeadsResult> {
  const now = opts.now ?? Date.now();
  const ids = [...new Set(leadIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0)
    throw new CampaignError(
      "invalid_input",
      "Eklenecek işletme seçilmedi. Keşif ekranında süzgeçleri uygulayıp yeniden deneyin.",
    );
  if (ids.length > MAX_ADD_BATCH) {
    throw new CampaignError(
      "invalid_input",
      `Tek seferde en fazla ${MAX_ADD_BATCH} lead eklenebilir.`,
    );
  }

  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    if (!ADDABLE.includes(c.status)) {
      throw new CampaignError(
        "not_editable",
        "İşletme yalnızca taslak veya hazır kampanyaya eklenebilir.",
        {
          status: c.status,
        },
      );
    }
    const existing = new Map(
      (
        await tx
          .select()
          .from(campaignLeads)
          .where(and(eq(campaignLeads.campaignId, campaignId), inArray(campaignLeads.leadId, ids)))
      ).map((r) => [r.leadId, r]),
    );

    const res: AddLeadsResult = {
      added: 0,
      excluded: [],
      duplicates: [],
      reevaluated: 0,
      updatedAt: c.updatedAt,
    };
    // Toplu ön yükleme: lead başına ~15-18 sorgu ve kampanyanın bütün dizilerinin her lead için okunması yerine
    // sabit sayıda sorgu. Aynı işlemde: önceki eklemeler (ör. aynı alan adı) bellek içi görüntüye eklenir ve sonraki
    // lead'lerin değerlendirmesinde görünür.
    const batch = await prepareEnrollmentBatch(tx, campaignId, ids, {
      now,
      limits: opts.limits,
    });
    const pendingExcluded: ExcludedUpdates = new Map();
    // Sonuç listeleri girdi sırasında kalsın: gruplanmış yazımın sonucu belli olana kadar olaylar sırayla tutulur.
    type Ev =
      | { kind: "dup"; leadId: number }
      | { kind: "excluded"; leadId: number; reasons: IneligibleCode[] }
      | { kind: "reeval"; leadId: number; rowId: number; reasons: IneligibleCode[] };
    const events: Ev[] = [];
    const inserts: (typeof campaignLeads.$inferInsert)[] = [];
    let placeholder = 1e15; // yeni satırların bellek içi kimliği (gerçek kimliklerden büyük sayılır)
    for (const leadId of ids) {
      const row = existing.get(leadId);
      if (row) {
        // Hariç tutulmuş dizi yeniden değerlendirilir; diğer durumlar (çıkarılmış dahil) tekrar sayılır.
        const r =
          row.status === "excluded" && row.redactedAt === null
            ? await reevaluateRow(tx, row, batch, pendingExcluded, now)
            : null;
        if (!r) events.push({ kind: "dup", leadId });
        else if (r.eligible) {
          res.reevaluated++;
          res.added++;
        } else events.push({ kind: "reeval", leadId, rowId: row.id, reasons: r.reasons });
        continue;
      }
      const lead = batch.leadOf(leadId);
      if (!lead) {
        events.push({ kind: "excluded", leadId, reasons: ["lead_not_found"] });
        continue; // olmayan lead için satır açılamaz (yabancı anahtar)
      }
      const verdict = batch.evaluate({ leadId });
      const primary = verdict.eligible ? batch.primaryOf(leadId) : undefined;
      if (verdict.eligible && primary) {
        const hash = hashEmail(primary.email);
        inserts.push({
          campaignId,
          leadId,
          emailId: primary.id,
          recipientEmail: primary.email,
          recipientHash: hash,
          recipientDomain: primary.domain,
          countryCode: lead.countryCode,
          language: suggestLanguage(lead.countryCode),
          status: "pending",
          addedAt: now,
          updatedAt: now,
        });
        batch.inCampaign.push({
          id: ++placeholder,
          leadId,
          hash,
          domain: primary.domain,
          status: "pending",
        });
        res.added++;
      } else {
        const reasons = verdict.eligible
          ? (["no_email"] as IneligibleCode[])
          : [...new Set(verdict.reasons.map((r) => r.code))];
        inserts.push({
          campaignId,
          leadId,
          countryCode: lead.countryCode,
          status: "excluded",
          exclusionReasons: reasons,
          addedAt: now,
          updatedAt: now,
        });
        batch.inCampaign.push({
          id: ++placeholder,
          leadId,
          hash: null,
          domain: null,
          status: "excluded",
        });
        events.push({ kind: "excluded", leadId, reasons });
      }
    }
    for (const part of chunk(inserts, INSERT_CHUNK)) await tx.insert(campaignLeads).values(part);
    // Hâlâ hariç olan yeniden değerlendirilmiş diziler (gruplanmış yazım; yazılamayan satır tekrar sayılır).
    const written = await flushExcluded(tx, pendingExcluded, now);
    for (const ev of events) {
      if (ev.kind === "dup" || (ev.kind === "reeval" && !written.has(ev.rowId)))
        res.duplicates.push(ev.leadId);
      else {
        if (ev.kind === "reeval") res.reevaluated++;
        res.excluded.push({ leadId: ev.leadId, reasons: ev.reasons });
      }
    }

    const [bumped] = await tx
      .update(campaigns)
      .set({
        updatedAt: bumpUpdatedAt(now),
        ...(opts.selection !== undefined ? { selection: opts.selection } : {}),
      })
      .where(eq(campaigns.id, campaignId))
      .returning({ updatedAt: campaigns.updatedAt });
    res.updatedAt = bumped!.updatedAt;
    await audit(
      tx,
      "campaign.leads_added",
      "campaign",
      campaignId,
      {
        added: res.added,
        excluded: res.excluded.length,
        duplicates: res.duplicates.length,
        reevaluated: res.reevaluated,
        selection: opts.selection ?? null,
      },
      now,
    );
    return res;
  });
}

export interface ReevaluateResult {
  /** Yeniden değerlendirilen `excluded` dizi sayısı. */
  reevaluated: number;
  /** Uygun çıkıp `pending` olanlar. */
  nowPending: number;
  /** Hâlâ uygun olmayanlar (gerekçeleri yenilendi). */
  stillExcluded: number;
  updatedAt: number;
}

/**
 * Taslak/hazır kampanyadaki BÜTÜN `excluded` dizileri tek işlemde, kimlik sırasıyla yeniden değerlendirir. Öndeki
 * dizilerin `pending` olması (ör. aynı alan adı) sonrakilerin değerlendirmesinde görünür. Gerçek gönderim izni
 * vermez: canlı kapılar kapalıyken canlı kampanyadaki diziler `live_sending_disabled` ile hariç kalır.
 */
export async function reevaluateExcluded(
  db: Db,
  campaignId: number,
  opts: { now?: number; limits?: FrequencyLimits } = {},
): Promise<ReevaluateResult> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    if (!ADDABLE.includes(c.status)) {
      throw new CampaignError(
        "not_editable",
        "Hariç tutulan alıcılar yalnızca taslak veya hazır kampanyada yeniden denetlenebilir.",
        { status: c.status },
      );
    }
    const rows = await tx
      .select()
      .from(campaignLeads)
      .where(
        and(
          eq(campaignLeads.campaignId, campaignId),
          eq(campaignLeads.status, "excluded"),
          isNull(campaignLeads.redactedAt),
        ),
      )
      .orderBy(asc(campaignLeads.id));
    const res: ReevaluateResult = {
      reevaluated: 0,
      nowPending: 0,
      stillExcluded: 0,
      updatedAt: c.updatedAt,
    };
    const batch = await prepareEnrollmentBatch(
      tx,
      campaignId,
      rows.map((r) => r.leadId),
      { now, limits: opts.limits },
    );
    const pendingExcluded: ExcludedUpdates = new Map();
    for (const row of rows) {
      const r = await reevaluateRow(tx, row, batch, pendingExcluded, now);
      if (r?.eligible) {
        res.reevaluated++;
        res.nowPending++;
      }
    }
    const written = await flushExcluded(tx, pendingExcluded, now);
    res.reevaluated += written.size;
    res.stillExcluded += written.size;
    if (res.reevaluated === 0) return res; // değişiklik yok: kilit belirteci ve kayıt aynı kalır

    const [bumped] = await tx
      .update(campaigns)
      .set({ updatedAt: bumpUpdatedAt(now) })
      .where(eq(campaigns.id, campaignId))
      .returning({ updatedAt: campaigns.updatedAt });
    res.updatedAt = bumped!.updatedAt;
    await audit(
      tx,
      "campaign.leads_reevaluated",
      "campaign",
      campaignId,
      {
        reevaluated: res.reevaluated,
        nowPending: res.nowPending,
        stillExcluded: res.stillExcluded,
      },
      now,
    );
    return res;
  });
}

export async function removeCampaignLead(
  db: Db,
  campaignId: number,
  campaignLeadId: number,
  opts: { now?: number } = {},
): Promise<{ removed: true }> {
  const now = opts.now ?? Date.now();
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
    if (["completed", "cancelled", "stopped"].includes(c.status)) {
      throw new CampaignError("not_editable", "Kapanmış kampanyadan alıcı çıkarılamaz.", {
        status: c.status,
      });
    }
    const rows = await tx
      .update(campaignLeads)
      .set({ status: "removed", nextSendAt: null, lastError: "removed_by_user", updatedAt: now })
      .where(
        and(
          eq(campaignLeads.id, campaignLeadId),
          eq(campaignLeads.campaignId, campaignId),
          inArray(campaignLeads.status, [...REMOVABLE]),
        ),
      )
      .returning({ id: campaignLeads.id });
    if (rows.length === 0) {
      const [cur] = await tx
        .select({ status: campaignLeads.status })
        .from(campaignLeads)
        .where(and(eq(campaignLeads.id, campaignLeadId), eq(campaignLeads.campaignId, campaignId)))
        .limit(1);
      if (!cur) throw new CampaignError("not_found", "Kampanya dizisi bulunamadı.");
      if (cur.status === "in_flight") {
        throw new CampaignError(
          "in_flight",
          "Bu dizinin gönderimi sürüyor veya sonucu inceleme bekliyor; çıkarılamaz.",
        );
      }
      throw new CampaignError("not_editable", "Bu alıcının e-postaları artık değiştirilemez.", {
        status: cur.status,
      });
    }
    await tx
      .update(campaigns)
      .set({ updatedAt: bumpUpdatedAt(now) })
      .where(eq(campaigns.id, campaignId));
    await audit(tx, "campaign.lead_removed", "campaign_lead", campaignLeadId, { campaignId }, now);
    return { removed: true as const };
  });
}

export interface QueueItem {
  id: number;
  leadId: number;
  status: CampaignLeadStatus;
  recipientMasked: string | null;
  recipientDomain: string | null;
  countryCode: string | null;
  language: string | null;
  nextStep: number;
  nextSendAt: number | null;
  lastSentAt: number | null;
  attempts: number;
  lastError: string | null;
  exclusionReasons: string[];
  /** 15.10-2: etkin durma nedeni (sütun; eski satırda işaret). `completed` dizide de olabilir (TB-10). */
  stopReason: SequenceStopReason | null;
}

/** Kuyruk görünümü (FR-CMP-05): sayfalı; alıcı adresi maskelenir. */
export async function listCampaignQueue(
  db: DbExecutor,
  campaignId: number,
  opts: { status?: CampaignLeadStatus; afterId?: number; limit?: number } = {},
): Promise<{ items: QueueItem[]; total: number; nextAfterId: number | null }> {
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!c) throw new CampaignError("not_found", "Kampanya bulunamadı.");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const base = and(
    eq(campaignLeads.campaignId, campaignId),
    opts.status ? eq(campaignLeads.status, opts.status) : undefined,
  );
  const rows = await db
    .select()
    .from(campaignLeads)
    .where(and(base, opts.afterId ? gt(campaignLeads.id, opts.afterId) : undefined))
    .orderBy(asc(campaignLeads.id))
    .limit(limit);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(campaignLeads).where(base);
  return {
    total: Number(n),
    // Sonraki sayfanın imleci: sayfa doluysa son kimlik (yoksa null).
    nextAfterId: rows.length === limit ? rows[rows.length - 1]!.id : null,
    items: rows.map((r) => {
      const at = r.recipientEmail?.lastIndexOf("@") ?? -1;
      return {
        id: r.id,
        leadId: r.leadId,
        status: r.status,
        recipientMasked:
          r.recipientEmail && at > 0
            ? maskEmail(r.recipientEmail.slice(0, at), r.recipientEmail.slice(at + 1))
            : null,
        recipientDomain: r.recipientDomain,
        countryCode: r.countryCode,
        language: r.language,
        nextStep: r.nextStep,
        nextSendAt: r.nextSendAt,
        lastSentAt: r.lastSentAt,
        attempts: r.attempts,
        lastError: r.lastError,
        exclusionReasons: r.exclusionReasons,
        stopReason: effectiveStopReason(r.status, r.stopReason, r.exclusionReasons),
      };
    }),
  };
}
