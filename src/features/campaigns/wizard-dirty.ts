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

/* Geçmiş (geri tuşu) koruması --------------------------------------------------------------------------------------- */

/**
 * Kaydedilmemiş değişiklik varken tarayıcı/Electron "geri" hareketi (geri tuşu, Alt+←, kaydırma) sihirbazdan sessizce
 * çıkmasın diye geçmişe aynı adreste bir "nöbetçi" kayıt eklenir. Geri gelindiğinde nöbetçi yeniden eklenir ve ayrılma
 * sorusu gösterilir; kullanıcı "Değişiklikleri at" derse iki kayıt geri gidilir (nöbetçi + asıl sayfa).
 */
export const HISTORY_GUARD = "umWizardGuard";

export function isGuardState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as Record<string, unknown>)[HISTORY_GUARD] === true
  );
}

/** Mevcut geçmiş durumunu koruyarak (Next.js iç alanları dahil) nöbetçi işaretini ekler. */
export function guardState(current: unknown): Record<string, unknown> {
  const base =
    typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {};
  return { ...base, [HISTORY_GUARD]: true };
}

/** "Değişiklikleri at" sonrası geri gidilecek adım sayısı: nöbetçi ve sihirbaz sayfası. */
export const GUARD_BACK_STEPS = -2;

/**
 * "Değişiklikleri at" sonrası geri hareketi nasıl yapılır: geçmişte nöbetçi + sihirbazdan önce en az bir kayıt varsa
 * iki kayıt geri gidilir; sihirbaz geçmişin İLK kaydıysa (`history.length <= 2`) `go(-2)` hiçbir şey yapmazdı, bu
 * yüzden kampanyalar listesine yönlendirilir.
 */
export function guardBackAction(historyLength: number): "history" | "fallback" {
  return Number.isFinite(historyLength) && historyLength > 2 ? "history" : "fallback";
}

/* Posta kutusu tavanı ipucu ----------------------------------------------------------------------------------------- */

export interface MailboxCapInfo {
  limits?: { todayCap: number; profileMaxDaily?: number };
}

/**
 * Kampanyanın günlük sınırı seçili posta kutusunun izin verdiğinden yüksekse kullanıcıya açıklama (engel değil):
 * `max` kutunun profil üst sınırı (kişisel Gmail 50) aşıldı, kampanya sınırına hiç ulaşılamaz; `today` bugünkü ısınma
 * tavanı daha düşük, kutu ısındıkça artar. Gönderimde her zaman küçük olan uygulanır.
 */
export function mailboxCapHint(
  dailyCap: number,
  mailbox: MailboxCapInfo | undefined,
): { kind: "max" | "today"; n: number } | null {
  const l = mailbox?.limits;
  if (!l || !Number.isFinite(dailyCap)) return null;
  if (l.profileMaxDaily !== undefined && dailyCap > l.profileMaxDaily) {
    return { kind: "max", n: l.profileMaxDaily };
  }
  if (dailyCap > l.todayCap) return { kind: "today", n: l.todayCap };
  return null;
}

/* Takip şablonu ön seçimi (9b) -------------------------------------------------------------------------------------- */

/**
 * Takip sayısı artırıldığında boş kalan her dil/adım için o dilin takip şablonlarından sıradakini önerir (yerleşik
 * "Takip 1" → 2. adım, "Takip 2" → 3. adım). Kullanıcının seçtiği şablon DEĞİŞTİRİLMEZ.
 */
export function prefillFollowups(
  current: Readonly<Record<string, number[]>>,
  templates: readonly { id: number; language: string; name?: string; builtIn?: boolean }[],
  languages: readonly string[],
  count: number,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [l, list] of Object.entries(current)) out[l] = [...list];
  for (const l of languages) {
    // Yerleşikler önce, sonra ada göre ("Takip 1" < "Takip 2"); kullanıcı şablonları sonra gelir.
    const options = templates
      .filter((x) => x.language === l)
      .sort(
        (a, b) =>
          Number(b.builtIn === true) - Number(a.builtIn === true) ||
          (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true }) ||
          a.id - b.id,
      );
    if (options.length === 0) continue;
    const list = (out[l] ??= []);
    for (let i = 0; i < count; i++) {
      if (!list[i]) list[i] = (options[i] ?? options[options.length - 1]!).id;
    }
  }
  return out;
}
