import { getLocale, hasTranslation, t, type Locale, type TrKey } from "@/lib/i18n";

/**
 * Tarama duraklatma nedeni → etkin dilde kullanıcı metni (saf; test edilir). Sunucu `pause_reason`'u Türkçe yazar
 * (sayılarla en ayrıntılı metin); kararlı makine kodu `pause_code`'dur (`src/lib/scan/pause-codes.ts`).
 *   - Türkçe: sunucu metni, yoksa `scans.pause.<KOD>`.
 *   - İngilizce: `scans.pause.<KOD>`; kod bilinmiyorsa ya da yoksa (eski kayıt) genel `scans.pause.unknown`. Türkçe
 *     sunucu metni İngilizce kullanıcıya gösterilmez.
 * Bütçe nedeniyle duran taramada (`budget_stopped`) kod yoksa BUDGET_BLOCKED sayılır. Neden yoksa null.
 */
export function pauseReasonText(
  scan: { status: string; pauseCode?: string | null; pauseReason: string | null },
  locale: Locale = getLocale(),
): string | null {
  const code = scan.pauseCode ?? (scan.status === "budget_stopped" ? "BUDGET_BLOCKED" : null);
  if (!code && !scan.pauseReason) return null;
  const key = code ? (`scans.pause.${code}` as TrKey) : null;
  const known = key !== null && hasTranslation(key, locale);
  if (locale === "tr") return scan.pauseReason ?? (known ? t(key, {}, "tr") : null);
  return known ? t(key, {}, locale) : t("scans.pause.unknown", {}, locale);
}
