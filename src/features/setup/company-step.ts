import type { CompanyProfile } from "@/lib/client/types";

/**
 * Kurulum sihirbazı "Firma" adımının saf mantığı (DOM'suz; `tests/setup-wizard-c15.test.ts`).
 *
 * MERSİS ve ticaret sicil numarası İSTEĞE BAĞLIDIR (Aşama 15.1): yalnızca Türkiye'ye yönelik iletilerin alt bilgisine
 * eklenir ve hiçbir gönderimi engellemez. Biçim kuralı sunucudaki `company.profile` şemasıyla
 * (`src/lib/settings/index.ts`, `identifierField`) birebir aynıdır; istemci bu modülü sunucu koduna bağlanmadan
 * kullanabilsin diye kural burada tekrarlanır ve eşitliği testle korunur.
 */

export const TR_IDENTIFIER_MAX = 40;
const TR_IDENTIFIER_RE = /^[\p{L}\p{N} .\-/]*$/u;

export type TrIdentifierKey = "mersisNo" | "tradeRegistryNo";
export const TR_IDENTIFIER_KEYS: readonly TrIdentifierKey[] = ["mersisNo", "tradeRegistryNo"];

/** Boş değer geçerlidir (alan isteğe bağlı); doluysa kırpılmış hâli ≤ 40 karakter ve tek satır, temel noktalama. */
export function isValidTrIdentifier(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v.length <= TR_IDENTIFIER_MAX && TR_IDENTIFIER_RE.test(v);
}

/** Zorunlu alanların en kısa uzunlukları (sunucu şemasıyla aynı). */
export const COMPANY_MIN_LENGTHS = {
  legalName: 2,
  address: 5,
  taxId: 2,
  phone: 5,
  contactName: 2,
} as const;

export function isCompanyStepValid(c: CompanyProfile): boolean {
  for (const [k, min] of Object.entries(COMPANY_MIN_LENGTHS) as [
    keyof typeof COMPANY_MIN_LENGTHS,
    number,
  ][]) {
    if ((c[k] ?? "").trim().length < min) return false;
  }
  return TR_IDENTIFIER_KEYS.every((k) => isValidTrIdentifier(c[k]));
}

/**
 * Ayarlar API'sine gönderilecek profil: boş isteğe bağlı alanlar hiç gönderilmez (`undefined`), tanımlayıcılar
 * kırpılır. Ayarlar sayfasındaki firma formuyla aynı davranış.
 */
export function companyPayload(c: CompanyProfile): CompanyProfile {
  return {
    ...c,
    contactTitle: c.contactTitle || undefined,
    website: c.website || undefined,
    mersisNo: c.mersisNo?.trim() || undefined,
    tradeRegistryNo: c.tradeRegistryNo?.trim() || undefined,
  };
}
