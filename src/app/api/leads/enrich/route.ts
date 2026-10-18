import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { parseLeadFilters } from "@/lib/api/filters";
import { enqueueJob } from "@/lib/jobs/queue";
import { queryUncachedPlaceIds } from "@/lib/leads/query";
import { getCacheMap } from "@/lib/places/cache";
import { marginalCostUsd } from "@/lib/places/pricing";
import { monthSkuCalls } from "@/lib/budget";
import { placeIdsForLeads, skuForMode } from "@/lib/scan/enrich";
import { getSetting } from "@/lib/settings";
import { chunk, round } from "@/lib/util";
import { budgetSummary, requireCollectionReady } from "../../scans/guard";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    /** Seçili lead'ler. */
    leadIds: z.array(z.number().int()).min(1).max(2000).optional(),
    /** Alternatif: listedeki süzgeçlerin sorgu dizesi; Google verisi yüklü olmayan kayıtlar yenilenir (en fazla 2000). */
    filtersQuery: z.string().max(2000).optional(),
    /**
     * refresh: ad, adres, konum, durum Google'dan yeniden yüklenir (Place Details Pro). Uygulama yeniden açıldığında
     *          Google verisi saklanmadığı için liste bu işlemle doldurulur.
     * enrich:  ayrıca web sitesi, telefon, değerlendirme sayısı (Place Details Enterprise).
     */
    mode: z.enum(["refresh", "enrich"]).default("enrich"),
    /** refresh modunda önbellekte zaten yüklü olanlar da yenilensin mi? Varsayılan: hayır (gereksiz maliyeti önler). */
    force: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((v) => v.leadIds || v.filtersQuery !== undefined, "leadIds veya filtersQuery gerekli.");

/** Seçili lead'lerin Google verisini Place Details ile yükler. `dryRun` yalnızca maliyet tahmini döndürür. */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const { leadIds, filtersQuery, mode, force, dryRun } = await body(req, schema);

  let placeIds = leadIds
    ? await placeIdsForLeads(db, leadIds)
    : await queryUncachedPlaceIds(db, parseLeadFilters(new URLSearchParams(filtersQuery)), 2000);
  if (placeIds.length === 0 && leadIds)
    throw new HttpError(400, "Seçili lead'lerde Google işletme kaydı yok.");
  if (leadIds && mode === "refresh" && !force) {
    const cached = await getCacheMap(db, placeIds);
    placeIds = placeIds.filter((id) => !cached.has(id));
  }

  const sku = skuForMode(mode);
  const provider = await getSetting(db, "places.provider");
  const before = await monthSkuCalls(db, provider, sku);
  const cost = round(marginalCostUsd(sku, before, placeIds.length), 2);
  const budget = await budgetSummary(db);
  const preview = {
    places: placeIds.length,
    estimatedCostUsd: cost,
    remainingBudgetUsd: budget.remainingUsd,
    sku,
    mode,
  };
  if (dryRun || placeIds.length === 0) return json({ preview, queued: false });
  if (budget.level === "blocked")
    throw new HttpError(409, "Aylık bütçe sınırına ulaşıldı.", { code: "BUDGET_BLOCKED" });

  for (const part of chunk(placeIds, 100))
    await enqueueJob(db, "place.enrich", { placeIds: part, mode }, { maxAttempts: 2 });
  return json({ queued: true, preview }, { status: 202 });
});
