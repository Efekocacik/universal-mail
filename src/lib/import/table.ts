import { IMPORT_LIMITS, ImportError, type ImportWarning, type ParsedTable } from "./types";

/**
 * Ayrıştırıcıların ortak son adımı: kayıt dizisini (ilk boş olmayan kayıt başlıktır) sınırlara uyan bir tabloya
 * çevirir. CSV ve XLSX aynı kuralları paylaşır:
 *  - tümüyle boş kayıtlar atlanır;
 *  - başlık yoksa veya başlıktan sonra veri yoksa `IMPORT_EMPTY`;
 *  - veri satırı `maxRows`'u aşarsa `IMPORT_TOO_MANY_ROWS` (ayrıştırıcı bunu erken de atabilir);
 *  - sütun `maxColumns`'ta, hücre `maxCellChars`'ta kesilir (uyarıyla);
 *  - satırlar başlık genişliğine getirilir (eksik hücre "", fazla hücre atılır + uyarı).
 */
export function buildTable(
  records: readonly (readonly string[])[],
  initialWarnings: readonly ImportWarning[] = [],
  /** Kayıtların dosyadaki satır numaraları (1'den; yoksa kayıt sırası + 1). Rapor bu numaraları kullanır. */
  recordNumbers?: readonly number[],
): ParsedTable {
  const warnings = new Set<ImportWarning>(initialWarnings);
  const clean = (cell: string): string => {
    const v = cell.trim();
    if (v.length <= IMPORT_LIMITS.maxCellChars) return v;
    warnings.add("cells_truncated");
    return v.slice(0, IMPORT_LIMITS.maxCellChars);
  };
  const numbered = records
    .map((cells, i) => ({ cells, no: recordNumbers?.[i] ?? i + 1 }))
    .filter((r) => r.cells.some((c) => c.trim() !== ""));
  const [headRec, ...dataRecs] = numbered;
  const head = headRec?.cells;
  const data = dataRecs.map((r) => r.cells);
  if (!head) throw new ImportError("IMPORT_EMPTY", "Dosyada başlık satırı yok.");
  if (data.length === 0) throw new ImportError("IMPORT_EMPTY", "Başlıktan sonra veri satırı yok.");
  if (data.length > IMPORT_LIMITS.maxRows)
    throw new ImportError("IMPORT_TOO_MANY_ROWS", `En çok ${IMPORT_LIMITS.maxRows} satır.`);

  // Sondaki boş başlık hücreleri sütun sayılmaz (Excel'in "kullanılmış aralık" artığı).
  let width = head.length;
  while (width > 1 && head[width - 1]!.trim() === "") width--;
  if (width > IMPORT_LIMITS.maxColumns) {
    warnings.add("columns_truncated");
    width = IMPORT_LIMITS.maxColumns;
  }
  const headers = head.slice(0, width).map(clean);
  const seen = new Set<string>();
  for (const h of headers) {
    const k = h.toLocaleLowerCase("tr");
    if (k && seen.has(k)) warnings.add("duplicate_headers");
    seen.add(k);
  }
  const rows = data.map((r) => {
    if (r.slice(width).some((c) => c.trim() !== "")) warnings.add("extra_cells");
    const out = new Array<string>(width);
    for (let i = 0; i < width; i++) out[i] = clean(r[i] ?? "");
    return out;
  });
  return { headers, rows, rowNumbers: dataRecs.map((r) => r.no), warnings: [...warnings] };
}
