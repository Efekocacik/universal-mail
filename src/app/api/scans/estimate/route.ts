import { body, database, json, route } from "@/lib/api/http";
import { checkTargetCountry, budgetSummary } from "../guard";
import { scanRequestSchema } from "../schema";
import { estimateForRequest } from "@/lib/scan/service";

export const dynamic = "force-dynamic";

/** Tarama öncesi tahmini çağrı sayısı ve maliyet (FR-DIS-05). Hiçbir şey kaydetmez, ücretli çağrı yapmaz. */
export const POST = route(async (req: Request) => {
  const db = await database();
  const input = await body(req, scanRequestSchema);
  const { estimate } = await estimateForRequest(db, input);
  const budget = await budgetSummary(db);
  const country = await checkTargetCountry(db, input.region);
  return json({
    estimate,
    budget: {
      monthlyUsd: budget.monthlyUsd,
      spentUsd: budget.spentUsd,
      remainingUsd: budget.remainingUsd,
      level: budget.level,
    },
    exceedsBudget: estimate.costUsd.high > budget.remainingUsd,
    country,
    disclaimer:
      "Gerçek kullanım tahminden farklı olabilir. Kesin tutar Google Cloud hesabınızdaki faturadır.",
  });
});
