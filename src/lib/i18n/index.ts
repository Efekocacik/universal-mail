import { tr } from "./tr";

export type TrKey = keyof typeof tr;

/**
 * Arayüz metni. Şimdilik yalnızca Türkçe; İngilizce Faz 4'te `en.ts` eklenerek açılır (NFR-09).
 * Kullanılan her anahtarın sözlükte bulunduğu `tests/i18n.test.ts` ile doğrulanır.
 */
export function t(key: TrKey, params?: Record<string, string | number>): string {
  let text: string = tr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
  }
  return text;
}
