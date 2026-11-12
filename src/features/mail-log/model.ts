import type { TrKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { isArfComplaintCode } from "@/lib/mail/inbound/complaint";

/** Günlük ekranının saf yardımcıları (etiketler, rozet renkleri). */

type Variant = "default" | "success" | "danger" | "warning" | "info" | "outline";

const STATUS_KEYS = [
  "queued",
  "sending",
  "sent",
  "failed",
  "unknown",
  "received",
  "matched",
  "unmatched",
  "ignored",
] as const;

export function statusLabel(status: string): string {
  return (STATUS_KEYS as readonly string[]).includes(status)
    ? t(`mlog.status.${status}` as TrKey)
    : status;
}

export function statusVariant(status: string): Variant {
  switch (status) {
    case "sent":
    case "matched":
      return "success";
    case "failed":
      return "danger";
    case "unknown":
    case "received":
      return "warning";
    default:
      return "outline";
  }
}

export function deliveryLabel(d: string | null): string | null {
  return d === "bounced_hard" || d === "bounced_soft" ? t(`mlog.delivery.${d}` as TrKey) : null;
}

/**
 * ARF şikâyeti: 15.10-2'den beri sınıf sütunu `complaint`; eski satırlarda `other` + işaret (`arf_complaint` veya
 * `arf_complaint:<neden>`). İkisi de "Şikâyet raporu (ARF)" etiketini alır.
 */
export { isArfComplaintCode };

export function classLabel(c: string | null, errorCode?: string | null): string | null {
  if (c === "complaint" || isArfComplaintCode(errorCode)) return t("mlog.class.complaint");
  return c && ["reply", "bounce", "auto_reply", "unsubscribe", "negative", "other"].includes(c)
    ? t(`mlog.class.${c}` as TrKey)
    : null;
}

export function purposeLabel(p: string): string {
  return ["campaign", "test", "inbound"].includes(p) ? t(`mlog.purpose.${p}` as TrKey) : p;
}

/** Bilinmeyen inceleme nedeni makine koduyla gösterilmez; genel bir metne düşer. */
export function reviewReasonLabel(code: string | null): string {
  // ARF şikâyeti: "arf_complaint:<neden>" → "Şikâyet raporu — <neden>"
  if (code && code.startsWith("arf_complaint:")) {
    return t("inbox.reason.arf_complaint", {
      reason: reviewReasonLabel(code.slice("arf_complaint:".length)),
    });
  }
  const known = [
    "reporter_untrusted",
    "recipient_unavailable",
    "arf_other_type",
    "no_attestation",
    "attestation_failed",
    "recipient_mismatch",
    "no_match",
    "match_invalid",
    "negative_needs_review",
    "flood_guard",
    "limits",
    "unclassified",
    "test_message",
  ];
  return code && known.includes(code)
    ? t(`inbox.reason.${code}` as TrKey)
    : t("inbox.reason.unclassified");
}

const DNS_CODES = [
  "spf_ok",
  "spf_softfail",
  "spf_missing",
  "spf_multiple",
  "spf_no_all",
  "spf_allows_all",
  "spf_neutral",
  "spf_too_many_lookups",
  "dmarc_ok",
  "dmarc_no_reports",
  "dmarc_missing",
  "dmarc_multiple",
  "dmarc_monitor_only",
  "dmarc_invalid_policy",
  "dkim_ok",
  "dkim_missing",
  "dkim_revoked",
  "dns_error",
];

export function dnsCodeLabel(code: string): string {
  return DNS_CODES.includes(code) ? t(`health.dns.code.${code}` as TrKey) : code;
}

export function dnsStatusLabel(s: "pass" | "warn" | "fail"): string {
  return t(`health.dns.status.${s}` as TrKey);
}

export function dnsStatusVariant(s: "pass" | "warn" | "fail"): Variant {
  return s === "pass" ? "success" : s === "warn" ? "warning" : "danger";
}

/** Baz puan → yüzde metni (500 → "5", 150 → "1,5"). */
export function bpToPercent(bp: number): string {
  const v = bp / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "").replace(".", ",");
}

/** Kullanıcının yazdığı yüzdeyi (virgül veya nokta) baz puana çevirir; geçersizse null. */
export function percentToBp(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const bp = Math.round(n * 100);
  return Math.abs(bp - n * 100) < 1e-9 ? bp : null;
}
