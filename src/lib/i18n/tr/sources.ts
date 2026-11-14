/**
 * P0 (Faz 5): Taramalar alt gezinmesi (harita / sicil / içe aktarma), Ayarlar bölüm adları, ortak Faz 5 etiketleri ve gizli anahtar alan adları. Yalnızca P0 düzenler.
 * Karşılığı `en/sources.ts`.
 */
export const sources = {
  "scans.subnav.label": "Lead kaynakları",
  "scans.subnav.scans": "Harita taramaları",
  "scans.subnav.registry": "Sicil",
  "scans.subnav.import": "İçe aktar",
  "settings.nav.registry": "Siciller",
  "settings.nav.ai": "Yapay zekâ",
  "settings.nav.tracking": "Açılma izleme",
  "faz5.demoBadge": "Demo verisi",
  "faz5.preparing.title": "Bu bölüm hazırlanıyor",
  "faz5.preparing.body":
    "Bu özellik Faz 5 kapsamında etkinleşecek. Şimdilik başka bir işlem gerekmiyor.",
  "detail.source.import": "İçe aktarıldı",
  "detail.source.registry": "Sicil kaydı",
  "detail.placeless":
    "Bu lead bir listeden veya resmî sicilden geldi; Google kaydı yok. Bilgiler sizin verinizdir.",
  "secret.registry.companiesHouseKey": "Companies House API anahtarı",
  "secret.registry.inseeKey": "INSEE Sirene API anahtarı",
  "secret.anthropic.apiKey": "Claude (Anthropic) API anahtarı",
  "secret.snov.clientId": "Snov.io istemci kimliği",
  "secret.snov.clientSecret": "Snov.io istemci sırrı",
} as const;
