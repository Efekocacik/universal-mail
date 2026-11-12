/**
 * E-posta önizlemesinin yalıtımı. Sunucu çıktısı zaten temizlenmiştir (allowlist); yine de BOŞ `sandbox`
 * özniteliğiyle yalıtılmış bir çerçevede gösterilir: betik çalışmaz, form gönderilmez, üst pencereye erişilemez,
 * bağlantılar açılamaz. Dış kaynak yüklenmesini engellemek için içerik güvenlik politikası da eklenir.
 */
export const PREVIEW_SANDBOX = "";
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'";

/**
 * Önizleme, alıcının e-posta istemcisindeki görünümü taklit eder: uygulama teması (koyu/açık) ne olursa olsun beyaz
 * zemin üzerinde koyu metin. Bu yüzden tema belirteci DEĞİL, sabit renktir; bileşenlerde sabit renk denetiminin
 * (tests/theme-tokens.test.ts) bilinçli tek istisnası bu dosyadır.
 */
export const PREVIEW_TEXT_COLOR = "#1f2328";

export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:${PREVIEW_TEXT_COLOR}}</style></head><body>${html}</body></html>`;
}
