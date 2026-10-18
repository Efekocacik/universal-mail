import { database, HttpError, json, route, body } from "@/lib/api/http";
import { getSecret } from "@/lib/secrets/store";
import { getSetting } from "@/lib/settings";
import { createAndStartScan, listScans } from "@/lib/scan/service";
import { z } from "zod";
import { budgetSummary, checkTargetCountry, requireCollectionReady } from "./guard";
import { scanRequestSchema } from "./schema";
import { estimateForRequest } from "@/lib/scan/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const db = await database();
  const rows = await listScans(db);
  return json({
    scans: rows.map((r) => ({
      id: r.scan.id,
      regionName: r.regionName,
      countryCode: r.countryCode,
      status: r.scan.status,
      pauseReason: r.scan.pauseReason,
      error: r.scan.error,
      provider: r.scan.provider,
      strategy: r.scan.strategy,
      fieldProfile: r.scan.fieldProfile,
      progress: r.scan.progress,
      callsBySku: r.scan.callsBySku,
      costUsd: r.scan.costUsd,
      isBaseline: r.scan.isBaseline,
      createdAt: r.scan.createdAt,
      startedAt: r.scan.startedAt,
      finishedAt: r.scan.finishedAt,
    })),
  });
});

const createSchema = scanRequestSchema.extend({ acknowledgeRisk: z.boolean().optional() });

export const POST = route(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const input = await body(req, createSchema);

  if (
    (await getSetting(db, "places.provider")) === "google" &&
    !(await getSecret("google.placesKey"))
  ) {
    throw new HttpError(400, "Google Places API anahtarı tanımlı değil. Ayarlar'dan ekleyin.");
  }
  const country = await checkTargetCountry(db, input.region);
  if (country.blocked) throw new HttpError(400, country.message!, { code: "COUNTRY_NOT_TARGETED" });

  const { estimate } = await estimateForRequest(db, input);
  const budget = await budgetSummary(db);
  if (budget.level === "blocked")
    throw new HttpError(409, "Aylık bütçe sınırına ulaşıldı. Ayarlar'dan bütçeyi artırın.", {
      code: "BUDGET_BLOCKED",
    });
  if (estimate.costUsd.high > budget.remainingUsd && !input.acknowledgeRisk) {
    throw new HttpError(
      409,
      `Yüksek tahmin (${estimate.costUsd.high.toFixed(2)} USD) kalan bütçenizi (${budget.remainingUsd.toFixed(2)} USD) aşabilir. Tarama bütçe dolunca otomatik durur. Yine de başlatmak için onaylayın.`,
      {
        code: "NEEDS_ACK",
      },
    );
  }

  const { acknowledgeRisk, ...request } = input;
  void acknowledgeRisk;
  const created = await createAndStartScan(db, {
    ...request,
    region: { ...request.region, countryCode: request.region.countryCode ?? country.countryCode },
  });
  return json({ scanId: created.scanId, estimate: created.estimate }, { status: 201 });
});
