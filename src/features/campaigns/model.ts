import type { BadgeProps } from "@/components/ui/badge";
import type { CampaignLeadStatus, CampaignStatus, SendWindow } from "@/lib/client/campaigns";
import { t, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";

/**
 * Kampanya ekranlarının saf görünüm mantığı (DOM'suz; node testleriyle doğrulanır). Sunucu kurallarının yerine GEÇMEZ:
 * pasif düğmeler yalnızca kullanıcı deneyimi içindir, bütün denetimler API'de yapılır.
 */

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "cancelled",
  "stopped",
];

export const SEQUENCE_STATUSES: readonly CampaignLeadStatus[] = [
  "pending",
  "excluded",
  "scheduled",
  "in_flight",
  "waiting_next",
  "completed",
  "replied",
  "bounced",
  "unsubscribed",
  "removed",
  "cancelled",
  "failed",
];

export const STATUS_VARIANT: Record<CampaignStatus, BadgeProps["variant"]> = {
  draft: "outline",
  ready: "default",
  running: "primary",
  paused: "warning",
  completed: "high",
  cancelled: "outline",
  stopped: "danger",
};

export const SEQUENCE_VARIANT: Record<CampaignLeadStatus, BadgeProps["variant"]> = {
  pending: "outline",
  excluded: "low",
  scheduled: "default",
  in_flight: "warning",
  waiting_next: "default",
  completed: "high",
  replied: "contacted",
  bounced: "danger",
  unsubscribed: "low",
  removed: "low",
  cancelled: "outline",
  failed: "danger",
};

export interface AllowedActions {
  edit: boolean;
  addLeads: boolean;
  prepare: boolean;
  backToDraft: boolean;
  start: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  removeLeads: boolean;
}

/** Sunucudaki geçiş tablosunun (campaigns/lifecycle.ts) kullanıcı arayüzü yansıması. */
export function allowedActions(status: CampaignStatus): AllowedActions {
  const open = status !== "completed" && status !== "cancelled" && status !== "stopped";
  return {
    edit: status === "draft",
    addLeads: status === "draft" || status === "ready",
    prepare: status === "draft",
    backToDraft: status === "ready",
    start: status === "ready",
    pause: status === "running",
    resume: status === "paused",
    cancel: open,
    removeLeads: open,
  };
}

/** Kuyrukta "Çıkar" yalnızca gönderimde olmayan dizilerde gösterilir (sunucu `in_flight`'ı reddeder). */
export const REMOVABLE_SEQUENCES: ReadonlySet<CampaignLeadStatus> = new Set([
  "pending",
  "excluded",
  "scheduled",
  "waiting_next",
]);

const ACTIVE: readonly CampaignLeadStatus[] = ["pending", "scheduled", "in_flight", "waiting_next"];
const FINISHED: readonly CampaignLeadStatus[] = [
  "completed",
  "replied",
  "bounced",
  "unsubscribed",
  "failed",
  "cancelled",
  "removed",
];

export interface Progress {
  total: number;
  active: number;
  finished: number;
  excluded: number;
  inFlight: number;
  pct: number;
}

/** İlerleme: hariç tutulanlar paydaya girmez; `in_flight` ayrıca gösterilir (inceleme gerekebilir). */
export function progressOf(counts: Partial<Record<CampaignLeadStatus, number>>): Progress {
  const sum = (keys: readonly CampaignLeadStatus[]) =>
    keys.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const active = sum(ACTIVE);
  const finished = sum(FINISHED);
  const total = active + finished;
  return {
    total,
    active,
    finished,
    excluded: counts.excluded ?? 0,
    inFlight: counts.in_flight ?? 0,
    pct: total > 0 ? Math.round((finished / total) * 100) : 0,
  };
}

/* Gönderim penceresi: yalnızca varsayılan (hafta içi 09.00–17.00) daraltılabilir. ----------------- */

export const WINDOW_DAYS = [1, 2, 3, 4, 5] as const;
/** Seçilebilir saatler: 09:00–17:00 arası, yarım saatlik. */
export const WINDOW_TIMES: readonly string[] = Array.from({ length: 17 }, (_, i) => {
  const m = 9 * 60 + i * 30;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${m % 60 === 0 ? "00" : "30"}`;
});
export const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

export function isValidWindow(w: SendWindow): boolean {
  if (w.days.length === 0 || !w.days.every((d) => (WINDOW_DAYS as readonly number[]).includes(d)))
    return false;
  if (!WINDOW_TIMES.includes(w.start) || !WINDOW_TIMES.includes(w.end)) return false;
  return w.start < w.end;
}

/* Okunur metinler. -------------------------------------------------------------------------------- */

function has(key: string): key is TrKey {
  return Object.prototype.hasOwnProperty.call(tr, key);
}

/** Uygunluk, engel ve hata kodlarının okunur karşılığı; sözlükte yoksa kodun kendisi. */
export function reasonLabel(code: string): string {
  const key = `reason.${code}`;
  return has(key) ? t(key) : code;
}

export function blockerLabel(code: string): string {
  const key = `blocker.${code}`;
  return has(key) ? t(key) : code;
}

/** `user` → kullanıcı; `auto:a,b` → sistemin otomatik duraklatma nedenleri. */
export function pauseReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === "user") return t("campaign.pause.byUser");
  if (reason.startsWith("auto:")) {
    const codes = reason.slice(5).split(",").filter(Boolean);
    return t("campaign.pause.auto", { reasons: codes.map(reasonLabel).join(", ") });
  }
  return reason;
}

export function dayLabel(d: number): string {
  return t(`weekday.${d as 1 | 2 | 3 | 4 | 5}`);
}
