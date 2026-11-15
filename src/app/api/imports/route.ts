import { eq } from "drizzle-orm";
import { database, HttpError, json } from "@/lib/api/http";
import { categorySets } from "@/lib/db/schema";
import { commitImport, importMetaSchema, listImportBatches } from "@/lib/import/service";
import { requireCollectionReady } from "../scans/guard";
import { importRoute, readUpload } from "./http";

export const dynamic = "force-dynamic";

/** Son içe aktarmalar: `?limit=1..50` (varsayılan 20). 200 `{batches}`. */
export const GET = importRoute(async (req: Request) => {
  const db = await database();
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 50) : 20;
  return json({ batches: await listImportBatches(db, limit) });
});

/**
 * İçe aktarma: `multipart/form-data` `file` + `meta` (JSON: `{mapping, defaultCountry?, categoryKey?, sourceNote,
 * usageAck: true, dryRun?}`). `dryRun` yalnızca sayar (onay gerekmez, 200). Gerçek içe aktarma 201 `{batch, created,
 * duplicates[], invalid[], …}`. Kurulum/onay yoksa 403 SETUP_REQUIRED; onay/kaynak notu eksikse 400
 * IMPORT_ACK_REQUIRED; eşleme dosyaya uymuyorsa 400 IMPORT_MAPPING; ayrıca önizlemenin dosya hataları.
 */
export const POST = importRoute(async (req: Request) => {
  const db = await database();
  await requireCollectionReady(db);
  const { file, meta: rawMeta } = await readUpload(req);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawMeta ?? "");
  } catch {
    throw new HttpError(400, "İçe aktarma ayarları okunamadı. Sayfayı yenileyip yeniden deneyin.", {
      code: "VALIDATION",
    });
  }
  const meta = importMetaSchema.parse(parsedJson);
  if (meta.categoryKey) {
    const [cat] = await db
      .select({ key: categorySets.key })
      .from(categorySets)
      .where(eq(categorySets.key, meta.categoryKey))
      .limit(1);
    if (!cat) throw new HttpError(400, "Bilinmeyen kategori.", { code: "VALIDATION" });
  }
  const result = await commitImport(db, file, meta);
  // `duplicates`/`invalid` satır listeleri en çok 200'dür; tam sayılar `duplicateCount`/`invalidCount`.
  return json(result, { status: result.dryRun ? 200 : 201 });
});
