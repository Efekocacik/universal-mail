/**
 * Bildirim metinleri (zil ve işletim sistemi bildirimi). Metin, kayıt OKUNURKEN türe ve parametrelere göre üretilir
 * (`src/lib/notifications/render.ts`); veritabanında yalnızca tür ve parametreler durur. P0 ekledi; B genişletir.
 * Karşılığı `en/notifications.ts`.
 */
export const notifications = {
  "notif.bell.label": "Bildirimler",
  "notif.empty": "Henüz bildirim yok",
  "notif.markAllRead": "Tümünü okundu say",
  "notif.summary.title": "{n} yeni bildirim",
  "notif.summary.body": "Ayrıntılar için uygulamadaki bildirimlere bakın.",
  "notif.scanDone.title": "{n} yeni işletme bulundu",
  "notif.scanDone.body": "Tarama tamamlandı.",
  "notif.scanDone.bodyRegion": "{region} taraması tamamlandı.",
  "notif.scanFailed.title": "Tarama tamamlanamadı",
  "notif.scanFailed.body": "Ayrıntılar Taramalar sayfasında.",
  "notif.scanFailed.bodyRegion":
    "{region} taraması tamamlanamadı. Ayrıntılar Taramalar sayfasında.",
  "notif.scanPaused.title": "Tarama duraklatıldı",
  "notif.scanPaused.body":
    "{n} tarama, uygulama yeniden başlatılırken duraklatıldı. Taramalar sayfasından devam ettirebilirsiniz.",
  "notif.opened.title": "{n} işletme açıldı!",
  "notif.opened.body": "Yakında açılacak olarak izlenen işletmeler artık faaliyette.",
  "notif.opened.bodyRegion":
    "{region}: yakında açılacak olarak izlenen işletmeler artık faaliyette.",
  "notif.scheduleSkipped.title": "Zamanlanmış tarama atlandı",
  "notif.scheduleSkipped.body.BUDGET_BLOCKED":
    "Aylık Google bütçesi doldu; tarama bütçe yenilenince yeniden denenecek.",
  "notif.scheduleSkipped.body.NEEDS_ACK":
    "Tahmini maliyet, onayladığınız üst sınırı aşıyor. Taramayı Taramalar sayfasından onaylayarak çalıştırın.",
  "notif.scheduleSkipped.body.PLACES_KEY_MISSING":
    "Google Places API anahtarı yok; Ayarlar'dan ekleyin.",
  "notif.scheduleSkipped.body.SETUP_REQUIRED": "Kurulum tamamlanmadığı için tarama başlatılamadı.",
  "notif.scheduleSkipped.body.COUNTRY_NOT_TARGETED":
    "Bölgenin ülkesi artık hedef ülkeleriniz arasında değil.",
  "notif.scheduleSkipped.body.ACTIVE_SCAN":
    "Aynı bölge ve kategoriler için başka bir tarama sürüyor; bir saat sonra yeniden denenecek.",
  "notif.scheduleSkipped.body.other": "Tarama bu kez çalıştırılamadı; yeniden denenecek.",
  "notif.backgroundSkipped.title": "Arka plan denetimi atlandı",
  "notif.backgroundSkipped.body.PLACES_KEY_MISSING":
    "Google Places API anahtarı olmadığı için işletme durumları denetlenemedi.",
  "notif.backgroundSkipped.body.BUDGET_BLOCKED":
    "Aylık Google bütçesi doldu; işletme durumları bütçe yenilenince denetlenecek.",
  "notif.backgroundSkipped.body.CONSENT_REQUIRED":
    "Kullanım koşulları onaylanmadığı için arka plan denetimi yapılmadı.",
  "notif.backgroundSkipped.body.other": "Arka plan denetimi bu kez yapılamadı; yeniden denenecek.",
} as const;
