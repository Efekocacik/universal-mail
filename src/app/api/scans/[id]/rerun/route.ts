import { eq } from "drizzle-orm";
import { z } from "zod";
import { database, HttpError, intParam, json, route } from "@/lib/api/http";
import { regions, scans } from "@/lib/db/schema";
import { createAndStartScan, type ScanRequest } from "@/lib/scan/service";
import { checkTargetCountry, requireCollectionReady, requirePaidScanAllowed } from "../../guard";

export const dynamic = "force-dynamic";

/**
 * Aynı bölge ve ayarlarla yeni bir tarama başlatır. Anahtarı aynı olduğundan önceki tamamlanmış taramayla
 * karşılaştırılır ve yeni tespit edilen işletmeler işaretlenir (SRS 4.2, FR-DIS-08). Zamanlama Faz 4'tedir;
 * şimdilik kullanıcı bu düğmeyle elle başlatır.
 */
const rerunSchema = z.object({ acknowledgeRisk: z.boolean().optional() }).strict();

/** Gövde isteğe bağlıdır (boş gövde = onaysız); varsa yalnızca `acknowledgeRisk` kabul edilir. */
async function rerunBody(req: Request): Promise<z.infer<typeof rerunSchema>> {
  let text = "";
  try {
    text = await req.text();
  } catch {
    text = "";
  }
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Bilgiler gönderilemedi. Sayfayı yenileyip yeniden deneyin.");
  }
  return rerunSchema.parse(raw);
}

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const db = await database();
  await requireCollectionReady(db);
  const id = intParam((await ctx.params).id);
  const { acknowledgeRisk } = await rerunBody(req);
  const row = (
    await db
      .select({ scan: scans, region: regions })
      .from(scans)
      .innerJoin(regions, eq(regions.id, scans.regionId))
      .where(eq(scans.id, id))
      .limit(1)
  )[0];
  if (!row) throw new HttpError(404, "Tarama bulunamadı.");

  const region = {
    kind: row.region.kind,
    name: row.region.name,
    countryCode: row.region.countryCode,
    bbox: row.region.geometry.bbox,
    circle: row.region.geometry.circle,
    cityId: row.region.geometry.cityId,
  };
  const country = await checkTargetCountry(db, region);
  if (country.blocked) throw new HttpError(400, country.message!, { code: "COUNTRY_NOT_TARGETED" });

  const customKeywords = row.scan.queries
    .filter((q) => q.kind === "keyword" && !q.categoryKey)
    .map((q) => q.term);
  const request: ScanRequest = {
    region,
    categoryIds: row.scan.categorySetIds,
    customKeywords,
    strategy: row.scan.strategy,
    fieldProfile: row.scan.fieldProfile,
  };
  // Yeni taramayla AYNI kapı: güncel sağlayıcı anahtarı, bütçe ve tahmini maliyet onayı (`NEEDS_ACK`).
  await requirePaidScanAllowed(db, request, acknowledgeRisk);
  const created = await createAndStartScan(db, request);
  return json({ scanId: created.scanId, estimate: created.estimate }, { status: 201 });
});
