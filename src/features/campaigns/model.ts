import type { BadgeProps } from "@/components/ui/badge";
import type { CampaignLeadStatus, CampaignStatus, SendWindow } from "@/lib/client/campaigns";
import { t, type TrKey } from "@/lib/i18n";
import { tr } from "@/lib/i18n/tr";
import { effectiveStopReason } from "@/lib/mail/inbound/complaint";

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
  ready: "info",
  running: "success",
  paused: "warning",
  completed: "default",
  cancelled: "low",
  stopped: "danger",
};

/** İlerleme çubuğu rengi: yalnızca duraklatılmış sarı, durdurulan kırmızı; taslak/hazır/iptal nötr. */
export function progressTone(status: CampaignStatus): "primary" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "running":
    case "completed":
      return "primary";
    case "stopped":
      return "danger";
    case "paused":
      return "warning";
    default:
      return "neutral";
  }
}

export const SEQUENCE_VARIANT: Record<CampaignLeadStatus, BadgeProps["variant"]> = {
  pending: "outline",
  excluded: "low",
  scheduled: "default",
  in_flight: "warning",
  waiting_next: "default",
  completed: "success",
  replied: "info",
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

/** Sunucunun ayrıntılı sayım satırı (`CampaignSummary.breakdown`). */
export interface BreakdownRow {
  status: CampaignLeadStatus;
  contacted: boolean;
  stopReason: "unsubscribe" | "complaint" | null;
  n: number;
}

export interface PlainCounts {
  /** En az bir kampanya iletisi KABUL EDİLMİŞ kişi (teslim edilemeyenler hariç). İleti değil kişi sayısıdır. */
  sent: number;
  /** Henüz hiç ileti almamış, sırada bekleyen kişi. */
  queued: number;
  /** Teslim edilemedi (bounce) veya hiç gönderilemeden başarısız. */
  failed: number;
  /** Bu kampanyadan hiç ileti almadan önce (başka bir iletiye) yanıt verdiği için gönderilmeyen kişi. */
  repliedBeforeSend: number;
  /** Hiç ileti almadan duran kişi (çıkış, şikâyet, çıkarma, iptal; yanıt hariç). */
  stoppedBeforeSend: number;
  /** BİLGİ (kovalarla örtüşür): listeden çıkan kişi (gönderimden önce veya sonra; şikâyet edenler hariç). */
  optedOut: number;
  /** BİLGİ (kovalarla örtüşür): şikâyet eden (ARF) veya işletmesinin başka adresi şikâyet ettiği için duran kişi. */
  complained: number;
}

const STOPPED_STATUSES: ReadonlySet<CampaignLeadStatus> = new Set([
  "unsubscribed",
  "removed",
  "cancelled",
]);
const QUEUED_STATUSES: ReadonlySet<CampaignLeadStatus> = new Set([
  "pending",
  "scheduled",
  "in_flight",
]);

const EMPTY_PLAIN: PlainCounts = {
  sent: 0,
  queued: 0,
  failed: 0,
  repliedBeforeSend: 0,
  stoppedBeforeSend: 0,
  optedOut: 0,
  complained: 0,
};

/**
 * Düz dille ilerleme (Faz 4 "hata a" + 15.10-2 TB-2). Kovalar AYRIKTIR; her dizi en çok birine girer:
 *  - `sent`: en az bir ileti kabul edilmiş (`contacted`) ve teslim edilemedi olmayan;
 *  - `failed`: teslim edilemedi (bounce) + hiç gönderilemeden başarısız;
 *  - `queued`: hiç ileti almamış bekleyen/planlanan/gönderilmekte olan;
 *  - `repliedBeforeSend`: hiç ileti almadan önce yanıt vermiş (başka kampanyanın iletisine);
 *  - `stoppedBeforeSend`: hiç ileti almadan duran (çıkış, şikâyet, çıkarma, iptal).
 * Bir kişi hiç ileti almadıysa ASLA "gönderildi" sayılmaz. Hariç tutulanlar sayılmaz.
 * `optedOut` / `complained` kovalara EK bilgidir (örtüşür; ayrı satırda gösterilir, bkz. `plainCountsNote`):
 * durma nedeni sütunundan, eski satırlarda işaretten.
 *
 * `breakdown` yoksa (eski önbellek yanıtı) temkinli yedek: yalnızca kesin gönderim almış durumlar
 * (`completed`, `waiting_next`) "gönderildi" sayılır; asla fazla göstermez.
 */
export function plainCounts(
  counts: Partial<Record<CampaignLeadStatus, number>>,
  breakdown?: readonly BreakdownRow[],
): PlainCounts {
  const sum = (keys: readonly CampaignLeadStatus[]) =>
    keys.reduce((a, k) => a + (counts[k] ?? 0), 0);
  if (!breakdown) {
    return {
      ...EMPTY_PLAIN,
      sent: sum(["completed", "waiting_next"]),
      queued: sum(["pending", "scheduled", "in_flight"]),
      failed: sum(["failed", "bounced"]),
    };
  }
  const out: PlainCounts = { ...EMPTY_PLAIN };
  for (const r of breakdown) {
    if (r.status === "excluded") continue;
    if (r.stopReason === "complaint") out.complained += r.n;
    else if (r.stopReason === "unsubscribe") out.optedOut += r.n;
    if (r.status === "bounced") out.failed += r.n;
    else if (r.contacted) out.sent += r.n;
    else if (r.status === "failed") out.failed += r.n;
    else if (QUEUED_STATUSES.has(r.status)) out.queued += r.n;
    else if (r.status === "replied") out.repliedBeforeSend += r.n;
    else if (STOPPED_STATUSES.has(r.status)) out.stoppedBeforeSend += r.n;
    // Gönderimsiz `completed`/`waiting_next` normalde oluşmaz; oluşursa "gönderildi" sayılmaz.
  }
  return out;
}

/**
 * Kampanya kartı ve ayrıntı başlığı için tek satırlık düz özet. Yalnızca AYRIK kovaları listeler (toplanabilir);
 * sıfır olan ek parçalar gösterilmez. Durma nedenleri örtüştüğü için burada DEĞİL, `plainCountsNote` ile ayrı satırda.
 */
export function plainCountsText(
  p: PlainCounts,
  fmt: (n: number) => string = (n) => String(n),
): string {
  const parts = [
    t("campaign.progress.plain", {
      sent: fmt(p.sent),
      queued: fmt(p.queued),
      failed: fmt(p.failed),
    }),
  ];
  if (p.repliedBeforeSend > 0)
    parts.push(t("campaign.progress.repliedBeforeSend", { n: fmt(p.repliedBeforeSend) }));
  if (p.stoppedBeforeSend > 0)
    parts.push(t("campaign.progress.stoppedBeforeSend", { n: fmt(p.stoppedBeforeSend) }));
  return parts.join(" · ");
}

/**
 * Durma nedenleri notu ("Bunlardan: 1 kişi listeden çıktı, 2 kişi şikâyet nedeniyle durdu"). Bu kişiler yukarıdaki
 * kovaların İÇİNDEDİR (ek kişi değildir); bu yüzden ayrı satırda ve "Bunlardan" önekiyle gösterilir. Hiçbiri yoksa `null`.
 */
export function plainCountsNote(
  p: PlainCounts,
  fmt: (n: number) => string = (n) => String(n),
): string | null {
  const items: string[] = [];
  if (p.optedOut > 0) items.push(t("campaign.progress.optedOut", { n: fmt(p.optedOut) }));
  if (p.complained > 0) items.push(t("campaign.progress.complained", { n: fmt(p.complained) }));
  return items.length === 0 ? null : t("campaign.progress.ofWhich", { list: items.join(", ") });
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

/**
 * Dizi durumu etiketi (15.10-2, TB-2/TB-10). `unsubscribed` durumunda neden ayrılır: "Listeden çıktı" / "Şikâyet
 * nedeniyle durdu". `completed` dizi sonradan çıkış/şikâyet görürse durumu korunur, nedeni eklenir. `stopReason`
 * verilmezse (eski yanıt) `"arf_complaint"` gerekçe işaretine düşülür.
 */
export function sequenceStatusLabel(
  status: CampaignLeadStatus,
  reasons?: readonly string[],
  stopReason?: "unsubscribe" | "complaint" | null,
): string {
  const reason = effectiveStopReason(status, stopReason, reasons);
  if (status === "unsubscribed")
    return t(reason === "complaint" ? "sequenceStop.complaint" : "sequenceStop.unsubscribe");
  if (status === "completed" && reason)
    return t(
      reason === "complaint"
        ? "sequenceStop.completedThenComplaint"
        : "sequenceStop.completedThenUnsubscribe",
    );
  return t(`sequenceStatus.${status}`);
}

/** Sayaç kutusu etiketi: `unsubscribed` durumu iki kutuya ayrılır (bkz. `statusStats`). */
export interface StatusStat {
  key: string;
  label: string;
  value: number;
}

/**
 * Ayrıntı ekranındaki durum kutuları. `breakdown` varsa `unsubscribed` tek kutu yerine "Listeden çıktı" ve "Şikâyet
 * nedeniyle durdu" olarak ayrılır; diğer durumlar olduğu gibi. Sıfır olan kutu gösterilmez.
 */
export function statusStats(
  counts: Partial<Record<CampaignLeadStatus, number>>,
  breakdown?: readonly BreakdownRow[],
): StatusStat[] {
  const out: StatusStat[] = [];
  for (const s of SEQUENCE_STATUSES) {
    const n = counts[s] ?? 0;
    if (n <= 0) continue;
    if (s === "unsubscribed" && breakdown) {
      let complaint = 0;
      for (const r of breakdown)
        if (r.status === "unsubscribed" && r.stopReason === "complaint") complaint += r.n;
      if (n - complaint > 0)
        out.push({
          key: "unsubscribed",
          label: t("sequenceStop.unsubscribe"),
          value: n - complaint,
        });
      if (complaint > 0)
        out.push({ key: "complaint", label: t("sequenceStop.complaint"), value: complaint });
      continue;
    }
    out.push({ key: s, label: t(`sequenceStatus.${s}`), value: n });
  }
  return out;
}

export interface ReasonChip {
  code: string;
  label: string;
  /** Uzun açıklama (araç ipucu); yoksa kodun kendisi. */
  hint: string;
}

/**
 * Gerekçe kodları → rozetler. TB-11(d) ile durdurulan dizide (`business_complaint`) çift yazım işareti
 * `arf_complaint` da bulunur (geri alma sözleşmesi); bu adres şikâyet etmediği için o rozet GİZLENİR, yalnızca kısa
 * "İşletmenin başka adresi şikâyet etti" rozeti ve açıklaması gösterilir.
 */
export function reasonChips(codes: readonly string[]): ReasonChip[] {
  const business = codes.includes("business_complaint");
  return codes
    .filter((c) => !(business && c === "arf_complaint"))
    .map((code) => {
      const hintKey = `reason.${code}.hint`;
      return { code, label: reasonLabel(code), hint: has(hintKey) ? t(hintKey) : code };
    });
}

/**
 * Kuyruk süzgeci seçeneği. `unsubscribed` durumu hem listeden çıkışı hem şikâyetle durdurmayı kapsar; rozetlerle
 * çelişmesin diye süzgeçte ikisini birlikte adlandırır.
 */
export function queueFilterLabel(status: CampaignLeadStatus): string {
  return status === "unsubscribed"
    ? t("sequenceStop.filterStopped")
    : t(`sequenceStatus.${status}`);
}

/** Uygunluk, engel ve hata kodlarının okunur karşılığı; sözlükte yoksa kodun kendisi. */
export function reasonLabel(code: string): string {
  const key = `reason.${code}`;
  if (has(key)) return t(key);
  // Otomatik duraklatma gerekçesinde içerik hatası kodları da bulunur (ör. `template_archived`).
  const compose = `composeError.${code}`;
  return has(compose) ? t(compose) : code;
}

export function blockerLabel(code: string): string {
  const key = `blocker.${code}`;
  return has(key) ? t(key) : code;
}

/** Engelin "ne yapmalıyım" cümlesi; sözlükte yoksa boş döner. */
export function blockerHint(code: string): string | null {
  const key = `blocker.hint.${code}`;
  return has(key) ? t(key) : null;
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
