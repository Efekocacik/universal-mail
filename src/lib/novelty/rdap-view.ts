import { fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";

/** GET /api/settings/novelty/rdap-status */
export interface RdapStatus {
  enabled: boolean;
  demo: boolean;
  bootstrap: { fetchedAt: number; publication: string; tlds: number } | null;
  counts: Record<string, number>;
  due: number;
  lastCheckedAt: number | null;
}

/** Durum satırı (saf; testte doğrulanır). */
export function rdapSummary(s: RdapStatus): string {
  const c = s.counts;
  const known = c.ok ?? 0;
  const waiting = s.due; // sırası gelmiş (yeni eklenenler dahil)
  const failed = (c.error ?? 0) + (c.rate_limited ?? 0);
  const unknown = (c.no_date ?? 0) + (c.not_found ?? 0) + (c.unsupported_tld ?? 0);
  return t("rdap.summary", {
    known: fmtNumber(known),
    waiting: fmtNumber(waiting),
    unknown: fmtNumber(unknown),
    failed: fmtNumber(failed),
  });
}

export const YOUNG_DAYS_MIN = 30;
export const YOUNG_DAYS_MAX = 730;
