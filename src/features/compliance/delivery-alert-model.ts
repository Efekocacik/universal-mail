import { fmtDate, fmtDateTime } from "@/lib/client/format";
import { t, type TrKey } from "@/lib/i18n";
import type { DeliveryAlert } from "@/lib/unsubscribe/delivery-alert";

export type { DeliveryAlert };

/** Çıkış teslimat uyarısı bandının saf mantığı (C14; DOM'suz test edilir). */

const UNHEALTHY_CODES = ["queue_deep", "events_stale", "corrupt_events", "unreachable"] as const;

export function deliveryAlertText(a: DeliveryAlert): string {
  switch (a.kind) {
    case "delivery_unhealthy": {
      const known = (UNHEALTHY_CODES as readonly string[]).includes(a.code);
      const key = `deliveryAlert.unhealthy.${known ? a.code : "other"}` as TrKey;
      return `${t(key)} ${t("deliveryAlert.checkedAt", { at: fmtDateTime(a.checkedAt) })}`;
    }
    case "proof_expiring":
      return t("deliveryAlert.expiring", { days: a.daysLeft, at: fmtDate(a.expiresAt) });
    case "proof_expired":
      return t("deliveryAlert.expired", { at: fmtDate(a.expiredAt) });
  }
}

/** Bant tonu: gönderimi durduran veya talepleri işlenmeyen durum kırmızı, yaklaşan süre sarı. Uyarı yoksa null. */
export function deliveryAlertTone(alerts: DeliveryAlert[]): "warning" | "danger" | null {
  if (alerts.length === 0) return null;
  return alerts.some((a) => a.kind !== "proof_expiring") ? "danger" : "warning";
}
