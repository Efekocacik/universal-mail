import type { CampaignDetail, SendWindow, StepInput } from "@/lib/client/campaigns";
import { DEFAULT_WINDOW } from "./model";

/**
 * Kampanya sihirbazının "kaydedilmemiş değişiklik" mantığı (C13; DOM'suz test edilir). Adımlar yerel durumlarını
 * kampanyanın sunucudaki değerleriyle karşılaştırır; fark varsa sihirbaz adım değiştirmeden, bağlantıyla sayfadan
 * çıkmadan veya pencereyi/sekmeyi kapatmadan önce uyarır.
 */

export interface BasicsValues {
  name: string;
  mailboxId: number | null;
  sendWindow: SendWindow;
  dailyCap: number;
  minGapS: number;
  maxGapS: number;
}

/** Yeni kampanya formunun başlangıç değerleri (sihirbazdaki varsayılanlarla aynı). */
export const NEW_BASICS: Omit<BasicsValues, "mailboxId"> = {
  name: "",
  sendWindow: DEFAULT_WINDOW,
  dailyCap: 20,
  minGapS: 90,
  maxGapS: 240,
};

function sameWindow(a: SendWindow, b: SendWindow): boolean {
  const da = [...a.days].sort((x, y) => x - y);
  const db = [...b.days].sort((x, y) => x - y);
  return (
    a.start === b.start &&
    a.end === b.end &&
    da.length === db.length &&
    da.every((d, i) => d === db[i])
  );
}

/**
 * Temel ayarlar değişti mi? Yeni kampanyada varsayılanlarla karşılaştırılır; posta kutusu sayılmaz (tek uygun kutu
 * otomatik seçilir, bu bir kullanıcı düzenlemesi değildir). Aynı kural posta kutusu OLMADAN kaydedilmiş bir taslak için
 * de geçerlidir: kullanıcı kutuyu kendisi seçmedikçe (`mailboxTouched`) otomatik seçim değişiklik sayılmaz.
 */
export function basicsDirty(
  campaign: Pick<
    CampaignDetail,
    "name" | "mailboxId" | "sendWindow" | "dailyCap" | "minGapS" | "maxGapS"
  > | null,
  v: BasicsValues,
  opts: { mailboxTouched?: boolean } = {},
): boolean {
  const base = campaign ?? { ...NEW_BASICS, mailboxId: v.mailboxId };
  const autoMailbox = campaign !== null && campaign.mailboxId === null && !opts.mailboxTouched;
  return (
    v.name !== base.name ||
    (!autoMailbox && v.mailboxId !== base.mailboxId) ||
    !sameWindow(v.sendWindow, base.sendWindow) ||
    v.dailyCap !== base.dailyCap ||
    v.minGapS !== base.minGapS ||
    v.maxGapS !== base.maxGapS
  );
}

function normalizeSteps(list: readonly StepInput[]): string[] {
  return list
    .map(
      (s) =>
        // İlk adımın gecikmesi anlamsızdır (her zaman 0 gönderilir); karşılaştırmaya girmez.
        `${s.language}|${s.stepIndex}|${s.templateId}|${s.stepIndex === 0 ? 0 : s.delayDays}`,
    )
    .sort();
}

/** Adım listesi kayıtlı olandan farklı mı (sıra önemsiz)? */
export function stepsDirty(saved: readonly StepInput[], current: readonly StepInput[]): boolean {
  const a = normalizeSteps(saved);
  const b = normalizeSteps(current);
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

export interface ClickLike {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface AnchorLike {
  href: string;
  target: string;
  hasDownload: boolean;
}

/**
 * Bir bağlantı tıklaması sihirbazdan ayrılıyor mu? Ayrılıyorsa gidilecek yerel yol, değilse null. Yeni sekme
 * (değiştirici tuş, `target`), indirme, başka kaynak ve yalnızca `#` değişikliği yakalanmaz.
 */
export function leavingHref(e: ClickLike, a: AnchorLike, current: string): string | null {
  if (e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if (a.hasDownload || (a.target && a.target !== "_self")) return null;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(a.href, from);
  } catch {
    return null;
  }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return `${to.pathname}${to.search}${to.hash}`;
}
