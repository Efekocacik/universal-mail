/**
 * Paket R (Faz 5): resmî sicil sayfası, ayar kartı, çalışma durumları, eşleşme nedenleri, `registry.error.*` ve `apiError.REGISTRY_*`. P0 başlattı; sonrasında yalnızca R düzenler.
 * Karşılığı `en/registry.ts`.
 */
export const registry = {
  "registry.title": "Sicil kayıtları",
  "registry.subtitle":
    "Resmî şirket sicilinde yeni kurulan işletmeleri bulun ve haritadaki işletmelerle eşleştirin.",
  "registry.settings.title": "Resmî siciller",
  "registry.settings.desc":
    "Birleşik Krallık (Companies House) ve Fransa (INSEE Sirene) sicillerinden yeni kurulan işletmeler.",
  "registry.matchBadge": "Sicilde kayıtlı",
  "apiError.REGISTRY_DISABLED": "Bu sicil kaynağı kapalı. Ayarlar → Siciller bölümünden açın.",
  "apiError.REGISTRY_KEY_MISSING":
    "Sicil API anahtarı girilmemiş. Ayarlar → Siciller bölümüne anahtarı ekleyin veya demo kipini kullanın.",
  "apiError.REGISTRY_RUN_ACTIVE":
    "Bu kaynak için bir sicil çalışması zaten sürüyor. Bitmesini bekleyin.",
  "apiError.REGISTRY_MATCH_ACTIVE":
    "Eşleştirme zaten sürüyor. Bitince sonuçlar kendiliğinden güncellenir.",
  "apiError.REGISTRY_ALREADY_LEAD": "Bu sicil kaydından zaten bir lead oluşturuldu.",
  "apiError.REGISTRY_MATCHED":
    "Bu kayıt haritadaki bir işletmeyle eşleşti. Yeni lead yerine o işletmeyi kullanın.",
  "apiError.REGISTRY_AUTH": "Sicil API anahtarı reddedildi. Anahtarı kontrol edip yeniden girin.",
  "apiError.REGISTRY_RATE": "Sicil hizmeti çok fazla istek aldı. Bir dakika sonra yeniden deneyin.",
  "apiError.REGISTRY_UPSTREAM": "Sicil hizmetine şu an ulaşılamıyor. Biraz sonra yeniden deneyin.",
  "apiError.REGISTRY_SCHEME_UNAVAILABLE":
    "NAF 2025 kod tablosu henüz yayımlanmadı. Şimdilik NAF rév. 2 kullanın.",
} as const;
