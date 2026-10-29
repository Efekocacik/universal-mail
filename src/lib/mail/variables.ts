/**
 * Şablon değişkenleri (SRS FR-TPL-01). `google` işaretli değişkenlerin değeri Google Places içeriğidir ve kalıcı
 * saklanmaz: yalnızca oturum önbelleğinde varsa doldurulur, gönderim geçmişine maskelenmiş yazılır.
 * `footer` işaretli değişkenler zorunlu alt bilgiye aittir; gönderimde sistem tarafından eklenir, şablon gövdesinde
 * gerekmez.
 */
export interface TemplateVariable {
  key: string;
  google?: boolean;
  footer?: boolean;
}

export const TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { key: "isletme_adi", google: true },
  { key: "sehir" },
  { key: "kategori" },
  { key: "acilis_tarihi", google: true },
  { key: "gonderen_ad" },
  { key: "firma" },
  { key: "firma_adres", footer: true },
  { key: "telefon", footer: true },
  { key: "cikis_linki", footer: true },
  { key: "kisisel_giris" },
];

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Metindeki `{{degisken}}` adlarını (tekrarsız) döndürür. */
export function templateVariablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE_RE)].map((m) => m[1]!))];
}
