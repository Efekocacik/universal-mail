import { buildTable } from "./table";
import {
  IMPORT_LIMITS,
  ImportError,
  type ImportParser,
  type ImportWarning,
  type ParsedTable,
} from "./types";

/**
 * CSV ayrıştırıcı (yeni bağımlılık yok). RFC 4180: tırnaklı alan, alan içinde `""` kaçışı, tırnak içinde satır sonu;
 * CRLF, LF ve tek CR satır sonu. UTF-8 BOM atılır. Ayraç ilk 5 satırdan sezilir (`,` `;` sekme): Türkçe/Avrupa
 * Excel'i `;` ile kaydeder. Geçersiz UTF-8 baytı varsa Windows-1252 ile yeniden okunur (eski Excel "CSV" çıktısı).
 */

export type CsvDelimiter = "," | ";" | "\t";
const DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

/** Baytları metne çevirir: önce katı UTF-8 (BOM atılır), olmazsa Windows-1252. */
export function decodeCsv(bytes: Uint8Array): { text: string; fallback: boolean } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return { text, fallback: false };
  } catch {
    // Bozuk UTF-8 ama BOM'lu dosya: 1252 okumasında BOM "ï»¿" olarak görünür; atılır.
    const text = new TextDecoder("windows-1252").decode(bytes).replace(/^\u00ef\u00bb\u00bf/, "");
    return { text, fallback: true };
  }
}

/**
 * İlk `max` mantıksal satırda (tırnak içindeki satır sonları satır bitirmez) her adayın tırnak dışı sayısı.
 * Boş satırlar atlanır.
 */
function delimiterCounts(text: string, max: number): Record<CsvDelimiter, number>[] {
  const lines: Record<CsvDelimiter, number>[] = [];
  let cur = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let blank = true;
  for (let i = 0; i < text.length && lines.length < max; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (!blank) lines.push(cur);
      cur = { ",": 0, ";": 0, "\t": 0 };
      blank = true;
      continue;
    } else if (!quoted && (ch === "," || ch === ";" || ch === "\t")) cur[ch]++;
    if (ch.trim() !== "") blank = false;
  }
  if (!blank && lines.length < max) lines.push(cur);
  return lines;
}

/**
 * Ayraç sezgisi: ilk 5 boş olmayan (mantıksal) satırda her adayın sayısına bakılır. Tüm satırlarda bulunan (en küçük
 * sayısı > 0) adaylar arasında en küçük sayısı en büyük olan kazanır; eşitlikte toplam sayı. Hiçbiri yoksa `,`.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const lines = delimiterCounts(text, 5);
  let best: CsvDelimiter = ",";
  let bestMin = 0;
  let bestTotal = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => l[d]);
    const min = counts.length ? Math.min(...counts) : 0;
    const total = counts.reduce((a, b) => a + b, 0);
    if (min > bestMin || (min === bestMin && min > 0 && total > bestTotal)) {
      best = d;
      bestMin = min;
      bestTotal = total;
    }
  }
  return best;
}

/**
 * Boş olmayan kayıtlara böler (tümüyle boş kayıtlar atlanır; satır numaraları fiziksel satırı korur). Kapanmamış tırnak
 * `IMPORT_PARSE`. Kayıt sayısı başlık + `maxRows`'u aşınca okuma durur ve `IMPORT_TOO_MANY_ROWS` atılır (büyük dosya
 * bellekte tümüyle kayda çevrilmez).
 */
export function parseCsvRecords(
  text: string,
  delimiter: CsvDelimiter,
  maxRecords = IMPORT_LIMITS.maxRows + 1,
  /** Doldurulursa her kaydın başladığı fiziksel satır (1'den; tırnak içi satır sonları sayılır). */
  lineNumbers?: number[],
): string[][] {
  const records: string[][] = [];
  let nonEmpty = 0;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  let line = 1;
  let recordLine = 1;
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Tümüyle boş kayıtlar saklanmaz (yalnızca satır sayacı ilerler): yalnızca satır sonlarından oluşan 5 MB'lık bir
    // dosya milyonlarca boş kayıt ve satır numarası üretip belleği şişirmesin.
    if (row.some((c) => c.trim() !== "")) {
      nonEmpty++;
      if (nonEmpty > maxRecords)
        throw new ImportError("IMPORT_TOO_MANY_ROWS", `En çok ${IMPORT_LIMITS.maxRows} satır.`);
      records.push(row);
      lineNumbers?.push(recordLine);
    }
    row = [];
    recordLine = line;
  };
  for (i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      // Alan başında tırnak (öncesinde yalnızca boşluk): tırnaklı alan.
      field = "";
      quoted = true;
    } else if (ch === delimiter) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRow();
    } else field += ch;
  }
  if (quoted) throw new ImportError("IMPORT_PARSE", "Kapanmamış tırnak.");
  if (field !== "" || row.length > 0) endRow();
  return records;
}

export function parseCsv(bytes: Uint8Array): ParsedTable {
  const { text, fallback } = decodeCsv(bytes);
  if (text.includes("\u0000"))
    throw new ImportError("IMPORT_PARSE", "Dosya metin değil (ikili veri).");
  const warnings: ImportWarning[] = fallback ? ["encoding_fallback"] : [];
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines: number[] = [];
  const records = parseCsvRecords(body, sniffDelimiter(body), undefined, lines);
  return buildTable(records, warnings, lines);
}

export const csvParser: ImportParser = { format: "csv", parse: parseCsv };
