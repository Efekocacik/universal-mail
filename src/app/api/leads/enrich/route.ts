import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { enqueueJob } from "@/lib/jobs/queue";
import { marginalCostUsd } from "@/lib/places/pricing";
import { monthSkuCalls } from "@/lib/budget";
import { placeIdsForLeads } from "@/lib/scan/enrich";
import { getSetting } from "@/lib/settings";
import { chunk, round } from "@/lib/util";
import { budgetSummary, requireCollectionReady } from "../../scans/guard";

export const dynamic = "force-dynamic";

const schema = z.object({
  leadIds: z.array(z.number().int()).min(1).max(2000),
  dryRun: z.boolean().optional(),
});

/** Seçili lead'leri Place Details (Enterprise) ile zenginleştirir. `dryRun` yalnızca maliyet tahmini döndürür. */
export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const { leadIds, dryRun } = await body(req, schema);
  const placeIds = await placeIdsForLeads(db, leadIds);
  if (placeIds.length === 0)
    throw new HttpError(400, "Seçili lead'lerde Google işletme kaydı yok.");

  const provider = await getSetting(db, "places.provider");
  const before = await monthSkuCalls(db, provider, "place_details_enterprise");
  const cost = round(marginalCostUsd("place_details_enterprise", before, placeIds.length), 2);
  const budget = await budgetSummary(db);
  const preview = {
    places: placeIds.length,
    estimatedCostUsd: cost,
    remainingBudgetUsd: budget.remainingUsd,
    sku: "place_details_enterprise",
  };
  if (dryRun) return json({ preview });
  if (budget.level === "blocked")
    throw new HttpError(409, "Aylık bütçe sınırına ulaşıldı.", { code: "BUDGET_BLOCKED" });

  for (const part of chunk(placeIds, 100))
    await enqueueJob(db, "place.enrich", { placeIds: part }, { maxAttempts: 2 });
  return json({ queued: true, preview }, { status: 202 });
});
