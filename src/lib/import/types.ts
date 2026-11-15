import type { ImportFormat } from "@/lib/db/schema";

/**
 * Faz 5 (P0 sözleşmesi, sahibi: paket I): CSV/XLSX içe aktarma ayrıştırıcı arayüzü ve sınırlar. Ayrıştırıcılar yeni
 * bağımlılık kullanmaz (CSV elle; XLSX `node:zlib` + `cheerio` XML kipi). Önizleme durumsuzdur: satırlar saklanmaz.
 */

export type { ImportFormat } from "@/lib/db/schema";

export const IMPORT_LIMITS = {
  /** Yüklenen dosyanın en büyük boyutu. */
  maxBytes: 5 * 1024 * 1024,
  /** Başlık hariç en çok veri satırı. */
  maxRows: 5000,
  /** Önizlemede gösterilen satır sayısı. */
  previewRows: 20,
  /** En çok sütun (fazlası okunmaz; uyarı verilir). Seyrek XLSX'te `XFD1` gibi uç hücre bellek şişirmesin. */
  maxColumns: 200,
  /** Hücre başına en çok karakter (fazlası kesilir; uyarı verilir). */
  maxCellChars: 2000,
  /** XLSX (zip) koruması: girdi sayısı, toplam açılmış boyut, girdi başına sıkıştırma oranı. */
  zipMaxEntries: 2000,
  zipMaxTotalBytes: 50 * 1024 * 1024,
  zipMaxRatio: 200,
  /**
   * XLSX: tek bir XML parçasının (sayfa, paylaşılan metinler) en büyük açılmış boyutu; DOM'a çevrilmeden önce
   * denetlenir. Sayfadaki `<row>` öğesi sayısı da (boş satırlar atıldıktan sonra) `maxRows × 4` ile sınırlıdır.
   */
  xlsxMaxXmlBytes: 20 * 1024 * 1024,
} as const;

/** Ayrıştırılmış tablo: ilk satır başlık; hücreler metin (boş hücre ""). */
export interface ParsedTable {
  headers: string[];
  rows: string[][];
  /** `rows[i]`'nin dosyadaki satır numarası (başlık 1. satırsa ilk veri genelde 2); hata raporunda gösterilir. */
  rowNumbers?: number[];
  /** Okuma sırasında düzeltilen durumlar (kararlı kodlar; arayüz `imports.warning.<kod>` ile yerelleştirir). */
  warnings?: ImportWarning[];
}

/** Önizleme uyarı kodları: veri okunur ama kullanıcı bilmelidir. */
export const IMPORT_WARNINGS = [
  "encoding_fallback",
  "columns_truncated",
  "extra_cells",
  "cells_truncated",
  "duplicate_headers",
] as const;
export type ImportWarning = (typeof IMPORT_WARNINGS)[number];

export interface ImportParser {
  readonly format: ImportFormat;
  /** Hata durumunda `ImportError` (IMPORT_PARSE / IMPORT_EMPTY / IMPORT_TOO_MANY_ROWS) fırlatır. */
  parse(data: Uint8Array): ParsedTable;
}

/** Sütun eşlemesi: alan → sütun dizini (yoksa null). `name` zorunludur. */
export interface ImportMapping {
  name: number;
  country: number | null;
  city: number | null;
  website: number | null;
  email: number | null;
  category: number | null;
  notes: number | null;
}

export const IMPORT_ERROR_CODES = [
  "IMPORT_TOO_LARGE",
  "IMPORT_UNSUPPORTED",
  "IMPORT_PARSE",
  "IMPORT_EMPTY",
  "IMPORT_TOO_MANY_ROWS",
  "IMPORT_MAPPING",
  "IMPORT_ACK_REQUIRED",
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

/** API eşlemesi için HTTP durumu (sözleşme §c.I). */
export const IMPORT_ERROR_STATUS: Record<ImportErrorCode, number> = {
  IMPORT_TOO_LARGE: 413,
  IMPORT_UNSUPPORTED: 415,
  IMPORT_PARSE: 422,
  IMPORT_EMPTY: 422,
  IMPORT_TOO_MANY_ROWS: 422,
  IMPORT_MAPPING: 400,
  IMPORT_ACK_REQUIRED: 400,
};

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Biçim tespiti: uzantı VE içerik birlikte. `.xlsx` yalnızca zip imzasıyla (`PK\x03\x04`) kabul edilir; `.csv` zip
 * imzasıyla gelirse reddedilir (yeniden adlandırılmış dosya). Desteklenmeyen durumda null.
 */
export function detectImportFormat(filename: string, head: Uint8Array): ImportFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  const isZip = head.length >= 4 && ZIP_MAGIC.every((b, i) => head[i] === b);
  if (ext === "xlsx") return isZip ? "xlsx" : null;
  if (ext === "csv") return isZip ? null : "csv";
  return null;
}
