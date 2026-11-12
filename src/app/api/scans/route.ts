import { database, HttpError, json, route, body } from "@/lib/api/http";
import { createAndStartScan, listScans } from "@/lib/scan/service";
import { z } from "zod";
import { checkTargetCountry, requireCollectionReady, requirePaidScanAllowed } from "./guard";
import { scanRequestSchema } from "./schema";

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
  const { acknowledgeRisk, ...request } = input;

  const country = await checkTargetCountry(db, request.region);
  if (country.blocked) throw new HttpError(400, country.message!, { code: "COUNTRY_NOT_TARGETED" });
  await requirePaidScanAllowed(db, request, acknowledgeRisk);

  const created = await createAndStartScan(db, {
    ...request,
    region: { ...request.region, countryCode: request.region.countryCode ?? country.countryCode },
  });
  return json({ scanId: created.scanId, estimate: created.estimate }, { status: 201 });
});
