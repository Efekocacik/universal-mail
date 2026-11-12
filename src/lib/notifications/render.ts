import { intlLocale, t, type Locale, type TrKey } from "@/lib/i18n";
import type { NotificationKind, NotificationParams } from "@/lib/db/schema";

/**
 * Bildirim metni: tür + parametreler → başlık/gövde, istenen dilde. Metin veritabanında SAKLANMAZ (dil değişince eski
 * bildirimler de yeni dilde görünür; Electron ana sürecinin i18n bilmesi gerekmez, metni API üretir).
 *
 * Parametre sözleşmesi (üreticiler bunlara uyar):
 *   n       sayı (yeni/açılan işletme, duraklatılan tarama…)
 *   region  kullanıcının bölge adı (Google içeriği değil)
 *   code    UPPER_SNAKE atlama kodu (BUDGET_BLOCKED, NEEDS_ACK, PLACES_KEY_MISSING, SETUP_REQUIRED,
 *           COUNTRY_NOT_TARGETED, ACTIVE_SCAN, CATEGORY_SET_MISSING, CONSENT_REQUIRED, SCAN_PAUSED,
 *           SCAN_BUDGET_STOPPED; `scan.paused` için ayrıca SCAN_RETRYING — Paket B, zamanlanmış taramanın durması)
 *   scanId, scheduleId  kimlikler (bağlantı ve tekilleştirme için; metinde kullanılmaz)
 */
export interface RenderedNotification {
  title: string;
  body: string;
}

const SKIP_CODES = new Set([
  "BUDGET_BLOCKED",
  "NEEDS_ACK",
  "PLACES_KEY_MISSING",
  "SETUP_REQUIRED",
  "COUNTRY_NOT_TARGETED",
  "ACTIVE_SCAN",
  "CATEGORY_SET_MISSING",
  "SCAN_PAUSED",
  "SCAN_BUDGET_STOPPED",
]);
/** Zamanlanmış taramanın kendi kendine durma nedenleri (`scan.paused` + `code`). Kod yoksa eski "yeniden başlatma" metni. */
const PAUSE_CODES = new Set(["SCAN_RETRYING", "SCAN_BUDGET_STOPPED", "SCAN_PAUSED"]);
const BACKGROUND_CODES = new Set(["PLACES_KEY_MISSING", "BUDGET_BLOCKED", "CONSENT_REQUIRED"]);

function count(params: NotificationParams, locale: Locale): string {
  const n = typeof params.n === "number" && Number.isFinite(params.n) ? params.n : 0;
  return new Intl.NumberFormat(intlLocale(locale)).format(n);
}
const region = (p: NotificationParams) =>
  typeof p.region === "string" && p.region.trim() ? p.region.trim() : null;
const code = (p: NotificationParams) => (typeof p.code === "string" ? p.code : "");

export function renderNotification(
  row: { kind: NotificationKind; params: NotificationParams },
  locale: Locale,
): RenderedNotification {
  const p = row.params ?? {};
  const r = region(p);
  const tt = (key: TrKey, params?: Record<string, string | number>) => t(key, params, locale);
  switch (row.kind) {
    case "scan.done":
      return {
        title: tt("notif.scanDone.title", { n: count(p, locale) }),
        body: r ? tt("notif.scanDone.bodyRegion", { region: r }) : tt("notif.scanDone.body"),
      };
    case "scan.failed":
      return {
        title: tt("notif.scanFailed.title"),
        body: r ? tt("notif.scanFailed.bodyRegion", { region: r }) : tt("notif.scanFailed.body"),
      };
    case "scan.paused": {
      const c = code(p);
      if (PAUSE_CODES.has(c))
        return {
          title: r
            ? tt("notif.scanPaused.titleRegion", { region: r })
            : tt("notif.scanPaused.title"),
          body: tt(`notif.scanPaused.body.${c}` as TrKey),
        };
      return {
        title: tt("notif.scanPaused.title"),
        body: tt("notif.scanPaused.body", { n: count(p, locale) }),
      };
    }
    case "place.opened":
      return {
        title: tt("notif.opened.title", { n: count(p, locale) }),
        body: r ? tt("notif.opened.bodyRegion", { region: r }) : tt("notif.opened.body"),
      };
    case "schedule.skipped": {
      const c = code(p);
      return {
        title: tt("notif.scheduleSkipped.title"),
        body: SKIP_CODES.has(c)
          ? tt(`notif.scheduleSkipped.body.${c}` as TrKey)
          : tt("notif.scheduleSkipped.body.other"),
      };
    }
    case "background.skipped": {
      const c = code(p);
      return {
        title: tt("notif.backgroundSkipped.title"),
        body: BACKGROUND_CODES.has(c)
          ? tt(`notif.backgroundSkipped.body.${c}` as TrKey)
          : tt("notif.backgroundSkipped.body.other"),
      };
    }
  }
}

export interface OsToast extends RenderedNotification {
  /** Uygulama içi yol (Electron yine de doğrulayıp kendi kökenine ekler). */
  url: string;
  /** Kapsanan bildirim kimlikleri. */
  ids: number[];
}

/** Bu sayıdan fazla bildirim tek bir özet bildirime dönüşür ("5 yeni bildirim"). */
export const OS_TOAST_MAX = 3;

/** OS bildirimleri: en çok `OS_TOAST_MAX` tanesi tek tek, fazlası tek özet (gösterge paneline götürür). */
export function toOsToasts(
  rows: { id: number; kind: NotificationKind; params: NotificationParams; url: string }[],
  locale: Locale,
): OsToast[] {
  if (rows.length <= OS_TOAST_MAX)
    return rows.map((r) => ({ ...renderNotification(r, locale), url: r.url, ids: [r.id] }));
  return [
    {
      title: t("notif.summary.title", { n: rows.length }, locale),
      body: t("notif.summary.body", undefined, locale),
      url: "/dashboard",
      ids: rows.map((r) => r.id),
    },
  ];
}
