import * as cheerio from "cheerio";
import { buildTable } from "./table";
import { IMPORT_LIMITS, ImportError, type ImportParser, type ParsedTable } from "./types";
import { readZip, type ZipArchive } from "./zip";

/**
 * XLSX ayrıştırıcı (yeni bağımlılık yok): zip (bkz. zip.ts) → `_rels/.rels` → çalışma kitabı → İLK sayfa (kitap
 * ilişkileri üzerinden) → paylaşılan metinler + sayfa XML'i `cheerio` XML kipiyle. Hücre türleri: `s` (paylaşılan
 * metin), `inlineStr`, `str` (formül sonucu), `n` / türsüz (sayı, ham metin olarak; tarih biçimi çözülmez), `b`
 * (TRUE/FALSE), `e` (hata → boş). Sütun harfleri dizine çevrilir; seyrek satırlarda boş hücreler "" olur.
 */

const fail = (why: string): never => {
  throw new ImportError("IMPORT_PARSE", `XLSX okunamadı: ${why}.`);
};

/** Öğe adlarındaki ad alanı önekini atar (`<x:row>` → `<row>`); öznitelik önekleri (`r:id`) korunur. */
function stripElementPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, "<$1");
}

function loadXml(zip: ZipArchive, name: string): cheerio.CheerioAPI | null {
  const buf = zip.read(name);
  if (!buf) return null;
  return cheerio.load(stripElementPrefixes(buf.toString("utf8")), { xml: true });
}

/** `xl/workbook.xml` ile göreli hedefi birleştirir (`worksheets/sheet1.xml`, `../x`, `/xl/...`). */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function relsPath(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
}

/** İlişki kimliği → hedef parça ve tür eki (ör. `.../sharedStrings`). */
function readRels(zip: ZipArchive, part: string): { id: string; type: string; target: string }[] {
  const $ = loadXml(zip, relsPath(part));
  if (!$) return [];
  return $("Relationship")
    .toArray()
    .map((el) => ({
      id: $(el).attr("Id") ?? "",
      type: $(el).attr("Type") ?? "",
      target: resolvePart(part, $(el).attr("Target") ?? ""),
    }));
}

/** `A` → 0, `Z` → 25, `AA` → 26. Geçersizse -1. */
export function columnIndex(ref: string): number {
  const m = /^([A-Z]{1,3})\d*$/i.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Zengin metin dahil bir `<si>`/`<is>` öğesinin metni; fonetik okumalar (`rPh`) hariç. */
function richText($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0]): string {
  return $(el)
    .find("t")
    .toArray()
    .filter((t) => $(t).parents("rPh").length === 0)
    .map((t) => $(t).text())
    .join("");
}

export function parseXlsx(bytes: Uint8Array): ParsedTable {
  const zip = readZip(bytes);
  const root = readRels(zip, "");
  const workbookPart =
    root.find((r) => r.type.endsWith("/officeDocument"))?.target ?? "xl/workbook.xml";
  const wb = loadXml(zip, workbookPart) ?? fail("çalışma kitabı yok");
  const firstSheet = wb("sheets > sheet").first();
  if (firstSheet.length === 0) fail("sayfa yok");
  const rid = firstSheet.attr("r:id") ?? "";
  const rels = readRels(zip, workbookPart);
  const sheetPart = rels.find((r) => r.id === rid)?.target ?? fail("sayfa ilişkisi yok");

  const sstPart =
    rels.find((r) => r.type.endsWith("/sharedStrings"))?.target ??
    resolvePart(workbookPart, "sharedStrings.xml");
  const sst$ = loadXml(zip, sstPart);
  const shared = sst$
    ? sst$("sst > si")
        .toArray()
        .map((si) => richText(sst$, si))
    : [];

  const $ = loadXml(zip, sheetPart) ?? fail("sayfa dosyası yok");
  const records: string[][] = [];
  const numbers: number[] = [];
  let nonEmpty = 0;
  let nextRow = 1;
  for (const rowEl of $("sheetData > row").toArray()) {
    const rAttr = Number($(rowEl).attr("r"));
    const rowNo = Number.isInteger(rAttr) && rAttr >= nextRow ? rAttr : nextRow;
    nextRow = rowNo + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of $(rowEl).children("c").toArray()) {
      const ref = $(c).attr("r");
      const idx = ref ? columnIndex(ref) : nextCol;
      const col = idx >= 0 ? idx : nextCol;
      nextCol = col + 1;
      if (col >= IMPORT_LIMITS.maxColumns + 1) continue; // buildTable uyarıyı verir
      const type = $(c).attr("t") ?? "n";
      const v = $(c).children("v").first().text();
      let value: string;
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = richText($, $(c).children("is").first()[0]);
      else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else if (type === "e") value = "";
      else value = v;
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    if (cells.some((x) => x.trim() !== "")) {
      nonEmpty++;
      if (nonEmpty > IMPORT_LIMITS.maxRows + 1)
        throw new ImportError("IMPORT_TOO_MANY_ROWS", `En çok ${IMPORT_LIMITS.maxRows} satır.`);
    }
    records.push(cells);
    numbers.push(rowNo);
  }
  return buildTable(records, [], numbers);
}

export const xlsxParser: ImportParser = { format: "xlsx", parse: parseXlsx };
