import { database, HttpError, intParam, json, route } from "@/lib/api/http";
import { getScanDetail } from "@/lib/scan/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  const detail = await getScanDetail(db, intParam((await ctx.params).id));
  if (!detail) throw new HttpError(404, "Tarama bulunamadı.");
  return json({
    scan: detail.scan,
    regionName: detail.regionName,
    countryCode: detail.countryCode,
    geometry: detail.geometry,
    units: detail.unitStats.map((u) => ({
      status: u.status,
      count: Number(u.n),
      saturated: Number(u.saturated ?? 0),
    })),
    failedUnits: detail.failedUnits,
  });
});
