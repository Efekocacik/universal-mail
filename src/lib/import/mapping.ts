import { z } from "zod";
import { normaliseCity } from "./normalise";
import { ImportError, type ImportMapping } from "./types";

/**
 * Sütun eşleme: başlık eş anlamlıları (TR/EN/FR/DE) ile otomatik öneri ve doğrulama. Eşleme, alan → sütun dizinidir
 * (`null` = yok). `name` zorunludur; ülke sütunu yoksa varsayılan ülke gerekir (bkz. `requireUsableMapping`).
 */

export const IMPORT_FIELDS = [
  "name",
  "country",
  "city",
  "website",
  "email",
  "category",
  "notes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Normalleştirilmiş başlık (bkz. `normaliseCity`: küçük harf, aksansız, noktalama → boşluk) → alan. */
const SYNONYMS: Record<ImportField, readonly string[]> = {
  name: [
    "name",
    "business name",
    "company",
    "company name",
    "business",
    "ad",
    "adi",
    "isim",
    "isletme",
    "isletme adi",
    "firma",
    "firma adi",
    "sirket",
    "sirket adi",
    "nom",
    "raison sociale",
    "entreprise",
    "firmenname",
    "unternehmen",
  ],
  country: ["country", "country code", "ulke", "ulke kodu", "pays", "land"],
  city: ["city", "town", "sehir", "il", "ilce", "ville", "stadt", "ort", "locality"],
  website: [
    "website",
    "web site",
    "web",
    "site",
    "url",
    "web sitesi",
    "internet sitesi",
    "site web",
    "webseite",
    "homepage",
  ],
  email: [
    "email",
    "e mail",
    "mail",
    "e posta",
    "eposta",
    "email address",
    "e posta adresi",
    "courriel",
    "adresse e mail",
  ],
  category: [
    "category",
    "type",
    "business type",
    "kategori",
    "tur",
    "sektor",
    "categorie",
    "kategorie",
  ],
  notes: ["notes", "note", "not", "notlar", "aciklama", "remarques", "notizen", "comment"],
};

const LOOKUP = new Map<string, ImportField>(
  IMPORT_FIELDS.flatMap((f) => SYNONYMS[f].map((s) => [s, f] as const)),
);

/** Başlıklardan öneri: her alana ilk eşleşen sütun; bir sütun yalnızca bir alana atanır. Ad bulunamazsa 0. */
export function suggestMapping(headers: readonly string[]): ImportMapping {
  const out: ImportMapping = {
    name: -1,
    country: null,
    city: null,
    website: null,
    email: null,
    category: null,
    notes: null,
  };
  const used = new Set<number>();
  headers.forEach((h, i) => {
    const f = LOOKUP.get(normaliseCity(h));
    if (!f || used.has(i)) return;
    if (f === "name" ? out.name === -1 : out[f] === null) {
      out[f] = i;
      used.add(i);
    }
  });
  if (out.name === -1) out.name = 0;
  return out;
}

const col = z.number().int().min(0).max(1000).nullable();
export const mappingSchema = z
  .object({
    // `null` şemada geçer ki eksik ad sütunu VALIDATION değil IMPORT_MAPPING dönsün.
    name: col,
    country: col,
    city: col,
    website: col,
    email: col,
    category: col,
    notes: col,
  })
  .strict();

export type MappingInput = z.infer<typeof mappingSchema>;

/**
 * Eşlemenin dosyaya uyduğunu denetler: dizinler sütun sayısından küçük olmalı, bir sütun iki alana atanamaz, ülke
 * sütunu yoksa varsayılan ülke verilmelidir. Aksi halde `IMPORT_MAPPING`.
 */
export function requireUsableMapping(
  mapping: MappingInput,
  columns: number,
  defaultCountry: string | null,
): asserts mapping is ImportMapping {
  if (mapping.name === null) throw new ImportError("IMPORT_MAPPING", "İşletme adı sütununu seçin.");
  const used = new Set<number>();
  for (const f of IMPORT_FIELDS) {
    const i = mapping[f];
    if (i === null) continue;
    if (i >= columns)
      throw new ImportError("IMPORT_MAPPING", `"${f}" alanı dosyada olmayan bir sütuna eşlenmiş.`);
    if (used.has(i))
      throw new ImportError("IMPORT_MAPPING", "Bir sütun birden çok alana eşlenemez.");
    used.add(i);
  }
  if (mapping.country === null && !defaultCountry)
    throw new ImportError("IMPORT_MAPPING", "Ülke sütunu seçilmedi; varsayılan ülkeyi belirtin.");
}
