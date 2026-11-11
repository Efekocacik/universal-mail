/**
 * Şablon değişkenleri (SRS FR-TPL-01).
 *
 * Değerler yalnızca BİZİM verimizden gelir. Google Places içeriği (işletme adı, açılış tarihi) e-postada
 * kullanılmaz: `{{isletme_adi}}` yalnızca kullanıcının girdiği "Görünen ad"dır; `{{acilis_tarihi}}` bu sürümde
 * desteklenmez. `footer` işaretli değişkenler zorunlu alt bilgide de yer alır (gövdede kullanılsa bile alt bilgi
 * her zaman eklenir). `unsupported` değişken içeren şablon kaydedilemez.
 */
export interface TemplateVariable {
  key: string;
  /** Değerin kaynağı. */
  source: "lead" | "sender" | "system" | "none";
  footer?: boolean;
  /** Bu sürümde kullanılamaz; nedeni. */
  unsupported?: string;
  /** Google Places içeriği (kalıcı saklanmaz, e-postada kullanılmaz). */
  google?: boolean;
}

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { key: "isletme_adi", source: "lead" },
  { key: "sehir", source: "lead" },
  { key: "kategori", source: "lead" },
  {
    key: "acilis_tarihi",
    source: "none",
    google: true,
    unsupported: "Açılış tarihi Google verisidir; e-postada kullanılmaz.",
  },
  { key: "gonderen_ad", source: "sender" },
  { key: "firma", source: "sender" },
  { key: "firma_adres", source: "sender", footer: true },
  { key: "telefon", source: "sender", footer: true },
  { key: "cikis_linki", source: "system", footer: true },
  {
    key: "kisisel_giris",
    source: "none",
    unsupported: "Yapay zekâ ile kişisel giriş (Faz 5) henüz desteklenmiyor.",
  },
];

export type VariableKey =
  | "isletme_adi"
  | "sehir"
  | "kategori"
  | "acilis_tarihi"
  | "gonderen_ad"
  | "firma"
  | "firma_adres"
  | "telefon"
  | "cikis_linki"
  | "kisisel_giris";

const BY_KEY = new Map(TEMPLATE_VARIABLES.map((v) => [v.key, v]));

export function variableInfo(key: string): TemplateVariable | undefined {
  return BY_KEY.get(key);
}

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*(?:\|[^}]*)?\}\}/g;

/** Metindeki `{{degisken}}` / `{{degisken|yedek}}` adlarını (tekrarsız) döndürür. */
export function templateVariablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE_RE)].map((m) => m[1]!))];
}
