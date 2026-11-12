import type { CsvImportPreview } from "@/lib/client/suppression-import";
import type { SuppressionReason } from "@/lib/client/compliance";

/**
 * CSV içe aktarma önizlemesinin saf mantığı (C13; DOM'suz test edilir).
 * Geri alınamaz (çıkış, şikâyet) kayıt yazacak bir içe aktarma yalnızca kırmızı onay penceresinden sonra yapılır.
 */

/** İçe aktarma kırmızı onay penceresi gerektirir mi? */
export function importNeedsConfirmation(p: Pick<CsvImportPreview, "irreversible">): boolean {
  return p.irreversible > 0;
}

/** Yazılacak kayıt var mı (eklenecek veya güçlendirilecek)? Yoksa içe aktarma bir şey değiştirmez. */
export function importWritesAnything(p: Pick<CsvImportPreview, "added" | "strengthened">): boolean {
  return p.added + p.strengthened > 0;
}

/** Önizlemedeki neden dağılımı: güçlüden zayıfa sabit sırada, yalnızca sıfırdan büyükler. */
const ORDER: SuppressionReason[] = [
  "complaint",
  "unsubscribe",
  "bounce_hard",
  "negative_reply",
  "manual",
];
export function previewReasons(
  p: Pick<CsvImportPreview, "byReason">,
): { reason: SuppressionReason; n: number }[] {
  return ORDER.map((reason) => ({ reason, n: p.byReason[reason] ?? 0 })).filter((x) => x.n > 0);
}
