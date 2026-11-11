/**
 * E-posta önizlemesinin yalıtımı. Sunucu çıktısı zaten temizlenmiştir (allowlist); yine de BOŞ `sandbox`
 * özniteliğiyle yalıtılmış bir çerçevede gösterilir: betik çalışmaz, form gönderilmez, üst pencereye erişilemez,
 * bağlantılar açılamaz. Dış kaynak yüklenmesini engellemek için içerik güvenlik politikası da eklenir.
 */
export const PREVIEW_SANDBOX = "";
export const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'";

export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#1f2328}</style></head><body>${html}</body></html>`;
}
