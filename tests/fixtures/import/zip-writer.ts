import { deflateRawSync } from "node:zlib";
import { crc32 } from "@/lib/import/zip";

/**
 * Testler için küçük zip yazıcı (ikili fixture depoya girmez). Her girdi için bilerek bozulmuş alanlar verilebilir
 * (CRC, boyut, bayrak, yöntem) ki okuyucunun reddetme yolları sınansın.
 */
export interface ZipInput {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  /** Merkez dizine yazılacak değerleri ezer (bozuk dosya senaryoları). */
  override?: Partial<{
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    flags: number;
    method: number;
    localOffset: number;
  }>;
}

export function writeZip(entries: ZipInput[], opts: { zip64Locator?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, "utf8");
    const o = e.override ?? {};
    const crc = o.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(o.flags ?? 0x800, 6);
    local.writeUInt16LE(o.method ?? method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(o.flags ?? 0x800, 8);
    central.writeUInt16LE(o.method ?? method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE((o.compressedSize ?? body.length) >>> 0, 20);
    central.writeUInt32LE((o.uncompressedSize ?? raw.length) >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((o.localOffset ?? offset) >>> 0, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (opts.zip64Locator) {
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    tail.push(loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, ...tail, eocd]);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colName = (i: number): string => {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/**
 * En küçük geçerli XLSX: paylaşılan metinler (varsayılan) veya satır içi metin; ilk sayfa ilişki üzerinden bulunur.
 * `sheets` birden çoksa yalnızca ilki okunmalıdır (ikinci sayfa "DECOY" içerir).
 */
export function writeXlsx(
  rows: (string | number | boolean | null)[][],
  opts: {
    inline?: boolean;
    secondSheet?: boolean;
    sheetTarget?: string;
    /** Sayfa XML'ini olduğu gibi kullanır (`rows` yok sayılır); sınır senaryoları için. */
    rawSheet?: string;
    /** Sayfa girdisinin sıkıştırma yöntemi (0 = saklı; oran sınırına takılmadan büyük XML). */
    sheetMethod?: 0 | 8;
  } = {},
): Buffer {
  const shared: string[] = [];
  const sIndex = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetXml = (data: typeof rows) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data
      .map(
        (r, ri) =>
          `<row r="${ri + 1}">${r
            .map((v, ci) => {
              if (v === null) return "";
              const ref = `${colName(ci)}${ri + 1}`;
              if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
              if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
              if (opts.inline) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
              return `<c r="${ref}" t="s"><v>${sIndex(v)}</v></c>`;
            })
            .join("")}</row>`,
      )
      .join("")}</sheetData></worksheet>`;
  const target = opts.sheetTarget ?? "worksheets/sheet1.xml";
  const files: ZipInput[] = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Liste" sheetId="1" r:id="rId7"/>${opts.secondSheet ? `<sheet name="Diğer" sheetId="2" r:id="rId8"/>` : ""}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    {
      name: `xl/${target.replace(/^\/xl\//, "")}`,
      data: opts.rawSheet ?? sheetXml(rows),
      method: opts.sheetMethod,
    },
  ];
  if (opts.secondSheet)
    files.push({ name: "xl/worksheets/sheet2.xml", data: sheetXml([["DECOY"], ["DECOY"]]) });
  files.push({
    name: "xl/sharedStrings.xml",
    data: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">${shared
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join("")}</sst>`,
  });
  return writeZip(files);
}
