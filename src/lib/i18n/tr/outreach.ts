/**
 * Paket E (gönderim, kampanya, takip adımları, posta kutusu sınırları) için yeni Türkçe anahtarlar.
 * Yalnızca E düzenler; karşılığı `en/outreach.ts`.
 */
export const outreach = {
  // F: complaint/stop_reason — Aşama 15.10-2 (TB-2, TB-10, TB-11d) ve kampanya sayaçları ("hata a").
  // Paket F'nin bloğu; E bu satırları düzenlemez. Karşılığı en/outreach.ts içindeki aynı blok.
  "campaign.progress.stoppedBeforeSend": "{n} kişi ileti almadan durdu",
  "campaign.progress.optedOut": "{n} kişi listeden çıktı",
  "campaign.progress.complained": "{n} kişi şikâyet nedeniyle durdu",
  "sequenceStop.unsubscribe": "Listeden çıktı",
  "sequenceStop.complaint": "Şikâyet nedeniyle durdu",
  "sequenceStop.completedThenUnsubscribe": "Tamamlandı, sonra listeden çıktı",
  "sequenceStop.completedThenComplaint": "Tamamlandı, sonra şikâyet etti",
  "reason.business_complaint":
    "Bu işletmenin başka bir adresi şikâyet etti; bu adrese gönderim durduruldu (adres engellenmedi)",
  // F: blok sonu
} as const;
