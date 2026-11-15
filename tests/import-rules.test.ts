import { describe, expect, it } from "vitest";
import {
  blockers,
  columnLabel,
  fieldsByColumn,
  fileProblem,
  takenTwice,
} from "@/features/imports/import-model";
import { reportCsv, reportRows } from "@/lib/client/imports";
import { requireUsableMapping, suggestMapping } from "@/lib/import/mapping";
import {
  cleanText,
  normaliseCity,
  normaliseName,
  normaliseWebsite,
  resolveCountry,
  websiteDomain,
  websiteKey,
} from "@/lib/import/normalise";
import {
  categoryResolver,
  classifyRows,
  nameKey,
  parseUpload,
  previewImport,
  sanitiseFilename,
  type ExistingKeys,
} from "@/lib/import/service";
import { IMPORT_LIMITS, ImportError, type ImportMapping } from "@/lib/import/types";
import { writeXlsx } from "./fixtures/import/zip-writer";

/** Paket I (Faz 5): normalleştirme, eşleme önerisi, satır sınıflandırma (kopya/geçersiz) ve ekran kuralları. */

const enc = (s: string) => new TextEncoder().encode(s);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ImportError) return e.code;
    throw e;
  }
  return undefined;
};

describe("normalleştirme", () => {
  it("ad anahtarı: aksan, Türkçe harf, noktalama ve sondaki şirket türü", () => {
    expect(normaliseName("Çınar Kahve Ltd.")).toBe("cinar kahve");
    expect(normaliseName("ÇINAR  KAHVE")).toBe("cinar kahve");
    expect(normaliseName("Işık Fırın A.Ş.")).toBe("isik firin");
    expect(normaliseName("Café Müller GmbH & Co. KG")).toBe("cafe muller");
    expect(normaliseName("Limited Edition Cafe")).toBe("limited edition cafe");
    expect(normaliseName("Ltd")).toBe("ltd");
    expect(normaliseName("Straße 5")).toBe("strasse 5");
  });

  it("ülke: ISO2, adlar (EN/TR/FR/DE), takma adlar; hedef pazar dışı null", () => {
    expect(resolveCountry("gb")).toBe("GB");
    expect(resolveCountry("UK")).toBe("GB");
    expect(resolveCountry("United Kingdom")).toBe("GB");
    expect(resolveCountry("Birleşik Krallık")).toBe("GB");
    expect(resolveCountry("Royaume-Uni")).toBe("GB");
    expect(resolveCountry("Deutschland")).toBe("DE");
    expect(resolveCountry("Türkiye")).toBe("TR");
    expect(resolveCountry("Pays-Bas")).toBe("NL");
    expect(resolveCountry("US")).toBeNull();
    expect(resolveCountry("Narnia")).toBeNull();
    expect(resolveCountry("  ")).toBeNull();
    expect(resolveCountry(undefined)).toBeNull();
  });

  it("web sitesi: https://host/yol; tehlikeli veya yerel adresler reddedilir", () => {
    expect(normaliseWebsite("www.cafe-one.example")).toBe("https://www.cafe-one.example");
    expect(normaliseWebsite("http://Cafe-One.example/Menu/?utm=1#x")).toBe(
      "https://cafe-one.example/Menu",
    );
    expect(normaliseWebsite("//cafe-one.example/")).toBe("https://cafe-one.example");
    for (const bad of [
      "javascript:alert(1)",
      "ftp://cafe.example",
      "http://user:pw@cafe.example",
      "http://cafe.example:8080",
      "http://127.0.0.1",
      "http://localhost/admin",
      "http://[::1]/",
      "not a url",
      "",
      null,
    ])
      expect(normaliseWebsite(bad)).toBeNull();
    expect(websiteDomain("https://shop.cafe-one.example/x")).toBe("cafe-one.example");
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain("::")).toBeNull();
  });

  it("web sitesi kopya anahtarı: olağan sitede alan adı, paylaşımlı platformda sunucu + ayırt edici yol", () => {
    const k = (v: string) => websiteKey(normaliseWebsite(v));
    expect(k("https://shop.cafe-one.example/menu")).toBe("cafe-one.example");
    expect(k("www.facebook.com/KafeA")).toBe("facebook.com/kafea");
    expect(k("https://m.facebook.com/kafea/")).toBe("facebook.com/kafea");
    expect(k("facebook.com/kafeb")).toBe("facebook.com/kafeb");
    expect(k("https://www.facebook.com/pages/Kafe-C/123")).toBe("facebook.com/pages/kafe-c");
    expect(k("instagram.com/kafe.a")).toBe("instagram.com/kafe.a");
    expect(k("https://linktr.ee/kafea")).toBe("linktr.ee/kafea");
    expect(k("https://sites.google.com/view/kafea/home")).toBe("sites.google.com/view/kafea");
    expect(k("https://www.youtube.com/@kafea")).toBe("youtube.com/@kafea");
    expect(k("https://kafea.wixsite.com/home")).toBe("kafea.wixsite.com");
    expect(k("https://kafea.wixsite.com/kafe-sitesi")).toBe("kafea.wixsite.com/kafe-sitesi");
    expect(k("https://kafe-a.business.site")).toBe("kafe-a.business.site");
    // Ayırt edici parça yok: web sitesiyle kopya denetimi yapılmaz.
    expect(k("https://www.facebook.com/")).toBeNull();
    expect(k("https://www.facebook.com/profile.php?id=1")).toBeNull();
    expect(k("https://sites.google.com/")).toBeNull();
    expect(websiteKey(null)).toBeNull();
    expect(websiteKey("::")).toBeNull();
  });

  it("metin temizleme ve şehir anahtarı", () => {
    expect(cleanText("  a\u0000b \n c  ", 10)).toBe("a b c");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("   ", 3)).toBeNull();
    expect(normaliseCity("İzmir")).toBe("izmir");
    expect(normaliseCity(null)).toBe("");
  });
});

describe("eşleme", () => {
  it("TR/EN/FR/DE eş anlamlılarından öneri; bir sütun bir alana", () => {
    expect(
      suggestMapping(["İşletme Adı", "Şehir", "Ülke", "Web Sitesi", "E-posta", "Kategori", "Not"]),
    ).toEqual({ name: 0, city: 1, country: 2, website: 3, email: 4, category: 5, notes: 6 });
    expect(suggestMapping(["Nom", "Ville", "Pays", "Courriel"])).toMatchObject({
      name: 0,
      city: 1,
      country: 2,
      email: 3,
    });
    expect(suggestMapping(["Firmenname", "Stadt", "Land", "Webseite"])).toMatchObject({
      name: 0,
      city: 1,
      country: 2,
      website: 3,
    });
    // Ad başlığı tanınmazsa ilk sütun önerilir; ikinci "city" başlığı yok sayılır.
    expect(suggestMapping(["Foo", "City", "Town"])).toMatchObject({ name: 0, city: 1 });
  });

  it("kullanılamaz eşleme IMPORT_MAPPING", () => {
    const m = {
      name: 0,
      country: null,
      city: null,
      website: null,
      email: null,
      category: null,
      notes: null,
    };
    expect(codeOf(() => requireUsableMapping({ ...m, name: null }, 3, "GB"))).toBe(
      "IMPORT_MAPPING",
    );
    expect(codeOf(() => requireUsableMapping(m, 3, null))).toBe("IMPORT_MAPPING");
    expect(codeOf(() => requireUsableMapping({ ...m, city: 5 }, 3, "GB"))).toBe("IMPORT_MAPPING");
    expect(codeOf(() => requireUsableMapping({ ...m, city: 0 }, 3, "GB"))).toBe("IMPORT_MAPPING");
    expect(codeOf(() => requireUsableMapping({ ...m, country: 1 }, 3, null))).toBeUndefined();
  });
});

const MAP: ImportMapping = {
  name: 0,
  country: 1,
  city: 2,
  website: 3,
  email: 4,
  category: 5,
  notes: 6,
};
const none: ExistingKeys = { domains: new Set(), emails: new Set(), names: new Set() };
const resolveCategory = categoryResolver([
  { key: "cafe", name: "Kafe / kahveci", placeTypes: ["cafe", "coffee_shop"] },
  { key: "pub", name: "Bar / pub" },
]);

describe("satır sınıflandırma", () => {
  it("geçersiz nedenleri sırayla; kopyalar önce mevcut kayıt, sonra dosya içi", () => {
    const rows = [
      ["Alfa Kafe", "GB", "London", "alfa.example", "hello@alfa.example", "Kafe", "not"], // 2: eklenir
      ["", "GB", "", "", "", "", ""], // 3: no_name
      ["Beta", "", "", "", "", "", ""], // 4: no_country (varsayılan yok)
      ["Gama", "Narnia", "", "", "", "", ""], // 5: bad_country
      ["Delta", "GB", "", "ftp://x.example", "", "", ""], // 6: bad_website
      ["Epsilon", "GB", "", "", "not-an-email", "", ""], // 7: bad_email
      ["Alfa Kafe 2", "GB", "", "www.alfa.example", "", "", ""], // 8: in_file (alan adı)
      ["Zeta", "GB", "", "", "HELLO@alfa.example", "", ""], // 9: in_file (e-posta)
      ["ALFA KAFE Ltd", "United Kingdom", "london", "", "", "", ""], // 10: in_file (ad+şehir)
      ["Eta", "GB", "", "eta.example", "", "", ""], // 11: same_website
      ["Theta", "GB", "", "", "x@theta.example", "", ""], // 12: same_email
      ["Iota", "GB", "Leeds", "", "", "pub", ""], // 13: same_name_city
      ["Iota", "GB", "York", "", "a@iota.example; b@iota.example", "bilinmeyen", ""], // 14: eklenir
    ];
    const c = classifyRows(
      { headers: ["a", "b", "c", "d", "e", "f", "g"], rows },
      MAP,
      { defaultCountry: null, categoryKey: "pub", resolveCategory },
      {
        domains: new Set(["eta.example"]),
        emails: new Set(["x@theta.example"]),
        names: new Set([nameKey("iota", "GB", "LEEDS")]),
      },
    );
    expect(c.invalid).toEqual([
      { row: 3, reason: "no_name" },
      { row: 4, reason: "no_country" },
      { row: 5, reason: "bad_country" },
      { row: 6, reason: "bad_website" },
      { row: 7, reason: "bad_email" },
    ]);
    expect(c.duplicates).toEqual([
      { row: 8, reason: "in_file" },
      { row: 9, reason: "in_file" },
      { row: 10, reason: "in_file" },
      { row: 11, reason: "same_website" },
      { row: 12, reason: "same_email" },
      { row: 13, reason: "same_name_city" },
    ]);
    expect(c.candidates.map((x) => x.row)).toEqual([2, 14]);
    expect(c.candidates[0]).toMatchObject({
      displayName: "Alfa Kafe",
      countryCode: "GB",
      city: "London",
      website: "https://alfa.example",
      email: "hello@alfa.example",
      categoryKey: "cafe",
      notes: "not",
    });
    // Tanınmayan kategori → partinin varsayılanı; çoklu adreste ilki.
    expect(c.candidates[1]).toMatchObject({ categoryKey: "pub", email: "a@iota.example" });
  });

  it("kategori: anahtar, ad, ad parçası ve yer türü", () => {
    expect(
      ["cafe", "KAFE", "kahveci", "Kafe / Kahveci", "Coffee shop"].map(resolveCategory),
    ).toEqual(["cafe", "cafe", "cafe", "cafe", "cafe"]);
    expect(resolveCategory("bar")).toBe("pub");
    expect(resolveCategory("otel")).toBeNull();
  });

  it("paylaşımlı platform siteleri (Facebook, Instagram…) farklı işletmeleri kopya saymaz", () => {
    const rows = [
      ["Kafe A", "GB", "London", "facebook.com/kafea", "", "", ""], // 2
      ["Kafe B", "GB", "London", "https://www.facebook.com/kafeb", "", "", ""], // 3
      ["Kafe C", "GB", "London", "https://www.facebook.com/", "", "", ""], // 4: anahtarsız
      ["Kafe D", "GB", "London", "https://www.facebook.com/profile.php?id=9", "", "", ""], // 5
      ["Kafe E", "GB", "London", "https://m.facebook.com/KafeA", "", "", ""], // 6: 2 ile aynı sayfa
      ["Kafe F", "GB", "London", "instagram.com/kafef", "", "", ""], // 7: mevcut Google lead'i ile aynı
      ["Kafe G", "GB", "London", "instagram.com/kafeg", "", "", ""], // 8
    ];
    const c = classifyRows(
      { headers: ["a", "b", "c", "d", "e", "f", "g"], rows },
      MAP,
      { defaultCountry: null, categoryKey: null, resolveCategory },
      // Mevcut kayıtlarda paylaşımlı platform: yalnızca aynı sayfa kopyadır (alan adının tamamı değil).
      { domains: new Set(["instagram.com/kafef"]), emails: new Set(), names: new Set() },
    );
    expect(c.duplicates).toEqual([
      { row: 6, reason: "in_file" },
      { row: 7, reason: "same_website" },
    ]);
    expect(c.candidates.map((x) => x.row)).toEqual([2, 3, 4, 5, 8]);
  });

  it("ülke sütunu yoksa varsayılan ülke; satır numarası tablodan gelir", () => {
    const c = classifyRows(
      { headers: ["ad"], rows: [["Tek"]], rowNumbers: [7] },
      {
        ...MAP,
        country: null,
        city: null,
        website: null,
        email: null,
        category: null,
        notes: null,
      },
      { defaultCountry: "NL", categoryKey: null, resolveCategory },
      none,
    );
    expect(c.candidates[0]).toMatchObject({ row: 7, countryCode: "NL", categoryKey: null });
  });
});

describe("dosya kabulü", () => {
  it("boyut, uzantı+imza ve boş dosya", () => {
    const big = new Uint8Array(IMPORT_LIMITS.maxBytes + 1);
    expect(codeOf(() => parseUpload({ filename: "a.csv", bytes: big }))).toBe("IMPORT_TOO_LARGE");
    expect(codeOf(() => parseUpload({ filename: "a.txt", bytes: enc("a") }))).toBe(
      "IMPORT_UNSUPPORTED",
    );
    expect(codeOf(() => parseUpload({ filename: "a.xlsx", bytes: enc("ad\nx") }))).toBe(
      "IMPORT_UNSUPPORTED",
    );
    expect(codeOf(() => parseUpload({ filename: "a.csv", bytes: new Uint8Array() }))).toBe(
      "IMPORT_EMPTY",
    );
  });

  it("önizleme: CSV ve XLSX aynı biçimde", () => {
    const p = previewImport({ filename: "liste.csv", bytes: enc("Name;City\nA;B\nC;D") });
    expect(p).toMatchObject({
      format: "csv",
      headers: ["Name", "City"],
      sampleRows: [
        ["A", "B"],
        ["C", "D"],
      ],
      totalRows: 2,
      warnings: [],
    });
    expect(p.suggestedMapping).toMatchObject({ name: 0, city: 1 });
    const x = previewImport({ filename: "L.XLSX", bytes: writeXlsx([["Firma"], ["Kuzey"]]) });
    expect(x).toMatchObject({ format: "xlsx", headers: ["Firma"], totalRows: 1 });
  });

  it("dosya adı temizlenir", () => {
    expect(sanitiseFilename("C:\\Users\\x\\liste.csv")).toBe("liste.csv");
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitiseFilename("a\u0000b.csv")).toBe("ab.csv");
    expect(sanitiseFilename("")).toBe("import");
    expect(sanitiseFilename("x".repeat(300))).toHaveLength(200);
  });
});

describe("ekran kuralları", () => {
  const m = {
    name: 0,
    country: null,
    city: 1,
    website: null,
    email: null,
    category: null,
    notes: null,
  };
  it("dosya ön denetimi", () => {
    expect(fileProblem({ name: "a.csv", size: 10 })).toBeNull();
    expect(fileProblem({ name: "A.XLSX", size: 10 })).toBeNull();
    expect(fileProblem({ name: "a.csv", size: 6 * 1024 * 1024 })).toBe("apiError.IMPORT_TOO_LARGE");
    expect(fileProblem({ name: "a.xls", size: 10 })).toBe("apiError.IMPORT_UNSUPPORTED");
    expect(fileProblem({ name: "a.csv", size: 0 })).toBe("apiError.IMPORT_EMPTY");
  });

  it("engeller: kontrol için yalnızca eşleme; içe aktarma için kaynak ve onay da", () => {
    const o = {
      mapping: m,
      defaultCountry: null,
      categoryKey: null,
      sourceNote: "",
      usageAck: false,
    };
    expect(blockers(o, true)).toEqual(["imports.missing.country"]);
    expect(blockers(o)).toEqual([
      "imports.missing.country",
      "imports.missing.note",
      "imports.missing.ack",
    ]);
    expect(
      blockers({
        ...o,
        mapping: { ...m, name: null, country: 1 },
        sourceNote: "fuar",
        usageAck: true,
      }),
    ).toEqual(["imports.missing.name", "imports.missing.taken"]);
    expect(blockers({ ...o, defaultCountry: "GB", sourceNote: "fuar", usageAck: true })).toEqual(
      [],
    );
  });

  it("sütun etiketleri ve eşleme haritası", () => {
    expect(takenTwice({ ...m, country: 1 })).toEqual(new Set([1]));
    expect(columnLabel(["Ad", " "], 1)).toMatch(/2/);
    expect(columnLabel(["Ad"], 0)).toBe("Ad");
    expect([...fieldsByColumn(m)]).toEqual([
      [0, "name"],
      [1, "city"],
    ]);
  });

  it("satır raporu CSV: yalnızca numara/tür/neden, sıralı, BOM ve tırnak kaçışı", () => {
    const rows = reportRows({
      duplicates: [{ row: 5, reason: "in_file" }],
      invalid: [{ row: 3, reason: "no_name" }],
    });
    expect(rows.map((r) => r.row)).toEqual([3, 5]);
    const csv = reportCsv(rows, (r) => [r.kind, `"${r.reason}"`], ["Satır", "Tür", "Neden"]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain('3,"invalid","""no_name"""');
    expect(csv.split("\r\n")).toHaveLength(4);
  });
});
