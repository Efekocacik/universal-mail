import type { BadgeProps } from "@/components/ui/badge";
import type {
  CountryPolicyView,
  PolicyMode,
  SuppressionListItem,
  SuppressionReason,
} from "@/lib/client/compliance";
import { countryLabel } from "@/lib/client/format";
import { t, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Uyum ekranlarının saf mantığı (DOM'suz; node testleriyle doğrulanır). Sunucu kurallarının yerine GEÇMEZ:
 * arayüz yalnızca daha sıkı modları sunar ve korumalı nedenler için "Kaldır" göstermez; asıl denetim API'dedir.
 */

export const POLICY_MODES: readonly PolicyMode[] = ["allowed", "generic_only", "blocked"];
const STRICTNESS: Record<PolicyMode, number> = { allowed: 0, generic_only: 1, blocked: 2 };

/** Verilen moddan daha kısıtlayıcı modlar (en yakınından başlayarak). Gevşetme asla sunulmaz. */
export function stricterModes(mode: PolicyMode): PolicyMode[] {
  return POLICY_MODES.filter((m) => STRICTNESS[m] > STRICTNESS[mode]);
}

export const MODE_VARIANT: Record<PolicyMode, BadgeProps["variant"]> = {
  allowed: "high",
  generic_only: "warning",
  blocked: "danger",
};

function has(key: string): key is TrKey {
  return Object.prototype.hasOwnProperty.call(tr, key);
}

function lookup(prefix: string, code: string): string {
  const key = `${prefix}.${code}`;
  return has(key) ? t(key) : code;
}

export const modeLabel = (m: string) => lookup("policyMode", m);
export const reasonName = (r: string) => lookup("supReason", r);
export const sourceName = (s: string) => lookup("supSource", s);
export const csvErrorName = (e: string) => lookup("csvError", e);

/** Ülkeleri ada göre sıralar ve (varsa) arama metnine göre süzer. */
export function filterPolicies(rows: readonly CountryPolicyView[], q: string): CountryPolicyView[] {
  const needle = q.trim().toLocaleLowerCase("tr");
  return [...rows]
    .filter(
      (r) =>
        !needle ||
        countryLabel(r.countryCode).toLocaleLowerCase("tr").includes(needle) ||
        r.countryCode.toLowerCase().includes(needle),
    )
    .sort((a, b) => countryLabel(a.countryCode).localeCompare(countryLabel(b.countryCode), "tr"));
}

/** Liste satırının görünen metni. Yanıltıcı adres ÜRETİLMEZ: maskeli görünüm yoksa açıklama gösterilir. */
export function displayText(d: SuppressionListItem["display"]): string {
  switch (d.kind) {
    case "masked":
      return d.text ?? t("supDisplay.unavailable");
    case "domain":
      return d.text ?? t("supDisplay.unavailable");
    case "erased":
      return t("supDisplay.erased");
    default:
      return t("supDisplay.unavailable");
  }
}

/** Kalıcı (geri alınamayan) nedenler: eklenmeden önce kullanıcıya açıkça söylenir. */
export const IRREVERSIBLE_REASONS: ReadonlySet<SuppressionReason> = new Set([
  "unsubscribe",
  "complaint",
  "erasure",
]);

export const MANUAL_REASONS = ["manual", "negative_reply", "unsubscribe", "complaint"] as const;
export type ManualReason = (typeof MANUAL_REASONS)[number];

export const LIFT_MIN_CHARS = 10;
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

export function liftJustificationOk(text: string): boolean {
  return text.trim().length >= LIFT_MIN_CHARS;
}

export function csvFileProblem(file: { size: number }): "too_large" | "empty" | null {
  if (file.size === 0) return "empty";
  if (file.size > CSV_MAX_BYTES) return "too_large";
  return null;
}
