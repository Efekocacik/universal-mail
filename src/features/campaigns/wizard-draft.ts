import type { StepInput } from "@/lib/client/campaigns";
import type { BasicsValues } from "./wizard-dirty";

/**
 * Kampanya sihirbazının YEREL taslak kaydı (Faz 4, sihirbaz boşlukları). Kaydedilmemiş düzenlemeler 1 sn gecikmeyle
 * bu bilgisayarın tarayıcı deposuna yazılır; uygulama çökse veya kullanıcı yanlışlıkla ayrılsa bile sihirbaz yeniden
 * açıldığında "Kaydedilmemiş değişiklikleri geri yükle" sorusu çıkar.
 *
 *  - Sunucuya ASLA otomatik kaydedilmez: kayıt kampanyanın `updatedAt` değerini değiştirir ve başlatma özetinin
 *    onay belirtecini geçersiz kılar.
 *  - Taslak, düzenlemenin başladığı kampanya sürümüne (`against` = `updatedAt`) bağlıdır. Kampanya o zamandan beri
 *    değiştiyse (başka sekme, lead eklendi) eski taslak geri yükleme için ÖNERİLMEZ ve silinir.
 *  - En çok `DRAFT_MAX_AGE_MS` (7 gün) saklanır. Bozuk/eski biçimli kayıt sessizce silinir.
 *  - Depo okunamazsa (gizli pencere, kapalı depo) özellik sessizce devre dışıdır; sihirbaz aynen çalışır.
 */

export const DRAFT_PREFIX = "um.wizardDraft.";
export const DRAFT_VERSION = 1;
export const DRAFT_MAX_AGE_MS = 7 * 86_400_000;
export const DRAFT_DEBOUNCE_MS = 1_000;

export type DraftPart = "basics" | "steps";

export interface WizardDraft {
  v: typeof DRAFT_VERSION;
  /** Düzenlemenin başladığı kampanya sürümü (`updatedAt`); yeni kampanyada `null`. */
  against: number | null;
  savedAt: number;
  basics?: BasicsValues;
  steps?: StepInput[];
}

/** `localStorage` benzeri en küçük arayüz (testte bellek içi sahte kullanılır). */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function draftKey(campaignId: number | undefined): string {
  return `${DRAFT_PREFIX}${campaignId ?? "new"}`;
}

/** Tarayıcı deposu; erişilemiyorsa `null` (her erişim ayrıca try/catch ile korunur). */
export function browserDraftStore(): DraftStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function validBasics(b: unknown): b is BasicsValues {
  if (typeof b !== "object" || b === null) return false;
  const x = b as Record<string, unknown>;
  const w = x.sendWindow as Record<string, unknown> | undefined;
  return (
    typeof x.name === "string" &&
    x.name.length <= 200 &&
    (x.mailboxId === null || isInt(x.mailboxId)) &&
    isInt(x.dailyCap) &&
    isInt(x.minGapS) &&
    isInt(x.maxGapS) &&
    typeof w === "object" &&
    w !== null &&
    typeof w.start === "string" &&
    typeof w.end === "string" &&
    Array.isArray(w.days) &&
    w.days.every(isInt)
  );
}

function validSteps(s: unknown): s is StepInput[] {
  return (
    Array.isArray(s) &&
    s.length <= 30 &&
    s.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        isInt((x as StepInput).stepIndex) &&
        isInt((x as StepInput).templateId) &&
        isInt((x as StepInput).delayDays) &&
        typeof (x as StepInput).language === "string",
    )
  );
}

function parse(raw: string | null): WizardDraft | null {
  if (!raw || raw.length > 50_000) return null;
  try {
    const d = JSON.parse(raw) as Partial<WizardDraft>;
    if (d.v !== DRAFT_VERSION || !isInt(d.savedAt)) return null;
    if (!(d.against === null || isInt(d.against))) return null;
    if (d.basics !== undefined && !validBasics(d.basics)) return null;
    if (d.steps !== undefined && !validSteps(d.steps)) return null;
    if (d.basics === undefined && d.steps === undefined) return null;
    return d as WizardDraft;
  } catch {
    return null;
  }
}

function safeRemove(store: DraftStore, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* depo kapalı: yok sayılır */
  }
}

/**
 * Geri yüklenebilir taslağı okur: yalnızca biçimi geçerli, 7 günden yeni ve `against` değeri kampanyanın ŞU ANKİ
 * sürümüyle aynıysa döner. Aksi hâlde kaydı siler ve `null` döner.
 */
export function readDraft(
  store: DraftStore | null,
  key: string,
  currentUpdatedAt: number | null,
  now: number,
): WizardDraft | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const d = parse(raw);
  if (!d || d.against !== currentUpdatedAt || now - d.savedAt > DRAFT_MAX_AGE_MS) {
    safeRemove(store, key);
    return null;
  }
  return d;
}

/** Bir bölümü (temel ayarlar veya adımlar) taslağa yazar; diğer bölüm aynı sürüme aitse korunur. */
export function writeDraftPart<P extends DraftPart>(
  store: DraftStore | null,
  key: string,
  part: P,
  value: NonNullable<WizardDraft[P]>,
  against: number | null,
  now: number,
): boolean {
  if (!store) return false;
  try {
    const prev = parse(store.getItem(key));
    const base: WizardDraft =
      prev && prev.against === against ? prev : { v: DRAFT_VERSION, against, savedAt: now };
    store.setItem(key, JSON.stringify({ ...base, [part]: value, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** Bölüm kaydedildi veya değişiklik kalmadı: o bölüm taslaktan çıkar; boş kalan taslak silinir. */
export function clearDraftPart(store: DraftStore | null, key: string, part: DraftPart): void {
  if (!store) return;
  try {
    const prev = parse(store.getItem(key));
    if (!prev) return;
    const next: WizardDraft = { ...prev };
    delete next[part];
    if (next.basics === undefined && next.steps === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(next));
  } catch {
    /* depo kapalı: yok sayılır */
  }
}

export function clearDraft(store: DraftStore | null, key: string): void {
  if (store) safeRemove(store, key);
}
