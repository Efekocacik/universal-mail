import { json } from "@/lib/api/http";
import { previewImport } from "@/lib/import/service";
import { importRoute, readUpload } from "../http";

export const dynamic = "force-dynamic";

/**
 * Durumsuz önizleme: `multipart/form-data` `file` (≤ 5 MB; `.csv` veya `.xlsx`, uzantı VE imza). Hiçbir şey yazılmaz,
 * kurulum gerekmez. 200 `{format, headers, sampleRows (≤20), totalRows, suggestedMapping, warnings}`.
 * Hatalar: 413 IMPORT_TOO_LARGE, 415 IMPORT_UNSUPPORTED, 422 IMPORT_PARSE / IMPORT_EMPTY / IMPORT_TOO_MANY_ROWS.
 */
export const POST = importRoute(async (req: Request) => {
  const { file } = await readUpload(req);
  return json(previewImport(file));
});
