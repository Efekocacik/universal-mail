import { fmtNumber } from "@/lib/client/format";
import { t } from "@/lib/i18n";

/** GET /api/google-data (Faz 4 genişletmesi). */
export interface GoogleRetentionSummary {
  cachedPlaces: number;
  storedCoordinates: number;
  maxRetentionDays: number;
  termsReviewedAt: string;
  byPolicy: {
    indefinite: { placeIds: number; dueRefresh: number; gone: number; refreshAfterDays: number };
    ttl: { coordinates: number; maxDays: number };
    session: { cachedPlaces: number; maxDays: number };
    derived: { flaggedPlaces: number; maxDays: number | null; legalReview: "pending" };
  };
  policy: {
    field: string;
    class: "indefinite" | "ttl" | "session" | "derived";
    /** null = ayarla silinmez (süresiz) veya sınırsız. */
    maxDays: number | null;
    termsRef: string;
    /** Türetilmiş ama silinmeyen alanın gerekçesi (`prevents_reappearing` | `recomputed_each_scan` | `own_dataset`). */
    keptBecause?: string | null;
  }[];
}

/** Türetilmiş bayraklar için sunulan seçenekler (gün; `null` = süresiz). Ayar şeması 30–3650 kabul eder. */
export const DERIVED_DAY_OPTIONS: readonly (number | null)[] = [null, 90, 180, 365, 730];

export interface RetentionRow {
  key: "indefinite" | "ttl" | "session" | "derived";
  label: string;
  count: string;
  rule: string;
}

/** Kartın satırları (saf; testte doğrulanır). */
export function retentionRows(s: GoogleRetentionSummary): RetentionRow[] {
  const p = s.byPolicy;
  return [
    {
      key: "indefinite",
      label: t("retention.row.ids"),
      count: fmtNumber(p.indefinite.placeIds),
      rule: t("retention.rule.ids", { days: p.indefinite.refreshAfterDays }),
    },
    {
      key: "ttl",
      label: t("retention.row.coords"),
      count: fmtNumber(p.ttl.coordinates),
      rule: t("retention.rule.days", { days: p.ttl.maxDays }),
    },
    {
      key: "session",
      label: t("retention.row.session"),
      count: fmtNumber(p.session.cachedPlaces),
      rule: t("retention.rule.session", { days: p.session.maxDays }),
    },
    {
      key: "derived",
      label: t("retention.row.derived"),
      count: fmtNumber(p.derived.flaggedPlaces),
      rule:
        p.derived.maxDays === null
          ? t("retention.rule.derived.forever")
          : t("retention.rule.days", { days: p.derived.maxDays }),
    },
  ];
}
