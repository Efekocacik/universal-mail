import type { ImportOptions } from "@/lib/client/imports";
import { t, type TrKey } from "@/lib/i18n";

/**
 * İçe aktarma ekranının saf kuralları (sınanır). Sunucu aynı kuralları yeniden denetler; buradaki amaç kullanıcıya
 * düğmeye basmadan önce neyin eksik olduğunu söylemektir.
 */

export const FIELD_ORDER = [
  "name",
  "country",
  "city",
  "website",
  "email",
  "category",
  "notes",
] as const;
export type FieldName = (typeof FIELD_ORDER)[number];
export type UiMapping = ImportOptions["mapping"];

const MAX_BYTES = 5 * 1024 * 1024;

/** Gönderilmeden önce açıkça yanlış dosya: büyük veya desteklenmeyen uzantı (sunucu da denetler). */
export function fileProblem(file: { name: string; size: number }): TrKey | null {
  if (file.size > MAX_BYTES) return "apiError.IMPORT_TOO_LARGE";
  if (!/\.(csv|xlsx)$/i.test(file.name.trim())) return "apiError.IMPORT_UNSUPPORTED";
  if (file.size === 0) return "apiError.IMPORT_EMPTY";
  return null;
}

/** Birden çok alana seçilmiş sütunlar. */
export function takenTwice(mapping: UiMapping): Set<number> {
  const seen = new Set<number>();
  const twice = new Set<number>();
  for (const f of FIELD_ORDER) {
    const i = mapping[f];
    if (i === null) continue;
    if (seen.has(i)) twice.add(i);
    seen.add(i);
  }
  return twice;
}

/** Eşleme + varsayılan ülke + kaynak + onay: içe aktarmayı engelleyen eksikler (sırasıyla gösterilir). */
export function blockers(o: ImportOptions, forCheck = false): TrKey[] {
  const out: TrKey[] = [];
  if (o.mapping.name === null) out.push("imports.missing.name");
  if (o.mapping.country === null && !o.defaultCountry) out.push("imports.missing.country");
  if (takenTwice(o.mapping).size > 0) out.push("imports.missing.taken");
  if (forCheck) return out;
  if (o.sourceNote.trim().length < 3) out.push("imports.missing.note");
  if (!o.usageAck) out.push("imports.missing.ack");
  return out;
}

/** Sütun seçeneği etiketi: başlık, boşsa "Sütun N". */
export function columnLabel(headers: readonly string[], i: number): string {
  const h = headers[i]?.trim();
  return h ? h : t("imports.map.column", { n: i + 1 });
}

/** Sütun dizini → o sütuna eşlenen alan (önizleme tablosu başlığında gösterilir). */
export function fieldsByColumn(mapping: UiMapping): Map<number, FieldName> {
  const m = new Map<number, FieldName>();
  for (const f of FIELD_ORDER) {
    const i = mapping[f];
    if (i !== null && !m.has(i)) m.set(i, f);
  }
  return m;
}
