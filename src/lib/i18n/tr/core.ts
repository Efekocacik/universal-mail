/**
 * Paket D (arayüz cilası: tema, yardım balonları, hata kodları, biçimlendirme, masaüstü kabuğu) için yeni Türkçe anahtarlar.
 * Yalnızca D düzenler. Anahtar eklerken aynı anahtarı `en/core.ts`'e de ekleyin (çevrilmemişse Türkçeye düşer).
 */
export const core = {
  // Görünüm ve dil (Ayarlar)
  "settings.nav.appearance": "Görünüm ve dil",
  "settings.appearance.title": "Görünüm ve dil",
  "settings.appearance.desc":
    "Ekranların dilini ve renk temasını seçin. Değişiklik hemen uygulanır ve bu bilgisayarda hatırlanır.",
  "settings.language": "Arayüz dili",
  "settings.language.hint":
    "Yalnızca uygulama ekranlarını değiştirir. Gönderdiğiniz e-postaların dili şablonda seçilir.",
  "settings.language.changed": "Arayüz dili değiştirildi.",
  "settings.language.unsaved.title": "Kaydedilmemiş değişiklikler var",
  "settings.language.unsaved.body":
    "Dil değişince arayüz yeniden yüklenir ve bu sayfada henüz kaydetmediğiniz değişiklikler silinir. Önce kaydetmek için Vazgeç'i seçin.",
  "settings.language.unsaved.confirm": "Yine de dili değiştir",
  "settings.language.unsaved.cancel": "Vazgeç",
  "uiLang.tr": "Türkçe",
  "uiLang.en": "English",
  "settings.theme": "Tema",
  "settings.theme.system": "Sistem",
  "settings.theme.light": "Açık",
  "settings.theme.dark": "Koyu",
  "settings.theme.hint": '"Sistem", bilgisayarınızın açık/koyu ayarını izler.',
  "settings.theme.changed": "Tema değiştirildi.",
  "settings.desktop.title": "Masaüstü uygulaması",
  "settings.openAtLogin.label": "Bilgisayar açılınca başlat",
  "settings.openAtLogin.hint":
    "Zamanlanmış taramalar yalnızca uygulama açıkken çalışır. Açarsanız uygulama, bilgisayarınızda oturum açtığınızda kendiliğinden başlar.",
  "settings.notificationsOs.label": "Masaüstü bildirimleri",
  "settings.notificationsOs.hint":
    "Uygulama açıkken yeni bulunan ve açılan işletmeleri, atlanan taramaları ve çıkış bağlantısı uyarılarını bilgisayarınızın bildirimi olarak gösterir. Kapatırsanız bildirimler yalnızca uygulamadaki zilde görünür.",
  "settings.desktop.browserOnly":
    "Bu iki ayar yalnızca masaüstü uygulamasında görünür; tarayıcıda bildirimler zilde toplanır.",

  // Map ID satır içi doğrulama
  "settings.mapId.err.email":
    'Bu bir e-posta adresine benziyor. Harita Kimliği, Google Cloud Console\'daki "Harita Yönetimi" sayfasında görünen kısa koddur.',
  "settings.mapId.err.too_long": "Harita Kimliği en çok 64 karakter olabilir.",
  "settings.mapId.err.invalid":
    "Harita Kimliği yalnızca harf, rakam, alt çizgi (_) ve tire (-) içerebilir; boşluk, nokta veya / olamaz.",

  // Bildirim zili
  "bell.open": "Bildirimleri aç",
  "bell.unreadCount": "{n} okunmamış bildirim",
  "bell.unavailable": "Bildirimler bu sürümde henüz etkin değil.",
  "bell.loadError": "Bildirimler yüklenemedi. Biraz sonra yeniden deneyin.",
  "bell.unread": "Okunmadı",
  "bell.newToast": "Yeni bildirim: {title}",

  // "Bu nedir?" balonları (kısa, sade; 240 karakteri geçmez)
  "help.novelty":
    "Yenilik puanı, işletmenin yeni açılmış olma olasılığını gösterir. Google bilgilerinden hesaplanan bir ipucudur, kesin kanıt değildir.",
  "help.noveltyLabels":
    "Mor: yakında açılacak. Yeşil: büyük olasılıkla yeni. Sarı: belki yeni. Gri: yeni olduğuna dair işaret zayıf.",
  "help.noveltyThresholds":
    'Puan bu eşiklerin üstündeyse işletme "Yüksek" ya da "Muhtemel" olarak etiketlenir. Eşikleri düşürmek daha çok ama daha az kesin sonuç verir.',
  "help.budget":
    "Google aramalarına bu ay harcanabilecek en yüksek tutar. Sınıra gelince taramalar kendiliğinden durur; kesin tutar Google faturanızdır.",
  "help.mapId":
    "Google haritasının görünümünü (ör. koyu stil) belirleyen kod. Boş bırakırsanız Google'ın varsayılan haritası kullanılır.",
  "help.leadStatus":
    "İşletmeyle ilişkinizin aşaması: yeni, e-postası bulundu, gönderildi, yanıt verdi ve benzeri. Gönderim ve yanıtlarla kendiliğinden güncellenir.",
  "help.dailyCap":
    "Bu kampanyadan bir günde gönderilecek en çok e-posta. Düşük sayı, e-posta adresinizin itibarını korur ve spam'e düşme riskini azaltır.",
  "help.sendGap":
    "İki e-posta arasında beklenecek süre. Rastgele aralıklar, gönderimin insan eliyle yapılmış gibi doğal görünmesini sağlar.",
  "help.sendWindow":
    "E-postaların gönderilebileceği gün ve saatler. Saatler alıcının yerel saatine göredir.",
  "help.preflight":
    "Kampanya başlamadan önce yapılan denetim: posta kutusu bağlı mı, şablon eksiksiz mi, alıcılar engelli mi gibi sorunları önceden gösterir.",
  "help.sequenceStatus":
    "Her alıcının kampanyadaki durumu: sırada, gönderildi, yanıt verdi, durduruldu. Yanıt gelen alıcıya takip e-postası gönderilmez.",
  "help.policyMode":
    "Ülkeye göre gönderim kuralı. İzinli: uygun adreslere gönderilir. Yalnızca genel adres: yalnızca info@ gibi şirket adreslerine. Engelli: bu ülkeye hiç gönderilmez.",
  "help.suppression":
    "Engelleme listesindeki adreslere ve alan adlarına hiçbir kampanyadan e-posta gitmez. Abonelikten çıkanlar buraya kendiliğinden eklenir.",
  "help.erasure":
    "Silme talebi, bir kişinin bilgilerini kalıcı olarak siler ve adresini engelleme listesine ekler. Geri alınamaz.",
  "help.audit":
    "Uygulamada yapılan önemli işlemlerin kaydı: ayar değişiklikleri, gönderim kararları, silme talepleri. Kayıtlar değiştirilemez.",
  "help.dns":
    "SPF, DKIM ve DMARC, alan adınızın e-postalarını sizin gönderdiğinizi kanıtlayan kayıtlardır. Gmail adreslerinde bunları Google yönetir.",
  "help.bounceRate":
    "Teslim edilemeyen e-postaların oranı. Bu oran yükselirse gönderim itibarınızı korumak için gönderim kendiliğinden durdurulur.",

  // Boş durumlar
  "sup.empty.none.title": "Engelleme listesi boş",
  "sup.empty.none.body":
    "Buraya eklenen adreslere ve alan adlarına hiç e-posta gönderilmez. Abonelikten çıkanlar ve silme talepleri buraya kendiliğinden eklenir.",
  "sup.empty.clear": "Süzgeçleri temizle",
  "audit.empty.body":
    "Ayar değişiklikleri, gönderim kararları ve silme talepleri yapıldıkça burada listelenir.",
  "erasure.history.empty.body":
    "Bir kişi bilgilerinin silinmesini istediğinde talebi yukarıdan kaydedin; tamamlanan talepler burada görünür.",
  "templates.empty.none.title": "Henüz şablon yok",
  "templates.empty.none.body":
    "Şablon, kampanyada gönderilecek e-postanın konusu ve metnidir. İlk şablonunuzu oluşturun.",
  "templates.empty.clear": "Süzgeçleri temizle",

  // API hata kodları → kullanıcı metni (sunucu kodu gönderir, arayüz yerelleştirir)
  "apiError.generic": "İşlem tamamlanamadı. Yeniden deneyin; sürerse uygulamayı kapatıp açın.",
  "apiError.HTTP": "İstek başarısız ({status}).",
  "apiError.NETWORK":
    "Uygulamanın yerel sunucusuna ulaşılamadı. Birkaç saniye bekleyip yeniden deneyin.",
  "apiError.BAD_REQUEST": "İstek kabul edilmedi. Girdiğiniz bilgileri kontrol edin.",
  "apiError.VALIDATION": "Girilen bilgilerde bir sorun var. Alanları kontrol edip yeniden deneyin.",
  "apiError.BAD_JSON": "Bilgiler gönderilemedi. Sayfayı yenileyip yeniden deneyin.",
  "apiError.INVALID_ID": "Geçersiz kayıt numarası. Sayfayı yenileyip yeniden deneyin.",
  "apiError.UNAUTHORIZED": "Bu işlem için yetki yok.",
  "apiError.FORBIDDEN": "Bu işleme izin verilmiyor.",
  "apiError.NOT_FOUND": "Kayıt bulunamadı. Silinmiş olabilir; sayfayı yenileyin.",
  "apiError.CONFLICT": "Bu işlem şu anki durumla çakışıyor. Sayfayı yenileyip yeniden deneyin.",
  "apiError.RATE_LIMITED": "Çok sık deneme yapıldı. Biraz bekleyip yeniden deneyin.",
  "apiError.UPSTREAM": "Dış hizmetten beklenmeyen bir yanıt geldi. Biraz sonra yeniden deneyin.",
  "apiError.UNAVAILABLE": "Hizmet geçici olarak kullanılamıyor. Biraz sonra yeniden deneyin.",
  "apiError.INTERNAL":
    "Beklenmeyen bir hata oluştu. Yeniden deneyin; sürerse uygulamayı kapatıp açın.",
  "apiError.DB_BUSY": "Veritabanı şu an meşgul. Birkaç saniye sonra yeniden deneyin.",
  "apiError.DB_NOT_READY": "Veritabanı hazırlanıyor. Birkaç saniye sonra yeniden deneyin.",
  "apiError.SETUP_REQUIRED": "Önce kurulum sihirbazını tamamlayın.",
  "apiError.PLACES_KEY_MISSING": "Google Places API anahtarı tanımlı değil. Ayarlar'dan ekleyin.",
  "apiError.BUDGET_BLOCKED": "Aylık bütçe sınırına ulaşıldı. Ayarlar'dan bütçeyi artırın.",
  "apiError.NEEDS_ACK":
    "Tahmini maliyet kalan bütçenizi aşabilir. Tarama bütçe dolunca kendiliğinden durur. Yine de başlatmak için onaylayın.",
  "apiError.COUNTRY_NOT_TARGETED":
    "Bu bölgenin ülkesi hedef pazarlarınız arasında değil. Ayarlar > Hedef pazarlar bölümünden ekleyin.",
  "apiError.ACTIVE_SCAN": "Aynı bölge için başka bir tarama sürüyor. Bitmesini bekleyin.",
  "apiError.PLAN_INVALID": "Tarama alanı uygun değil. Daha küçük bir alan seçin.",
  "apiError.MAP_ID_INVALID":
    "Geçersiz Harita Kimliği. Yalnızca harf, rakam, '_' ve '-' kullanın; e-posta adresi olamaz.",
  "apiError.PLACES_AUTH":
    "Google API anahtarı geçersiz ya da bu isteğe izin vermiyor. Anahtarı kontrol edin.",
  "apiError.PLACES_BILLING": "Google Cloud projesinde faturalandırma kapalı.",
  "apiError.PLACES_DISABLED": "'Places API (New)' bu projede etkin değil.",
  "apiError.PLACES_QUOTA": "Google kota sınırına ulaşıldı. Kota sıfırlanınca devam edebilirsiniz.",
  "apiError.PLACES_RATE": "Google istekleri geçici olarak yavaşlattı. Biraz sonra devam edin.",
  "apiError.PLACES_INVALID": "Google isteği reddetti.",
  "apiError.PLACES_NETWORK": "Google'a ulaşılamadı. İnternet bağlantınızı kontrol edin.",
  "apiError.PLACES_SERVER": "Google geçici bir sunucu hatası verdi. Biraz sonra yeniden deneyin.",
  "apiError.PLACES_UNKNOWN": "Google'dan beklenmeyen bir yanıt alındı.",
  "apiError.INVALID_INPUT": "Girilen bilgilerde bir sorun var. Alanları kontrol edin.",
  "apiError.INVALID_EMAIL": "Geçerli bir e-posta adresi girin.",
  "apiError.DUPLICATE": "Bu kayıt zaten var.",
  "apiError.LIVE_LOCKED": "Bu ayar canlı gönderim açıkken değiştirilemez.",
  "apiError.UNCONFIRMED": "Devam etmek için işlemi onaylayın.",
  "apiError.CONFIRMATION_REQUIRED": "Devam etmek için işlemi onaylayın.",
  "apiError.IN_USE": "Bu kayıt kullanımda olduğu için değiştirilemez.",
  "apiError.BUILT_IN": "Yerleşik kayıtlar değiştirilemez. Önce kopyasını oluşturun.",
  "apiError.ARCHIVED": "Arşivlenmiş kayıt değiştirilemez.",

  "apiError.NEEDS_ACK.detail":
    "Yüksek tahmin ({highUsd}) kalan bütçenizi ({remainingUsd}) aşabilir. Tarama bütçe dolunca kendiliğinden durur. Yine de başlatmak için onaylayın.",
  // Alan hataları (domain-route ve uç kodları; Faz 4 inceleme)
  "apiError.NOT_CONFIGURED":
    "Bu işlem için gereken ayarlar henüz yapılmadı. Önce çıkış adresini ve anahtarları tanımlayın.",
  "apiError.CHANNEL_KEY_UNREADABLE":
    "Kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlanmış olabilir). Kanal anahtarında “Yeni anahtara geç”i seçin ve anahtar dosyasını yeniden yükleyin.",
  "apiError.KEY_UNREADABLE":
    "Etkin imza veya kanal anahtarının özel anahtarı okunamıyor (gizli bilgiler sıfırlanmış olabilir). İlgili anahtarda “Yeni anahtara geç”i seçin, sonra dosyayı indirin.",
  "apiError.NOT_SENDABLE": "Şablon gönderime hazır değil. Şablondaki sorunları düzeltin.",
  "apiError.INVALID_SELECTOR": "Geçersiz DKIM seçici adı.",
  "apiError.NO_DOMAIN": "Denetlenecek bir alan adı yok.",
  "apiError.NO_SENT_MESSAGE": "Bu alıcıya henüz gönderilmiş bir ileti yok.",
  "apiError.INVALID_TOKEN": "Bu bağlantı geçersiz.",
  "apiError.INVALID_PARAM": "Geçersiz sorgu parametresi. Sayfayı yenileyip yeniden deneyin.",
  "apiError.INVALID_TEMPLATE": "Şablon kaydedilemedi: gösterilen sorunları düzeltin.",
  "apiError.UNKNOWN_CATEGORY": "Bilinmeyen kategori.",
  "apiError.UNKNOWN_COUNTRY": "Desteklenmeyen ülke kodu.",
  "apiError.INVALID_MODE": "Geçersiz politika modu.",
  "apiError.NO_POLICY": "Bu ülke için tanımlı bir politika yok.",
  "apiError.LOOSENING_FORBIDDEN": "Bu ayar yalnızca sıkılaştırılabilir; gevşetilemez.",
  "apiError.BELOW_FLOOR": "Değer izin verilen alt sınırın altına inemez.",
  "apiError.INVALID_DOMAIN": "Geçersiz alan adı.",
  "apiError.PUBLIC_SUFFIX":
    "Genel bir uzantı (ör. co.uk) tek başına engellenemez; tam alan adını yazın.",
  "apiError.INVALID_REASON": "Geçersiz engelleme nedeni.",
  "apiError.ALREADY_LIFTED": "Bu engel zaten kaldırılmış.",
  "apiError.PROTECTED": "Bu kayıt korumalı olduğu için kaldırılamaz.",
  "apiError.IN_FLIGHT": "Bu adres için süren bir işlem var. Bitince yeniden deneyin.",
  "apiError.NOT_APPROVED": "Bu işlem için gereken onay verilmedi.",
  "apiError.NOT_HALTED": "Bu posta kutusu durdurulmamış.",
  "apiError.STILL_EXCEEDED": "Sınır hâlâ aşılıyor; posta kutusu henüz yeniden başlatılamaz.",
  "apiError.RESERVED_DOMAIN": "Bu alan adı ayrılmış bir alan adı. Gerçek bir alan adı kullanın.",
  "apiError.INVALID_CLIENT": "İstemci kimliği veya istemci sırrı geçerli biçimde değil.",
  "apiError.LIMIT": "Posta kutusu sınırına ulaşıldı.",
  "apiError.NOT_EDITABLE":
    "Bu kayıt şu anki durumunda değiştirilemez (ör. demo posta kutusu veya başlamış bir kampanya).",
  "apiError.INVALID_STATUS": "Posta kutusu bu işlem için uygun durumda değil.",
  "apiError.MAILBOX_NOT_FOUND": "Posta kutusu bulunamadı.",
  "apiError.MAILBOX_NOT_READY": "Posta kutusu hazır değil.",
  "apiError.SEND_SCOPE_MISSING": "Gönderim izni verilmemiş. Posta kutusunu yeniden bağlayın.",
  "apiError.PROFILE_INCOMPLETE": "Firma profili eksik veya geçersiz. Ayarlar'dan tamamlayın.",
  "apiError.IN_PROGRESS": "Bu kutuda süren bir test gönderimi var.",
  "apiError.BUILD_FAILED": "Test iletisi oluşturulamadı.",
  "apiError.LIVE_SCOPE": "Bu işlem canlı kapsamda yapılamaz.",
  "apiError.CLIENT_NOT_CONFIGURED":
    "Google OAuth istemcisi tanımlı değil. Önce istemci kimliğini ve sırrını girin.",
  "apiError.NOT_GMAIL": "Bu işlem yalnızca Gmail kutuları içindir.",
  "apiError.INVALID_STATE":
    "Yetkilendirme isteği geçersiz veya zaten kullanılmış. Yeniden başlatın.",
  "apiError.EXPIRED": "Yetkilendirme isteğinin süresi doldu; yeniden başlatın.",
  "apiError.ACCESS_DENIED": "İzin verilmedi.",
  "apiError.SCOPE_MISSING": "Gönderim izni verilmedi. Yeniden bağlanıp gönderime izin verin.",
  "apiError.SCOPE_EXCESS": "Beklenmeyen izinler verildi; bağlantı reddedildi.",
  "apiError.ACCOUNT_MISMATCH":
    "Farklı bir Google hesabıyla giriş yapıldı. Kutunun adresiyle aynı hesabı seçin.",
  "apiError.TOKEN_EXCHANGE_FAILED": "Google yetkilendirmeyi tamamlayamadı. Yeniden deneyin.",
  "apiError.INVALID_RESPONSE": "Google'dan beklenmeyen bir yanıt alındı.",
  "apiError.NO_REFRESH_TOKEN": "Google kalıcı yetki vermedi; yeniden deneyin.",
  "apiError.NOT_CONNECTED": "Posta kutusu bağlı değil.",
  "apiError.REAUTHORIZATION_REQUIRED":
    "Yeniden yetkilendirme gerekli. Posta kutusunu yeniden bağlayın.",
  "apiError.TRANSIENT": "Google'a ulaşılamadı; biraz sonra yeniden deneyin.",
  "apiError.NOT_REVIEWABLE": "Bu ileti incelemede değil.",
  "apiError.CANNOT_APPLY": "Bu ileti türü için yalnızca 'yok say' seçilebilir.",
  "apiError.NO_ENDPOINT": "Çıkış uç noktası yapılandırılmadı.",
  "apiError.NOT_VERIFIED": "Çıkış uç noktası doğrulanmadı.",
  "apiError.NO_KEY": "Etkin imza anahtarı yok.",
  "apiError.LEAD_UNAVAILABLE": "Bu alıcı için çıkış bağlantısı üretilemedi.",
  "apiError.INVALID_URL": "Yol veya sorgu içermeyen güvenli bir HTTPS adresi gerekir.",
  "apiError.TOO_MANY": "En çok 50 alan adı girilebilir.",
  "apiError.CHANNEL_INSECURE_URL": "Çıkış adresi güvenli bir HTTPS adresi olmalıdır.",
  "apiError.CHANNEL_HTTP_ERROR": "Çıkış sunucusu isteği reddetti.",
  "apiError.CHANNEL_BAD_RESPONSE": "Çıkış sunucusundan beklenmeyen bir yanıt geldi.",
  "apiError.CHANNEL_NETWORK": "Çıkış sunucusuna ulaşılamadı.",
  "apiError.CHANNEL_TIMEOUT": "Çıkış sunucusu zamanında yanıt vermedi.",
  // Faz 4 entegrasyonu: paketlerin eklediği kodlar (tests/api-error-text.test.ts hepsini denetler)
  "apiError.PLACES_NOT_FOUND": "Bu işletme Google'da artık bulunamıyor. Kaydınız silinmedi.",
  "apiError.FILTER_INVALID":
    "Süzgeç değerlerinden biri geçersiz. Süzgeçleri temizleyip yeniden seçin.",
  "apiError.INVALID_QUERY": "Gösterge paneli isteği geçersiz. Sayfayı yenileyin.",
  "apiError.NOTHING_MATCHED":
    "Seçimde işlenecek işletme kalmadı. Liste değişmiş olabilir; sayfayı yenileyip yeniden seçin.",
  "apiError.LEAD_UNBLOCK_CONFIRM":
    "Bu işletme “İletişime geçme” olarak işaretli. Durumunu değiştirmek için onay vermeniz gerekir.",
  "apiError.RDAP_DISABLED": "Alan adı yaşı denetimi kapalı. Ayarlar > Yenilik bölümünden açın.",
  "apiError.SAVED_FILTER_NOT_FOUND": "Kayıtlı süzgeç bulunamadı. Silinmiş olabilir.",
  "apiError.SAVED_FILTER_EXISTS": "Bu adla kayıtlı bir süzgeç zaten var. Başka bir ad seçin.",
  "apiError.SAVED_FILTER_LIMIT": "Kayıtlı süzgeç sınırına ulaşıldı. Kullanmadığınız birini silin.",
  "apiError.SAVED_FILTER_LIMIT.detail":
    "En çok {limit} süzgeç kaydedilebilir. Kullanmadığınız birini silip yeniden deneyin.",
  "apiError.SCHEDULE_NOT_FOUND": "Zamanlama bulunamadı. Silinmiş olabilir.",
  "apiError.SCAN_NOT_FOUND": "Tarama bulunamadı.",
  "apiError.SCAN_NOT_STARTED": "Henüz başlatılmamış bir tarama düzenli tekrarlanamaz.",
  "apiError.SCHEDULE_EXISTS": "Bu bölge ve kategoriler için zaten bir zamanlama var.",
  "apiError.RACE":
    "Zamanlama şu anda başka bir çalışma tarafından güncellendi. Birkaç saniye sonra yeniden deneyin.",
  "apiError.CAP_ABOVE_PROVIDER_MAX": "Günlük sınır bu posta kutusu türünün üst sınırını aşıyor.",
  "apiError.CAP_ABOVE_PROVIDER_MAX.detail":
    "Bu posta kutusu için günlük sınır en çok {max} olabilir.",
  "apiError.WARMUP_STEP_ABOVE_MAX": "Haftalık artış bu posta kutusu türünün üst sınırını aşıyor.",
  "apiError.WARMUP_STEP_ABOVE_MAX.detail":
    "Bu posta kutusu için haftalık artış en çok {max} olabilir.",
  "apiError.INVALID_STEPS": "Kampanya adımlarında bir sorun var. Adımları kontrol edip kaydedin.",
  "apiError.INVALID_TRANSITION": "Kampanya bu durumdayken bu işlem yapılamaz. Sayfayı yenileyin.",
  "apiError.LIVE_DISABLED": "Gerçek gönderim kapalı. Kampanya yalnızca demo modunda çalışabilir.",
  "apiError.SCHEDULER_DISABLED":
    "Gönderim zamanlayıcısı kapalı. Kampanyayı başlatmak için önce zamanlayıcıyı açın.",
  "apiError.PREFLIGHT_FAILED":
    "Kampanya henüz hazır değil. Ön denetim listesindeki eksikleri giderip yeniden deneyin.",
  "apiError.PREFLIGHT_STALE":
    "Ön denetimden sonra kampanya değişti. Ön denetimi yeniden çalıştırın.",
  "apiError.ALREADY_RESOLVED": "Bu gönderim için daha önce farklı bir karar verilmiş.",
  "apiError.NOT_UNCERTAIN": "Bu gönderimin sonucu zaten kesin; karar gerekmiyor.",
  "apiError.NO_SEQUENCE": "Bu gönderim bir kampanya dizisine bağlı değil.",

  // Google işletme türleri (format.ts typeLabel)
  "placeType.cafe": "Kafe",
  "placeType.coffee_shop": "Kahveci",
  "placeType.tea_house": "Çay evi",
  "placeType.pub": "Pub",
  "placeType.bar": "Bar",
  "placeType.wine_bar": "Şarap bar",
  "placeType.night_club": "Gece kulübü",
  "placeType.restaurant": "Restoran",
  "placeType.fast_food_restaurant": "Fast food",
  "placeType.meal_takeaway": "Paket servis",
  "placeType.meal_delivery": "Eve teslim",
  "placeType.bakery": "Fırın",
  "placeType.dessert_shop": "Tatlıcı",
  "placeType.ice_cream_shop": "Dondurmacı",
  "placeType.hotel": "Otel",
  "placeType.hostel": "Hostel",
  "placeType.bed_and_breakfast": "Pansiyon",
  "placeType.catering_service": "Catering",
  "placeType.event_venue": "Etkinlik mekânı",
  "placeType.wedding_venue": "Düğün salonu",
  "placeType.hospital": "Hastane",
  "placeType.dental_clinic": "Diş kliniği",
  "placeType.physiotherapist": "Fizyoterapi",
  "placeType.child_care_agency": "Kreş",
  "placeType.preschool": "Anaokulu",
  "placeType.school": "Okul",
  "placeType.university": "Üniversite",
  "placeType.corporate_office": "Ofis",
  "placeType.coworking_space": "Ortak çalışma",
  "placeType.gym": "Spor salonu",
  "placeType.beauty_salon": "Güzellik salonu",
  "placeType.hair_salon": "Kuaför",
  "placeType.spa": "Spa",
  "placeType.gas_station": "Benzinlik",
  "placeType.convenience_store": "Market",
  "placeType.cafeteria": "Kantin",

  // Kategori setleri (sunucu `key` gönderir; ad arayüzde yerelleştirilir)
  "category.cafe": "Kafe / kahveci",
  "category.pub": "Bar / pub",
  "category.restaurant": "Restoran / paket servis",
  "category.bakery": "Fırın / pastane / tatlıcı",
  "category.hotel": "Otel / hostel / pansiyon",
  "category.catering": "Catering / etkinlik mekânı",
  "category.health": "Hastane / klinik / diş",
  "category.education": "Kreş / okul / üniversite",
  "category.office": "Ofis / ortak çalışma alanı",
  "category.wellness": "Spor salonu / güzellik / spa",
  "category.convenience": "Benzinlik market / büfe / kantin",

  // Yenilik gerekçeleri (sinyal kimliğine göre; saklanan Türkçe metin yalnızca yedek)
  "noveltySignal.future_opening":
    'Google bu işletmeyi "yakında açılacak" olarak bildiriyor. Tedarikçi aradığı anlamına gelmez.',
  "noveltySignal.opened_transition":
    '"Yakında açılacak" iken artık faaliyette olarak görüldü (son {days} gün içinde).',
  "noveltySignal.new_in_snapshot":
    "Önceki taramada yoktu, son taramada bulundu (son {days} gün içinde). Gerçek açılış tarihini kanıtlamaz.",
  "noveltySignal.reviews_very_few": "Çok az değerlendirme var. Tek başına yeni olduğunu göstermez.",
  "noveltySignal.reviews_few": "Az sayıda değerlendirme var. Düşük güvenilirlikte bir gösterge.",

  // Masaüstü kabuğu (Electron menüleri ve yerel iletişim kutuları)
  "electron.menu.view": "Görünüm",
  "electron.menu.help": "Yardım",
  "electron.menu.openData": "Veri klasörünü aç",
  "electron.menu.openLogs": "Günlük klasörünü aç",
  "electron.unsaved.title": "Kaydedilmemiş değişiklikler",
  "electron.unsaved.message": "Kaydedilmemiş değişiklikler kaybolsun mu?",
  "electron.unsaved.detail":
    "Bu sayfada kaydetmediğiniz değişiklikler var. Devam ederseniz bu değişiklikler kaybolur.",
  "electron.unsaved.discard": "Değişiklikleri at",
  "electron.unsaved.keep": "Düzenlemeye dön",
  "electron.quitScan.title": "Tarama sürüyor",
  "electron.quitScan.message": "Bir tarama sürüyor.",
  "electron.quitScan.detail":
    "Uygulamayı kapatırsanız tarama duraklatılır. Uygulamayı açtığınızda kaldığı yerden devam ettirebilirsiniz; ücretli çağrılar siz onaylamadan sürmez.",
  "electron.quitScan.quit": "Kapat ve duraklat",
  "electron.quitScan.cancel": "Vazgeç",
  "electron.keystore.title": "Güvenli depolama kullanılamıyor",
  "electron.keystore.body":
    "İşletim sisteminin anahtar deposu (Anahtarlık / Kimlik Bilgisi Yöneticisi) bu oturumda kullanılamıyor. API anahtarlarınız güvenli saklanamayacağı için uygulama kapatılıyor.",
  "electron.startError.title": "Universal Mail başlatılamadı",
  "electron.startError.logDir": "Günlük klasörü: {dir}",
  "electron.deliveryAlert.title": "Çıkış bağlantısı uyarısı",
  "electron.deliveryAlert.body":
    "Abonelikten çıkma talepleri işlenmiyor olabilir. Ayrıntılar için Uyum sayfasına bakın.",
} as const;
