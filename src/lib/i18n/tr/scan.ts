/**
 * Paket B (tarama motoru: zamanlanmış taramalar, saklama politikası, açılış izleme, RDAP) için yeni Türkçe anahtarlar.
 * Yalnızca B düzenler; karşılığı `en/scan.ts`.
 */
export const scan = {
  // Taramalar sayfası ve zamanlamalar
  "scans.origin.schedule": "Zamanlanmış",
  "schedules.title": "Düzenli taramalar",
  "help.schedules":
    "Seçtiğiniz bölgeyi belirlediğiniz aralıkla kendiliğinden yeniden tarar. Bir çalışma onayladığınız tutarı aşamaz; aşacaksa durur ve size sorar.",
  "schedules.loadError": "Düzenli taramalar yüklenemedi.",
  "schedules.empty":
    'Henüz düzenli tarama yok. Tamamlanan bir taramada "Düzenli tekrarla"ya basarak aynı bölgeyi her hafta, iki haftada bir ya da ayda bir kendiliğinden taratabilirsiniz.',
  "schedules.whileOpen":
    "Düzenli taramalar yalnızca uygulama açıkken çalışır. Uygulama kapalıyken kaçırılan çalışmalar, açılınca tek bir taramada birleştirilir.",
  "schedules.next": "Sonraki çalışma",
  "schedules.next.off": "Durduruldu",
  "schedules.next.due": "Şimdi (birkaç dakika içinde başlar)",
  "schedules.next.soon": "Yakında: {at}",
  "schedules.last": "Son durum",
  "schedules.outcome.completed": "Tamamlandı",
  "schedules.outcome.started": "Çalışıyor",
  "schedules.outcome.failed": "Tamamlanamadı",
  "schedules.outcome.skipped": "Atlandı",
  "schedules.outcome.paused": "Duraklatıldı",
  "schedules.skip.BUDGET_BLOCKED":
    "Aylık Google bütçesi dolduğu için atlandı. Bütçeyi Ayarlar'dan artırabilir ya da gelecek ayı bekleyebilirsiniz; yarın yeniden denenecek.",
  "schedules.skip.NEEDS_ACK":
    'Tahmini maliyet, bu zamanlama için onayladığınız üst sınırı aştığı için atlandı. "Şimdi çalıştır" ile onaylayarak başlatabilir ya da üst sınırı yükseltebilirsiniz.',
  "schedules.skip.PLACES_KEY_MISSING":
    "Google Places API anahtarı olmadığı için atlandı. Anahtarı Ayarlar'dan ekleyin.",
  "schedules.skip.SETUP_REQUIRED":
    "Kurulum veya kullanım onayı eksik olduğu için atlandı. Kurulum sihirbazını tamamlayın.",
  "schedules.skip.COUNTRY_NOT_TARGETED":
    "Bölgenin ülkesi artık hedef ülkeleriniz arasında olmadığı için atlandı. Ayarlar > Hedef pazarlar'dan ekleyin.",
  "schedules.skip.ACTIVE_SCAN":
    "Aynı bölge ve kategoriler için başka bir tarama sürdüğü için atlandı; bir saat sonra yeniden denenecek.",
  "schedules.skip.CATEGORY_SET_MISSING":
    "Zamanlamanın kullandığı bir kategori artık yok. Bu zamanlamayı silip taramayı yeniden kurun.",
  "schedules.skip.PREVIOUS_RUN_ACTIVE":
    "Önceki düzenli tarama hâlâ sürüyor; bittikten sonra yeni çalışma başlar.",
  "schedules.skip.SCAN_RETRYING":
    "Son tarama Google'a ulaşılamadığı için duraklatıldı; bir saat içinde kaldığı yerden kendiliğinden sürecek.",
  "schedules.skip.SCAN_BUDGET_STOPPED":
    "Son tarama aylık Google bütçesi dolduğu için durdu. Bütçe yenilenince ya da Ayarlar'dan artırınca kaldığı yerden kendiliğinden sürecek.",
  "schedules.skip.SCAN_PAUSED":
    "Son tarama duraklatılmış durumda (siz duraklattınız ya da güvenlik sınırına ulaştı). Aşağıdaki Taramalar listesinden sürdürün ya da iptal edin; o zamana kadar yeni çalışma başlamaz.",
  "schedules.skip.other": "Bu kez çalıştırılamadı; yarın yeniden denenecek.",
  "schedules.interval.7": "Her hafta",
  "schedules.interval.14": "İki haftada bir",
  "schedules.interval.30": "Ayda bir",
  "schedules.missed": "Uygulama kapalıyken {n} çalışma kaçırıldı; tek taramada birleştirildi.",
  "schedules.cap.user": "Tarama başına onaylanan üst sınır: {usd}",
  "schedules.cap.auto": "Tarama başına onaylanan tutar (otomatik): en çok {usd}",
  "schedules.cap.none":
    "Bu zamanlama için onaylanmış bir tutar yok (ör. Google'a geçildi). Arka planda çalışması için aşağıdan bir üst sınır onaylayın.",
  "schedules.cap.edit": "Tarama başına üst sınır (USD)",
  "schedules.cap.save": "Onayla",
  "schedules.cap.saved": "Üst sınır onaylandı.",
  "schedules.toggle": "Düzenli taramayı aç/kapat",
  "schedules.on": "Açık",
  "schedules.off": "Kapalı",
  "schedules.runNow": "Şimdi çalıştır",
  "schedules.delete": "Zamanlamayı sil",
  "schedules.delete.title": "Düzenli tarama silinsin mi?",
  "schedules.delete.body":
    "Bu bölge artık kendiliğinden taranmaz. Önceki taramalar ve bulunan işletmeler silinmez.",
  "schedules.deleted": "Düzenli tarama silindi.",
  "schedules.updated": "Düzenli tarama güncellendi.",
  "schedules.created": "Düzenli tarama kuruldu. İlk çalışma: {at}.",
  "schedules.exists": "Bu bölge ve kategoriler için zaten düzenli bir tarama var.",
  "schedules.repeat": "Düzenli tekrarla",
  "schedules.repeat.title": "Bu tarama düzenli tekrarlansın mı?",
  "schedules.repeat.body":
    "Aynı bölge ve kategoriler seçtiğiniz aralıkla kendiliğinden taranır. Her çalışmada yalnızca yeni ve yeni açılan işletmeler bildirilir.",
  "schedules.repeat.confirm": "Düzenli tekrarla",
  "schedules.field.interval": "Ne sıklıkla?",
  "schedules.field.cap": "Tarama başına en çok (USD, isteğe bağlı)",
  "schedules.field.cap.placeholder": "Boş bırakırsanız otomatik",
  "schedules.field.cap.hint":
    "Tahmini maliyet bu tutarı aşarsa tarama yapılmaz ve size haber verilir. Boş bırakırsanız ücretsiz kota bitmiş varsayılarak bugünkü en yüksek tahmin onaylanır.",
  "schedules.field.cap.invalid": "0 ile 10.000 arasında bir tutar yazın ya da boş bırakın.",
  "builder.repeat": "Bu taramayı düzenli tekrarla",
  "builder.repeat.note":
    "Tarama başladıktan sonra aynı bölge seçtiğiniz aralıkla kendiliğinden yeniden taranır.",

  // Google veri saklama kartı
  "retention.title": "Google verisi saklama kuralları",
  "retention.desc":
    "Google'ın kurallarına göre her veri türü ayrı süreyle saklanır. Kendi kayıtlarınız (notlar, durumlar, e-postalar) bu kurallardan etkilenmez.",
  "retention.col.data": "Veri",
  "retention.col.count": "Kayıt",
  "retention.col.rule": "Kural",
  "retention.row.ids": "Yer kimlikleri",
  "retention.row.coords": "Konumlar (enlem/boylam)",
  "retention.row.session": "Ad, adres, telefon, durum (geçici)",
  "retention.row.derived": '"Yakında açılacak / açıldı / yeni" işaretleri',
  "retention.rule.ids": "Süresiz saklanabilir; {days} günde bir yenilenir",
  "retention.rule.days": "En çok {days} gün",
  "retention.rule.session":
    "Yalnızca geçici bellekte, en çok {days} gün; uygulama kapanınca silinir",
  "retention.rule.derived.forever": "Süresiz (hukuki değerlendirme bekleniyor)",
  "retention.gone": "{n} işletme Google'da artık bulunamıyor; kayıtlarınız silinmedi.",
  "retention.derived.label": "İşaretler ne kadar saklansın?",
  "retention.derived.forever": "Süresiz",
  "retention.derived.days": "{days} gün",
  "retention.derived.hint":
    "Süre dolunca yalnızca işaretler temizlenir; işletme kayıtlarınız ve notlarınız kalır.",
  "retention.saved": "Saklama süresi kaydedildi.",
  "retention.refresh": "Yer kimliklerini şimdi yenile",
  "retention.refresh.due": "{n} kimliğin yenileme zamanı geldi (ücretsiz).",
  "retention.refresh.queued": "Yer kimlikleri arka planda yenileniyor.",
  "retention.refresh.already": "Bugün zaten bir yenileme başlatıldı.",
  "retention.sources": "Kaynaklar (son kontrol: {date})",
  "retention.source.terms": "Google Maps Platform Hizmet Şartları",
  "retention.source.policies": "Places API: önbelleğe alma ve saklama kuralları",
  "retention.source.placeId": "Places API: yer kimliklerini saklama",
  "retention.legal":
    "Bu özet hukuki görüş değildir. Canlı kullanıma geçmeden önce şartları bir hukukçuyla doğrulayın.",

  // Alan adı yaşı (RDAP) kartı
  "rdap.title": "Alan adı yaşı",
  "rdap.desc":
    "İşletmenin web sitesi yakın zamanda kaydedildiyse yenilik puanına +20 eklenir. Yeni bir işletmenin ipucudur, kanıtı değildir.",
  "rdap.toggle": "Alan adı yaşı denetimini aç/kapat",
  "rdap.privacy":
    "Yalnızca alan adı (ör. firma.de) herkese açık kayıt sunucusuna (RDAP) gönderilir; işletme adı veya e-posta gönderilmez.",
  "rdap.privacy.demo": "Demo modunda internete bağlanılmaz; kayıt tarihleri örnek olarak üretilir.",
  "rdap.days": 'Kaç günlük alan adı "yeni" sayılsın?',
  "rdap.days.save": "Kaydet",
  "rdap.days.hint": "Varsayılan 183 gün (yaklaşık 6 ay).",
  "rdap.days.invalid": "{min} ile {max} gün arasında bir sayı yazın.",
  "rdap.saved": "Alan adı yaşı ayarı kaydedildi.",
  "rdap.summary":
    "{known} alan adının kayıt tarihi biliniyor · {waiting} sırada · {unknown} tarih yok · {failed} yeniden denenecek",
  "rdap.lastChecked": "Son denetim: {at}",
  "rdap.check": "Şimdi denetle",
  "rdap.check.queued": "Alan adları arka planda denetleniyor.",
  "rdap.check.already": "Denetim zaten sürüyor.",

  // Lead ayrıntısı
  "detail.gone": "Google'da artık yok",
  "detail.gone.hint":
    "Google bu işletmeyi artık bulamıyor (kapanmış ya da kaydı silinmiş olabilir). Kaydınız silinmedi.",
  "detail.domainAge": "Alan adı kaydı",
  "detail.domainAge.value": "{date} (yaklaşık {months} ay önce)",
  "detail.domainAge.pending": "Henüz denetlenmedi",
  "detail.domainAge.no_date": "Kayıt tarihi yayımlanmıyor",
  "detail.domainAge.not_found": "Kayıt bulunamadı",
  "detail.domainAge.unsupported_tld": "Bu uzantı için kayıt sorgusu yok",
  "detail.domainAge.rate_limited": "Kayıt sunucusu meşgul; yeniden denenecek",
  "detail.domainAge.error": "Sorgulanamadı; yeniden denenecek",
  "detail.domainAge.disabled": "Denetim kapalı (Ayarlar > Alan adı yaşı bölümünden açabilirsiniz)",

  // Yenilik sinyali gerekçeleri (parametreli)
  "novelty.signal.future_opening":
    'Google bu işletmeyi "yakında açılacak" olarak bildiriyor. Tedarikçi aradığı anlamına gelmez.',
  "novelty.signal.reviews_very_few":
    "Çok az değerlendirme var. Tek başına yeni olduğunu göstermez.",
  "novelty.signal.reviews_few": "Az sayıda değerlendirme var. Düşük güvenilirlikte bir gösterge.",
  "novelty.signal.domain_young":
    "Web sitesinin alan adı yaklaşık {months} ay önce kaydedilmiş. Yeni bir işletme olabilir; kanıt değildir.",
} as const;
