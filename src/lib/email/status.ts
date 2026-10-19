import type { EmailKind, EmailSourceType, EmailStatus, VerifyStatus } from "@/lib/db/schema";

export interface EmailLike {
  kind: EmailKind;
  verifyStatus: VerifyStatus;
}

/**
 * Bir lead'in e-posta durumu özeti (SRS 4.5 `email_status`). Sıra:
 *  doğrulanmış kişisel adres → `found_verified`; doğrulanmış genel adres → `generic`;
 *  doğrulanmamış (geçersiz olmayan) adres → `found_unverified`; hepsi geçersiz → `invalid`;
 *  hiç adres yok → tarama bittiyse `not_found`, bitmediyse null.
 */
export function computeEmailStatus(emails: EmailLike[], scanned: boolean): EmailStatus | null {
  if (emails.some((e) => e.verifyStatus === "verified" && e.kind === "personal"))
    return "found_verified";
  if (emails.some((e) => e.verifyStatus === "verified" && e.kind === "generic")) return "generic";
  if (emails.some((e) => e.verifyStatus !== "invalid")) return "found_unverified";
  if (emails.length > 0) return "invalid";
  return scanned ? "not_found" : null;
}

export interface RankableEmail extends EmailLike {
  id: number;
  siteMatch: boolean;
  sourceType: EmailSourceType;
  foundAt: number;
  primaryPinned: boolean;
}

const VERIFY_RANK: Record<VerifyStatus, number> = { verified: 0, unverified: 1, invalid: 3 };
const KIND_RANK: Record<EmailKind, number> = { generic: 0, personal: 1, consumer: 2 };
const SOURCE_RANK: Record<EmailSourceType, number> = {
  manual: 0,
  mailto: 1,
  jsonld: 2,
  cfemail: 3,
  text: 4,
  obfuscated: 5,
  external: 6,
};

/**
 * Birincil adres seçimi. Kullanıcının sabitlediği (geçersiz olmayan) adres her zaman kazanır. Otomatik sıralama:
 * siteyle aynı alan adı > doğrulama durumu > tür (genel rol adresi, kişiye ait adrese tercih edilir; çünkü kişisel veri
 * taşımaz ve ülke politikalarında daha güvenlidir) > kaynak türü > bulunma sırası. Geçersiz adresler seçilmez.
 */
export function pickPrimary<T extends RankableEmail>(emails: T[]): T | null {
  const usable = emails.filter((e) => e.verifyStatus !== "invalid");
  const pinned = usable.find((e) => e.primaryPinned);
  if (pinned) return pinned;
  const sorted = [...usable].sort(
    (a, b) =>
      Number(b.siteMatch) - Number(a.siteMatch) ||
      VERIFY_RANK[a.verifyStatus] - VERIFY_RANK[b.verifyStatus] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType] ||
      a.foundAt - b.foundAt ||
      a.id - b.id,
  );
  return sorted[0] ?? null;
}
