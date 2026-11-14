/**
 * Paket T (Faz 5): DE bilgi rozeti, A/B konu, kategori varyantları, kampanya istatistikleri, açılma izleme kartı ve şablon hata metinleri. P0 başlattı; sonrasında yalnızca T düzenler.
 * Karşılığı `en/variants.ts`.
 */
export const variants = {
  "tracking.settings.title": "Açılma izleme",
  "tracking.settings.desc":
    "Demo kampanyalarda iletilerin açılıp açılmadığını yaklaşık olarak gösterir. Varsayılan olarak kapalıdır.",
  "apiError.TEMPLATE_INFO_ONLY":
    "Bu şablon yalnızca bilgi amaçlıdır ve gönderimde kullanılamaz. Başka bir şablon seçin.",
  "apiError.TEMPLATE_NO_VARIANT_B": "Bu şablonun B konusu yok. Önce şablona bir B konusu ekleyin.",
  "apiError.CATEGORY_TEMPLATE_MISMATCH":
    "Kategori şablonunun dili veya türü adımla uyuşmuyor. Aynı dilde ve türde bir şablon seçin.",
} as const;
