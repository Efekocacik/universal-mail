import type { RegistryPage, RegistryProvider, RegistrySource } from "./types";

/**
 * Demo sicil sağlayıcısı (P0 taslağı; sahibi: paket R). Ağa çıkmaz, anahtar istemez, `isDemo = true`. P0 sürümü boş
 * sayfa döndürür; paket R bunu MockPlaces adlarından türetilen belirlenimci kayıtlarla doldurur (sözleşme §d).
 */
export function createDemoRegistryProvider(source: RegistrySource): RegistryProvider {
  return {
    source,
    isDemo: true,
    async search(): Promise<RegistryPage> {
      return { items: [], total: 0, nextCursor: null };
    },
    async test(): Promise<void> {},
  };
}
