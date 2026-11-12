import { and, inArray, sql } from "drizzle-orm";
import { MAX_SELECTION, parseLeadFilters, type Selection } from "@/lib/api/filters";
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

/** Kampanya dizisinin hâlâ sürdüğü durumlar (gönderim bekleyen/süren). */
export const ACTIVE_SEQUENCE_STATUSES = [
  "pending",
  "scheduled",
  "in_flight",
  "waiting_next",
] as const;

export interface ResolvedSelection {
  ids: number[];
  /** Kimlikle seçimde: istenip bulunamayan kimlik sayısı. */
  notFound: number;
  /** Süzgeç seçiminde: eşleşen toplam (sınırsız). */
  matchedTotal: number;
  /** Süzgece 2000'den fazla lead uydu; yalnızca ilk 2000'i işlendi. */
  capped: boolean;
}

/**
 * Seçimi lead kimliklerine çözer. Kimlikler `buildWhere`'in arşiv koşulundan GEÇMEZ (arşivdekiler de seçilebilir;
 * "Geri al" bunlara uygulanır); süzgeç seçimi ise listedeki gibi çözülür (`archived=1` arşiv görünümüdür).
 */
export async function resolveSelection(
  db: Db,
  selection: Selection,
  max = MAX_SELECTION,
): Promise<ResolvedSelection> {
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
    };
  }
  const filters = parseLeadFilters(new URLSearchParams(selection.filterQuery));
  const [ids, total] = await Promise.all([
    queryLeadIds(db, filters, max),
    countLeadIds(db, filters),
  ]);
  return { ids, notFound: 0, matchedTotal: total, capped: total > ids.length };
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

async function activeCampaignIds(tx: DbExecutor, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (const part of chunk(ids, 500)) {
    const rows = await tx
      .selectDistinct({ id: campaignLeads.leadId })
      .from(campaignLeads)
      .where(
        and(
          inArray(campaignLeads.leadId, part),
          inArray(campaignLeads.status, [...ACTIVE_SEQUENCE_STATUSES]),
        ),
      );
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** İşlemin değiştireceği satır koşulu (idempotentlik bu koşuldadır). */
function pendingCondition(action: BulkAction) {
  if (action === "archive") return sql`${leads.archivedAt} IS NULL`;
  if (action === "unarchive") return sql`${leads.archivedAt} IS NOT NULL`;
  return sql`${leads.status} <> 'do_not_contact'`;
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
  opts: { now?: number } = {},
): Promise<BulkResult> {
  const now = opts.now ?? Date.now();
  const sel = await resolveSelection(db, input.selection);
  const dryRun = input.dryRun === true;

  const result = await db.transaction(async (tx) => {
    const blocked =
      input.action === "archive" ? await activeCampaignIds(tx, sel.ids) : new Set<number>();
    const eligible = sel.ids.filter((id) => !blocked.has(id));
    let pending = 0;
    const changedIds: number[] = [];
    for (const part of chunk(eligible, 500)) {
      const where = and(inArray(leads.id, part), pendingCondition(input.action));
      if (dryRun) {
        const [r] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(leads)
          .where(where);
        pending += Number(r?.n ?? 0);
      } else {
        const rows = await tx
          .update(leads)
          .set(updateSet(input.action, now))
          .where(where)
          .returning({ id: leads.id });
        changedIds.push(...rows.map((r) => r.id));
      }
    }
    const done = dryRun ? pending : changedIds.length;
    const out: BulkResult = {
      action: input.action,
      matched: sel.ids.length,
      changed: done,
      skipped: {
        unchanged: eligible.length - done,
        activeCampaign: blocked.size,
        notFound: sel.notFound,
      },
      capped: sel.capped,
      matchedTotal: sel.matchedTotal,
      dryRun,
      changedIds,
    };
    if (!dryRun) {
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
