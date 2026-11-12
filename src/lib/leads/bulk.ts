import { and, inArray, sql, type SQL } from "drizzle-orm";
import { MAX_SELECTION, parseLeadFilters, type Selection } from "@/lib/api/filters";
import { ACTIVE_SEQUENCE } from "@/lib/compliance/eligibility";
import { audit } from "@/lib/db/audit";
import type { Db, DbExecutor } from "@/lib/db/client";
import { campaignLeads, leads } from "@/lib/db/schema";
import { chunk } from "@/lib/util";
import { auditFilterSummary, countLeadIds, queryLeadIds } from "./query";

/**
 * Seçili lead'ler üzerinde toplu işlemler (FR-LEAD-06). Hepsi "sabit değere ayarla" türündedir ve koşul SQL'dedir;
 * bu yüzden aynı istek iki kez çalışırsa ikinci çalıştırma değişiklik yapmaz (`unchanged` sayılır): idempotent.
 *
 *  - `archive`: lead'i arşivler (yumuşak silme; bkz. schema.ts `leads.archivedAt`). Etkin bir kampanya dizisindeki lead
 *    ARŞİVLENMEZ (`activeCampaign`): gönderim sürerken listeden kaybolması kafa karıştırır; önce kampanyadan çıkarılmalı.
 *  - `unarchive`: arşivden çıkarır ("Geri al").
 *  - `do_not_contact`: "İletişime geçme" olarak işaretler (uyum kilidi; gönderimden hemen önce de denetlenir). Bu yön tek
 *    yönlüdür: toplu işlemle kilit KALDIRILAMAZ (tekil ayrıntıda açık onayla kaldırılabilir, bkz. mutations.ts).
 */
export const BULK_ACTIONS = ["archive", "unarchive", "do_not_contact"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * Lead etkin bir kampanya dizisinde (gönderim bekliyor/sürüyor; durumlar uygunluk denetimiyle ortaktır). Arşivleme bu
 * koşulu UPDATE'in kendisinde denetler: ayrı bir okuma ile yazma arasında kampanyaya alınan lead arşivlenemez.
 */
const IN_ACTIVE_SEQUENCE = sql`EXISTS (SELECT 1 FROM ${campaignLeads} WHERE ${campaignLeads.leadId} = ${leads.id} AND ${inArray(campaignLeads.status, [...ACTIVE_SEQUENCE])})`;
const NOT_IN_ACTIVE_SEQUENCE = sql`NOT ${IN_ACTIVE_SEQUENCE}`;

export interface ResolvedSelection {
  ids: number[];
  /** Kimlikle seçimde: istenip bulunamayan kimlik sayısı. */
  notFound: number;
  /** Süzgeç seçiminde: eşleşen toplam (sınırsız). */
  matchedTotal: number;
  /** Bu seferden sonra hâlâ işlenecek lead kalıyor (en fazla 2000 işlenir; yeniden çalıştırma sıradakilere geçer). */
  capped: boolean;
  /** Süzgeç seçiminde sorguda (sınırdan önce) elenenler: zaten istenen durumda / etkin kampanyada. */
  preSkipped: { unchanged: number; activeCampaign: number };
}

/**
 * Seçimi lead kimliklerine çözer. Kimlikler `buildWhere`'in arşiv koşulundan GEÇMEZ (arşivdekiler de seçilebilir;
 * "Geri al" bunlara uygulanır); süzgeç seçimi ise listedeki gibi çözülür (`archived=1` arşiv görünümüdür).
 *
 * Süzgeç seçiminde `action` verilirse yalnızca o işlemin HÂLÂ değiştireceği lead'ler alınır (koşul LIMIT'ten önce):
 * aksi halde 2000'den fazla eşleşmede her yeniden çalıştırma aynı ilk 2000'i alır, "Değişecek 0" der ve kalanlara hiç
 * ulaşılmazdı. Elenenler `preSkipped` ile sayılır (önizleme yine doğru dökümü gösterir).
 */
export async function resolveSelection(
  db: Db,
  selection: Selection,
  opts: { max?: number; action?: BulkAction } = {},
): Promise<ResolvedSelection> {
  const max = opts.max ?? MAX_SELECTION;
  if ("leadIds" in selection) {
    const wanted = [...new Set(selection.leadIds)];
    const found: number[] = [];
    for (const part of chunk(wanted, 500)) {
      const rows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.id, part));
      found.push(...rows.map((r) => r.id));
    }
    return {
      ids: found,
      notFound: wanted.length - found.length,
      matchedTotal: found.length,
      capped: false,
      preSkipped: { unchanged: 0, activeCampaign: 0 },
    };
  }
  const filters = parseLeadFilters(new URLSearchParams(selection.filterQuery));
  if (!opts.action) {
    const [ids, total] = await Promise.all([
      queryLeadIds(db, filters, max),
      countLeadIds(db, filters),
    ]);
    return {
      ids,
      notFound: 0,
      matchedTotal: total,
      capped: total > ids.length,
      preSkipped: { unchanged: 0, activeCampaign: 0 },
    };
  }
  const pending = pendingCondition(opts.action);
  const eligible = actionCondition(opts.action);
  const [ids, total, pendingTotal, eligibleTotal] = await Promise.all([
    queryLeadIds(db, filters, max, { where: eligible }),
    countLeadIds(db, filters),
    countLeadIds(db, filters, { where: pending }),
    opts.action === "archive" ? countLeadIds(db, filters, { where: eligible }) : null,
  ]);
  const eligibleCount = eligibleTotal ?? pendingTotal;
  return {
    ids,
    notFound: 0,
    matchedTotal: total,
    capped: eligibleCount > ids.length,
    preSkipped: {
      unchanged: Math.max(0, total - pendingTotal),
      activeCampaign: Math.max(0, pendingTotal - eligibleCount),
    },
  };
}

export interface BulkResult {
  action: BulkAction;
  /** Seçimde bulunan (işlenen) lead sayısı. */
  matched: number;
  /** Gerçekten değişen satır sayısı (dryRun'da: değişecek olan). */
  changed: number;
  skipped: {
    /** Zaten istenen durumda (yeniden çalıştırma veya karışık seçim). */
    unchanged: number;
    /** Etkin bir kampanya dizisinde olduğu için arşivlenmedi. */
    activeCampaign: number;
    /** Kimlik bulunamadı (silinmiş olabilir). */
    notFound: number;
  };
  capped: boolean;
  /** Süzgeç seçiminde eşleşen toplam (sınırlamadan önce). */
  matchedTotal: number;
  dryRun: boolean;
  /** Gerçekten değişen lead kimlikleri ("Geri al" bunlarla yapılır; dryRun'da boş). */
  changedIds: number[];
}

/** İşlemin değiştireceği satır koşulu (idempotentlik bu koşuldadır). */
function pendingCondition(action: BulkAction): SQL {
  if (action === "archive") return sql`${leads.archivedAt} IS NULL`;
  if (action === "unarchive") return sql`${leads.archivedAt} IS NOT NULL`;
  return sql`${leads.status} <> 'do_not_contact'`;
}

/** UPDATE'in tam koşulu: değişmesi gereken VE (arşivde) etkin kampanyada olmayan satırlar. */
function actionCondition(action: BulkAction): SQL {
  return action === "archive"
    ? and(pendingCondition(action), NOT_IN_ACTIVE_SEQUENCE)!
    : pendingCondition(action);
}

async function countWhere(tx: DbExecutor, where: SQL | undefined): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(leads)
    .where(where);
  return Number(r?.n ?? 0);
}

function updateSet(action: BulkAction, now: number) {
  if (action === "archive") return { archivedAt: now, updatedAt: now };
  if (action === "unarchive") return { archivedAt: null, updatedAt: now };
  return { status: "do_not_contact" as const, updatedAt: now };
}

/**
 * Toplu işlemi tek işlemde (transaction) uygular. `dryRun` aynı sayıları yazmadan döndürür (onay penceresi
 * "N işletme etkilenecek" der). Denetim kaydı: işlem başına TEK özet satırı (`lead.bulk`), lead başına değil; e-posta
 * veya ad yazılmaz.
 */
export async function runBulk(
  db: Db,
  input: { action: BulkAction; selection: Selection; dryRun?: boolean },
  opts: { now?: number; max?: number } = {},
): Promise<BulkResult> {
  const now = opts.now ?? Date.now();
  const sel = await resolveSelection(db, input.selection, { action: input.action, max: opts.max });
  const dryRun = input.dryRun === true;

  const result = await db.transaction(async (tx) => {
    let pending = 0;
    let blocked = 0;
    const changedIds: number[] = [];
    for (const part of chunk(sel.ids, 500)) {
      const inPart = inArray(leads.id, part);
      const where = and(inPart, actionCondition(input.action));
      if (dryRun) pending += await countWhere(tx, where);
      else {
        const rows = await tx
          .update(leads)
          .set(updateSet(input.action, now))
          .where(where)
          .returning({ id: leads.id });
        changedIds.push(...rows.map((r) => r.id));
      }
      // Değişmesi gerekip etkin kampanya yüzünden değişmeyenler (yazmadan SONRA sayılır: koşul UPDATE'teydi).
      if (input.action === "archive")
        blocked += await countWhere(
          tx,
          and(inPart, pendingCondition(input.action), IN_ACTIVE_SEQUENCE),
        );
    }
    const done = dryRun ? pending : changedIds.length;
    const out: BulkResult = {
      action: input.action,
      matched: sel.ids.length,
      changed: done,
      skipped: {
        unchanged: sel.ids.length - done - blocked + sel.preSkipped.unchanged,
        activeCampaign: blocked + sel.preSkipped.activeCampaign,
        notFound: sel.notFound,
      },
      capped: sel.capped,
      matchedTotal: sel.matchedTotal,
      dryRun,
      changedIds,
    };
    // Hiçbir şey eşleşmediyse (yol 409 döner) denetim kaydı yazılmaz.
    if (!dryRun && out.matchedTotal > 0) {
      await audit(
        tx,
        "lead.bulk",
        "leads",
        undefined,
        {
          action: input.action,
          matched: out.matched,
          changed: out.changed,
          skipped: out.skipped,
          capped: out.capped,
          selection:
            "leadIds" in input.selection
              ? { kind: "ids", count: input.selection.leadIds.length }
              : {
                  kind: "filter",
                  filters: auditFilterSummary(
                    parseLeadFilters(new URLSearchParams(input.selection.filterQuery)),
                  ),
                },
        },
        now,
      );
    }
    return out;
  });
  return result;
}
