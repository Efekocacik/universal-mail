import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeCsv, parseCsv, parseCsvRecords, sniffDelimiter } from "@/lib/import/csv";
import { buildTable } from "@/lib/import/table";
import { IMPORT_LIMITS, ImportError } from "@/lib/import/types";
import { columnIndex, parseXlsx, resolvePart } from "@/lib/import/xlsx";
import { crc32, readZip } from "@/lib/import/zip";
import { writeXlsx, writeZip } from "./fixtures/import/zip-writer";

/**
 * Paket I (Faz 5): CSV ve XLSX ayrıştırıcıları ile zip okuyucunun sınırları. Tüm veriler yapaydır; XLSX dosyaları
 * testte üretilir (ikili fixture yok).
 */

const enc = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImportError) return e.code;
    throw e;
  }
  return undefined;
};

describe("CSV", () => {
  it("RFC 4180: tırnak, kaçış, tırnak içinde satır sonu ve ayraç", () => {
    const recs = parseCsvRecords('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z', ",");
    expect(recs).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("noktalı virgül, BOM, Türkçe karakterler ve boş satırlar; satır numaraları fiziksel satırdır", () => {
    const file = fs.readFileSync(path.join(__dirname, "fixtures/import/cafes-semicolon.csv"));
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), file, Buffer.from("\n\n")]);
    const t = parseCsv(withBom);
    expect(t.headers[0]).toBe("İşletme Adı");
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]![0]).toBe("Çınar Kahve; Fırın");
    expect(t.rows[0]![6]).toBe("İki satırlı\nnot");
    // Başlık 1. satır; ikinci kayıt iki satırlı notla 2–3. satırları kapsar, üçüncü 4. satırdadır.
    expect(t.rowNumbers).toEqual([2, 4]);
    expect(t.warnings).toEqual([]);
  });

  it("ayraç sezgisi: , ; sekme; tırnak içindeki ayraçlar sayılmaz", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(sniffDelimiter('a,b\n"x;y;z",2')).toBe(",");
    expect(sniffDelimiter("tek sütun\nsatır")).toBe(",");
  });

  it("CR satır sonları ve sondaki satır sonu olmadan son kayıt", () => {
    expect(parseCsvRecords("a,b\r1,2\r3,4", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("geçersiz UTF-8 → Windows-1252 ile okunur ve uyarılır", () => {
    const bytes = Uint8Array.from([...enc("ad,şehir\n"), 0x43, 0x61, 0x66, 0xe9, 0x2c, 0x50, 0x0a]);
    const d = decodeCsv(bytes);
    expect(d.fallback).toBe(true);
    const t = parseCsv(bytes);
    expect(t.rows[0]![0]).toBe("Café");
    expect(t.warnings).toContain("encoding_fallback");
  });

  it("kapanmamış tırnak ve ikili veri IMPORT_PARSE", () => {
    expect(code(() => parseCsv(enc('a,b\n"open,1')))).toBe("IMPORT_PARSE");
    expect(code(() => parseCsv(Uint8Array.from([0x61, 0x00, 0x62, 0x0a, 0x31])))).toBe(
      "IMPORT_PARSE",
    );
  });

  it("boş dosya / yalnız başlık IMPORT_EMPTY", () => {
    expect(code(() => parseCsv(enc("")))).toBe("IMPORT_EMPTY");
    expect(code(() => parseCsv(enc("ad,şehir\n\n\n")))).toBe("IMPORT_EMPTY");
  });

  it("5000 satır geçer, 5001 IMPORT_TOO_MANY_ROWS", () => {
    const body = (n: number) => `ad\n${Array.from({ length: n }, (_, i) => `K${i}`).join("\n")}`;
    expect(parseCsv(enc(body(IMPORT_LIMITS.maxRows))).rows).toHaveLength(IMPORT_LIMITS.maxRows);
    expect(code(() => parseCsv(enc(body(IMPORT_LIMITS.maxRows + 1))))).toBe("IMPORT_TOO_MANY_ROWS");
  });
});

describe("tablo kuralları", () => {
  it("sütun/hücre kesme, fazla hücre ve yinelenen başlık uyarıları; sondaki boş başlıklar atılır", () => {
    const wide = Array.from({ length: IMPORT_LIMITS.maxColumns + 5 }, (_, i) => `c${i}`);
    const t1 = buildTable([wide, wide]);
    expect(t1.headers).toHaveLength(IMPORT_LIMITS.maxColumns);
    expect(t1.warnings).toContain("columns_truncated");

    const t2 = buildTable([
      ["Ad", "ad", "", ""],
      ["x".repeat(IMPORT_LIMITS.maxCellChars + 10), "b"],
      ["k", "l", "fazla"],
    ]);
    expect(t2.headers).toEqual(["Ad", "ad"]);
    expect(t2.rows[0]![0]).toHaveLength(IMPORT_LIMITS.maxCellChars);
    expect(t2.warnings).toEqual(
      expect.arrayContaining(["duplicate_headers", "cells_truncated", "extra_cells"]),
    );
  });
});

describe("zip okuyucu", () => {
  it("saklı (0) ve deflate (8) girdileri CRC denetimiyle açar", () => {
    const z = readZip(
      writeZip([
        { name: "a.txt", data: "merhaba", method: 0 },
        { name: "b.txt", data: "dünya ".repeat(50), method: 8 },
      ]),
    );
    expect(z.read("a.txt")!.toString()).toBe("merhaba");
    expect(z.read("b.txt")!.toString()).toBe("dünya ".repeat(50));
    expect(z.read("yok.txt")).toBeNull();
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
  });

  it.each([
    ["şifreli", { flags: 0x801 }],
    ["desteklenmeyen yöntem", { method: 12 }],
    ["zip64 boyutu", { uncompressedSize: 0xffffffff }],
  ])("%s girdi IMPORT_PARSE", (_l, override) => {
    expect(code(() => readZip(writeZip([{ name: "x", data: "abc", override }])))).toBe(
      "IMPORT_PARSE",
    );
  });

  it("zip64 bulucusu, bozuk CRC, yalan boyut, sınır dışı ofset ve imzasız dosya reddedilir", () => {
    expect(code(() => readZip(writeZip([{ name: "x", data: "a" }], { zip64Locator: true })))).toBe(
      "IMPORT_PARSE",
    );
    const badCrc = readZip(writeZip([{ name: "x", data: "abc", override: { crc: 1 } }]));
    expect(code(() => badCrc.read("x"))).toBe("IMPORT_PARSE");
    const lie = readZip(
      writeZip([{ name: "x", data: "a".repeat(5000), override: { uncompressedSize: 10 } }]),
    );
    expect(code(() => lie.read("x"))).toBe("IMPORT_PARSE");
    const far = readZip(writeZip([{ name: "x", data: "abc", override: { localOffset: 9999 } }]));
    expect(code(() => far.read("x"))).toBe("IMPORT_PARSE");
    expect(code(() => readZip(enc("bu bir zip değil, yalnızca metin dosyası")))).toBe(
      "IMPORT_PARSE",
    );
    expect(code(() => readZip(enc("kısa")))).toBe("IMPORT_PARSE");
  });

  it("girdi sayısı, toplam boyut ve sıkıştırma oranı sınırları (zip bombası)", () => {
    const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: "x" })));
    expect(code(() => readZip(many, { maxEntries: 4, maxTotalBytes: 1e9, maxRatio: 200 }))).toBe(
      "IMPORT_PARSE",
    );
    const big = writeZip([{ name: "a", data: "y".repeat(2000), method: 0 }]);
    expect(code(() => readZip(big, { maxEntries: 10, maxTotalBytes: 1000, maxRatio: 200 }))).toBe(
      "IMPORT_PARSE",
    );
    // 1 MB sıfır ~1 KB'a sıkışır (oran ~1000): varsayılan 200 oranında reddedilir.
    const bomb = writeZip([{ name: "xl/worksheets/sheet1.xml", data: new Uint8Array(1 << 20) }]);
    expect(deflateRawSync(new Uint8Array(1 << 20)).length).toBeLessThan((1 << 20) / 200);
    expect(code(() => readZip(bomb))).toBe("IMPORT_PARSE");
  });

  it("yinelenen girdi adı reddedilir", () => {
    expect(
      code(() =>
        readZip(
          writeZip([
            { name: "x", data: "1" },
            { name: "x", data: "2" },
          ]),
        ),
      ),
    ).toBe("IMPORT_PARSE");
  });
});

describe("XLSX", () => {
  it("paylaşılan metinler, sayı ve mantıksal hücreler; ilk sayfa ilişki üzerinden", () => {
    const x = writeXlsx(
      [
        ["İşletme", "Şehir", "Telefon", "Açık"],
        ["Güneş Kafe", "Bursa", 2240000000, true],
        ["Ay Pub", null, 5, false],
      ],
      { secondSheet: true },
    );
    const t = parseXlsx(x);
    expect(t.headers).toEqual(["İşletme", "Şehir", "Telefon", "Açık"]);
    expect(t.rows).toEqual([
      ["Güneş Kafe", "Bursa", "2240000000", "TRUE"],
      ["Ay Pub", "", "5", "FALSE"],
    ]);
    expect(t.rowNumbers).toEqual([2, 3]);
    expect(JSON.stringify(t)).not.toContain("DECOY");
  });

  it("satır içi metin ve mutlak hedef yolu", () => {
    const t = parseXlsx(
      writeXlsx([["ad"], ["Çiçek & Co"]], { inline: true, sheetTarget: "/xl/worksheets/s.xml" }),
    );
    expect(t.rows[0]![0]).toBe("Çiçek & Co");
  });

  it("seyrek sütunlar, öneki olan öğeler ve hata hücreleri", () => {
    const sheet = `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="str"><x:v>ad</x:v></x:c><x:c r="C1" t="str"><x:v>şehir</x:v></x:c></x:row><x:row r="3"><x:c r="A3" t="str"><x:v>Kuzey</x:v></x:c><x:c r="B3" t="e"><x:v>#N/A</x:v></x:c><x:c r="C3" t="str"><x:v>Rize</x:v></x:c><x:c r="XFD3" t="str"><x:v>uç</x:v></x:c></x:row></x:sheetData></x:worksheet>`;
    const z = writeZip([
      {
        name: "xl/workbook.xml",
        data: `<workbook xmlns:r="r"><sheets><sheet r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
    ]);
    const t = parseXlsx(z);
    expect(t.headers).toEqual(["ad", "", "şehir"]);
    expect(t.rows).toEqual([["Kuzey", "", "Rize"]]);
    expect(t.rowNumbers).toEqual([3]);
  });

  it("çalışma kitabı/sayfa yoksa IMPORT_PARSE; çok satır IMPORT_TOO_MANY_ROWS", () => {
    expect(code(() => parseXlsx(writeZip([{ name: "a.txt", data: "x" }])))).toBe("IMPORT_PARSE");
    expect(
      code(() =>
        parseXlsx(
          writeZip([{ name: "xl/workbook.xml", data: `<workbook><sheets></sheets></workbook>` }]),
        ),
      ),
    ).toBe("IMPORT_PARSE");
    const rows = [
      ["ad"],
      ...Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => [`K${i}`]),
    ];
    expect(code(() => parseXlsx(writeXlsx(rows, { inline: true })))).toBe("IMPORT_TOO_MANY_ROWS");
  });

  it("yardımcılar: sütun harfi ve parça yolu", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA10")).toBe(26);
    expect(columnIndex("1A")).toBe(-1);
    expect(resolvePart("xl/workbook.xml", "../docProps/x.xml")).toBe("docProps/x.xml");
    expect(resolvePart("xl/workbook.xml", "./worksheets/s.xml")).toBe("xl/worksheets/s.xml");
    expect(resolvePart("", "xl/workbook.xml")).toBe("xl/workbook.xml");
  });
});
