/** Türkçe arayüz metinleri. İngilizce (en.ts) Faz 4'te eklenir; anahtarlar değişmez. */
export const tr = {
  // Genel
  "common.add": "Ekle",
  "common.cancel": "Vazgeç",
  "common.delete": "Sil",
  "common.error": "Bir sorun oluştu.",
  "common.loading": "Yükleniyor…",
  "common.save": "Kaydet",
  "common.saved": "Kaydedildi",
  "common.updating": "Güncelleniyor…",

  // Gezinme ve üst çubuk
  "nav.label": "Ana gezinme",
  "nav.explore": "Keşif",
  "nav.scans": "Taramalar",
  "nav.settings": "Ayarlar",
  "budget.label": "Bütçe",
  "budget.tip":
    "Bu ay ({month}) tahmini Google harcaması: {spent} / bütçe {limit}. Kesin tutar Google Cloud faturanızdır.",
  "provider.demo": "DEMO",
  "provider.demo.tip": "Demo modu: işletmeler yapay verilerdir, Google'a istek atılmaz.",

  // Yenilik etiketleri
  "novelty.future_opening": "Yakında açılacak",
  "novelty.high": "Yüksek yenilik",
  "novelty.likely": "Muhtemel yeni",
  "novelty.low": "Düşük yenilik",

  // Durumlar
  "businessStatus.OPERATIONAL": "Faaliyette",
  "businessStatus.FUTURE_OPENING": "Yakında açılacak",
  "businessStatus.CLOSED_TEMPORARILY": "Geçici olarak kapalı",
  "businessStatus.CLOSED_PERMANENTLY": "Kalıcı olarak kapalı",
  "businessStatus.BUSINESS_STATUS_UNSPECIFIED": "Belirtilmemiş",
  "leadStatus.new": "Yeni",
  "leadStatus.enriched": "Zenginleştirildi",
  "leadStatus.queued": "Kuyrukta",
  "leadStatus.sent": "Gönderildi",
  "leadStatus.replied": "Yanıtladı",
  "leadStatus.not_interested": "İlgilenmiyor",
  "leadStatus.customer": "Müşteri oldu",
  "leadStatus.do_not_contact": "İletişime geçme",
  "scanStatus.draft": "Taslak",
  "scanStatus.queued": "Sırada",
  "scanStatus.running": "Çalışıyor",
  "scanStatus.paused": "Duraklatıldı",
  "scanStatus.completed": "Tamamlandı",
  "scanStatus.failed": "Başarısız",
  "scanStatus.cancelled": "İptal edildi",
  "scanStatus.budget_stopped": "Bütçe doldu",
  "unitStatus.queued": "Bekleyen",
  "unitStatus.running": "Süren",
  "unitStatus.done": "Biten",
  "unitStatus.failed": "Başarısız",

  // Keşif ekranı
  "explore.panel": "Sol panel",
  "explore.tab.list": "İşletmeler",
  "explore.tab.scan": "Yeni tarama",
  "explore.pane.list": "Liste",
  "explore.pane.map": "Harita",
  "explore.map": "Harita",
  "explore.resize": "Panel genişliğini ayarla",

  // Süzgeçler
  "filters.search": "İşletme, adres veya şehir ara",
  "filters.clear": "Temizle",
  "filters.novelty": "Yenilik",
  "filters.country": "Ülke",
  "filters.city": "Şehir",
  "filters.cityPlaceholder": "Şehirde ara",
  "filters.allCities": "Tüm şehirler",
  "filters.category": "Kategori",
  "filters.businessStatus": "İşletme durumu",
  "filters.leadStatus": "Lead durumu",
  "filters.more": "Diğer",
  "filters.website": "Web sitesi",
  "filters.website.any": "Fark etmez",
  "filters.website.yes": "Web sitesi alınmış",
  "filters.website.no": "Web sitesi yok / alınmamış",
  "filters.hideNotFound": "Son taramada bulunamayanları gizle",
  "filters.onlyInView": "Yalnızca haritadakiler",
  "filters.scan": "Tarama #{id}",
  "filters.noData": "Henüz veri yok",
  "filters.noOptions": "Seçenek yok",

  // Liste
  "list.count": "{n} işletme",
  "list.sort": "Sıralama",
  "list.sort.novelty": "Yenilik skoru",
  "list.sort.recent": "En yeni tespit",
  "list.sort.name": "Ad (A–Z)",
  "list.score": "Yenilik skoru",
  "list.opens": "Açılış:",
  "list.soon": "yakında",
  "list.newDetected": "Yeni tespit edildi",
  "list.justOpened": "Yeni açıldı",
  "list.notFound": "Son taramada bulunamadı",
  "list.website": "Web sitesi",
  "list.empty.title": "Henüz işletme yok",
  "list.empty.body":
    "İlk taramanı başlat; bulunan işletmeler burada listelenir ve haritada görünür.",
  "list.empty.cta": "İlk taramayı başlat",
  "list.empty.filtered.title": "Bu süzgeçlere uyan işletme yok",
  "list.empty.filtered.body":
    "Süzgeçleri gevşetmeyi veya haritada başka bir alana bakmayı deneyin.",

  // Ayrıntı paneli
  "detail.back": "Listeye dön",
  "detail.noPlace": "Bu lead için Google işletme kaydı yok.",
  "detail.openMaps": "Google Haritalar'da aç",
  "detail.enrich": "Zenginleştir",
  "detail.enrich.again": "Yeniden zenginleştir",
  "detail.enrich.title": "İşletmeyi zenginleştir",
  "detail.enrich.body":
    "Web sitesi, telefon ve değerlendirme sayısı Google'dan alınır (Place Details Enterprise). Bu çağrı ücretli kotanızdan düşer.",
  "detail.enrich.places": "İşletme sayısı",
  "detail.enrich.cost": "Tahmini maliyet",
  "detail.enrich.free": "ücretsiz kota içinde",
  "detail.enrich.remaining": "Kalan aylık bütçe",
  "detail.enrich.confirm": "Zenginleştir",
  "detail.enrich.queued": "Zenginleştirme kuyruğa alındı.",
  "detail.why": "Neden bu skor?",
  "detail.why.help":
    "Skor, işletmenin yeni açılmış olma ihtimalini gösterir. Birden çok ipucundan hesaplanır; kesin açılış tarihi değildir.",
  "detail.why.none":
    "Henüz yenilik ipucu yok. İkinci taramada veya zenginleştirmeden sonra değişebilir.",
  "detail.why.disclaimer":
    "Bu skor bir olasılık göstergesidir; işletmenin kesin olarak yeni açıldığını veya eskiden beri var olduğunu garanti etmez.",
  "detail.info": "Bilgiler",
  "detail.businessStatus": "Durum",
  "detail.website": "Web sitesi",
  "detail.phone": "Telefon",
  "detail.ratings": "Değerlendirme",
  "detail.none": "Bulunamadı",
  "detail.notFetched": "Henüz alınmadı",
  "detail.stale":
    "Google'dan alınan veriler {days} günden eski. Google şartları gereği bayatlayabilir; güncel hâli için yeniden tarayın veya zenginleştirin.",
  "detail.manage": "Lead yönetimi",
  "detail.status": "Durum",
  "detail.tags": "Etiketler",
  "detail.tagPlaceholder": "Etiket ekle ve Enter'a bas",
  "detail.removeTag": "{tag} kaldır",
  "detail.notes": "Notlar",
  "detail.notesPlaceholder": "Bu işletmeyle ilgili notlarınız…",
  "detail.timeline": "Zaman çizelgesi",
  "detail.tl.detected": "İlk tespit edildi",
  "detail.tl.new": "Yeni olarak işaretlendi",
  "detail.tl.opened": "Açıldığı görüldü",
  "detail.tl.enriched": "Zenginleştirildi",

  // Harita
  "map.loading": "Harita yükleniyor…",
  "map.fit": "Sonuçlara sığdır",
  "map.marker": "İşletme",
  "map.cluster": "{n} işletme (yakınlaştırmak için tıklayın)",
  "map.legend": "Harita göstergesi",
  "map.legend.contacted": "Temas kuruldu",
  "map.truncated":
    "Çok fazla sonuç var; harita ilk 20.000 işletmeyi gösteriyor. Süzgeçlerle daraltın.",
  "map.draw.rect": "Haritada sürükleyerek bir dikdörtgen çizin",
  "map.draw.circle": "Merkezden dışa sürükleyerek bir daire çizin",
  "map.noKey.title": "Harita için Google anahtarı gerekli",
  "map.noKey.body":
    "Google Maps JavaScript API tarayıcı anahtarını Ayarlar'dan girin. Anahtar olmadan liste çalışır, harita gösterilemez.",
  "map.noKey.cta": "Ayarlar'a git",
  "map.authError.title": "Harita yüklenemedi",
  "map.authError.body":
    "Google anahtarınız reddedildi. Anahtarın doğruluğunu, 'Maps JavaScript API'nin etkin olduğunu, faturalandırmanın açık olduğunu ve anahtar kısıtlarını kontrol edin.",
  "map.schematic.banner":
    "Şematik demo görünümü · Gerçek harita için Ayarlar'dan Google Maps anahtarı ekleyin",
  "map.schematic.label": "Şematik demo haritası",

  // Tarama oluşturucu
  "builder.title": "Yeni tarama",
  "builder.subtitle":
    "Bir bölge ve kategoriler seçin; başlamadan önce tahmini maliyeti görürsünüz.",
  "builder.region": "1 · Bölge",
  "builder.mode.city": "Şehir seç",
  "builder.mode.draw": "Haritada çiz",
  "builder.country": "Ülke",
  "builder.allTargets": "Tüm hedef pazarlar",
  "builder.city": "Şehir",
  "builder.cityPlaceholder": "Örn. Londra, Amsterdam",
  "builder.noCity": "Şehir bulunamadı. Haritada çizerek bölge belirleyebilirsiniz.",
  "builder.radius": "Merkez yarıçapı",
  "builder.radius.help":
    "Şehir merkezinden ne kadar uzağa taranacağı. Büyük yarıçap daha çok çağrı demektir.",
  "builder.draw.rect": "Dikdörtgen çiz",
  "builder.draw.circle": "Daire çiz",
  "builder.draw.hint":
    "Bir şekil seçip haritada sürükleyin. Çizdikten sonra tutamaçlardan düzenleyebilirsiniz.",
  "builder.draw.name": "Alanın adı",
  "builder.draw.edit":
    "Haritadaki köşelerden veya kenarlardan sürükleyerek alanı değiştirebilirsiniz.",
  "builder.categories": "2 · Kategoriler",
  "builder.queries": "sorgu",
  "builder.keywords": "Ek anahtar kelimeler",
  "builder.keywords.help":
    "Yerel dilde arama ifadeleri ekleyebilirsiniz (örn. 'kahvaltı salonu', 'kokoreççi'). Her kelime ayrı bir sorgudur.",
  "builder.keywordsPlaceholder": "Kelime yaz ve Enter'a bas",
  "builder.advanced": "Gelişmiş ayarlar",
  "builder.strategy": "Arama yöntemi",
  "builder.strategy.help":
    "Metin araması çağrı başına 60'a kadar sonuç verir (önerilir). Yakın çevre araması çağrı başına en fazla 20 sonuç verir ama birden çok türü tek çağrıda arar.",
  "builder.strategy.text": "Metin araması (önerilen)",
  "builder.strategy.nearby": "Yakın çevre araması",
  "builder.enrich": "Taramada web sitesi ve telefonu da al",
  "builder.enrich.help":
    "Her sonuç için web sitesi, telefon ve değerlendirme sayısı da istenir. Bu alanlar daha pahalı fiyat sınıfındadır.",
  "builder.enrich.note":
    "Kapalı kalması önerilir; yalnızca ilgilendiğiniz işletmeleri sonradan zenginleştirmek daha ucuzdur.",
  "builder.estimate": "3 · Tahmini maliyet",
  "builder.estimate.help":
    "Tahmin; kaç Google çağrısı gerekeceğini ve ücretsiz kotanın ardından ne tutar ödeneceğini gösterir. Yoğun bölgeler otomatik bölündüğü için gerçek kullanım farklı olabilir.",
  "builder.estimate.empty": "Bir bölge ve en az bir kategori seçin.",
  "builder.estimate.calls": "Google çağrısı",
  "builder.estimate.cost": "Tahmini ücret",
  "builder.estimate.worst": "en kötü {v}",
  "builder.estimate.cells": "Kapsam",
  "builder.estimate.cellsUnit": "hücre",
  "builder.estimate.free": "Bu ay kalan ücretsiz",
  "builder.estimate.callsUnit": "çağrı",
  "builder.estimate.budget": "Aylık bütçe",
  "builder.start": "Taramayı başlat",
  "builder.started": "Tarama #{id} başlatıldı.",
  "builder.ack.title": "Bütçeyi aşabilir",
  "builder.ack.confirm": "Yine de başlat",

  // Tarama durum şeridi
  "strip.running": "Tarama #{id} sürüyor",
  "strip.paused": "Tarama #{id} duraklatıldı",
  "strip.budgetStopped": "Tarama #{id} bütçe dolduğu için durdu",
  "strip.stats": "{found} işletme · {calls} çağrı · {future} yakında açılacak",
  "strip.raiseBudget": "Bütçeyi artır",

  // Taramalar sayfası
  "scans.title": "Taramalar",
  "scans.subtitle":
    "Geçmiş ve sürmekte olan taramalar. Aynı bölgeyi daha sonra yeniden taradığınızda önceki taramayla karşılaştırılır ve yeni işletmeler işaretlenir.",
  "scans.new": "Yeni tarama",
  "scans.pause": "Duraklat",
  "scans.resume": "Devam et",
  "scans.cancel": "İptal et",
  "scans.show": "Sonuçları göster",
  "scans.rerun": "Yeniden tara",
  "scans.rerun.title": "Aynı alanı yeniden tara",
  "scans.rerun.body":
    "Aynı bölge ve ayarlarla yeni bir tarama başlatılır ve öncekiyle karşılaştırılır. Önceki tarama {calls} çağrı yaptı (tahmini {cost}); bu tarama benzer miktarda kullanım gerektirir.",
  "scans.rerun.confirm": "Taramayı başlat",
  "scans.details": "Ayrıntılar",
  "scans.units": "birim",
  "scans.baseline": "Baz çizgi (ilk tarama)",
  "scans.compared": "Öncekiyle karşılaştırıldı",
  "scans.strategy.text": "Metin araması",
  "scans.strategy.nearby": "Yakın çevre araması",
  "scans.profile.enrich": "Zenginleştirmeli",
  "scans.stat.found": "Bulunan",
  "scans.stat.future": "Yakında açılacak",
  "scans.stat.future.hint": "Google'ın 'yakında açılacak' olarak bildirdiği işletmeler",
  "scans.stat.new": "Yeni tespit",
  "scans.stat.new.hint": "Önceki taramada olmayan işletmeler. İlk taramada karşılaştırma yoktur.",
  "scans.stat.calls": "Çağrı",
  "scans.stat.cost": "Tahmini ücret",
  "scans.stat.cost.hint":
    "Uygulamanın hesapladığı tahmindir; kesin tutar Google Cloud faturanızdır.",
  "scans.saturated": "{n} hücre yoğunluk nedeniyle bölündü",
  "scans.failedUnits": "Başarısız sorgular",
  "scans.compare.note":
    "Bir işletme 'bulunamadı' olarak işaretlenirse kapandığı anlamına gelmez; yalnızca son taramada görünmedi.",
  "scans.empty.title": "Henüz tarama yok",
  "scans.empty.body": "Bir şehir seçip kategorileri belirleyerek ilk taramanı başlat.",
  "scans.empty.cta": "İlk taramanı başlat",

  // Ayarlar
  "settings.title": "Ayarlar",
  "settings.subtitle": "Google bağlantısı, bütçe, hedef pazarlar ve firma bilgileri.",
  "settings.nav.label": "Ayar bölümleri",
  "settings.nav.google": "Google bağlantısı",
  "settings.nav.budget": "Bütçe",
  "settings.nav.markets": "Hedef pazarlar",
  "settings.nav.company": "Firma bilgileri",
  "settings.nav.categories": "Kategoriler",
  "settings.nav.novelty": "Yenilik eşikleri",
  "settings.nav.data": "Veri ve hakkında",
  "settings.google.title": "Google bağlantısı",
  "settings.google.desc":
    "İşletmeleri bulmak için Google Places API (New), haritayı göstermek için Maps JavaScript API kullanılır. Anahtarlar işletim sistemi korumalı şifreli depoda saklanır.",
  "settings.provider": "Veri kaynağı",
  "settings.provider.google": "Gerçek Google verisi",
  "settings.provider.google.desc":
    "Google Places API ile gerçek işletmeleri tarar. API anahtarı gerekir.",
  "settings.provider.mock": "Demo modu",
  "settings.provider.mock.desc":
    "Yapay işletmelerle uygulamayı anahtarsız dener. Google'a istek atılmaz.",
  "settings.placesKey": "Places API anahtarı (sunucu)",
  "settings.placesKey.help":
    "Google Cloud'da yalnızca 'Places API (New)' ile kısıtlanmış anahtar. Günlük kota sınırı koymanız önerilir.",
  "settings.mapsKey": "Maps JavaScript API anahtarı (harita)",
  "settings.mapsKey.help":
    "Harita için tarayıcı anahtarı. Yalnızca 'Maps JavaScript API' ile kısıtlayın.",
  "settings.mapsKey.optional": "Maps JavaScript API anahtarı (isteğe bağlı)",
  "settings.mapsKey.optional.help":
    "Girerseniz demo veriler de gerçek Google haritasında görünür. Girmezseniz şematik görünüm kullanılır.",
  "settings.mapId": "Harita Kimliği (Map ID)",
  "settings.mapId.help":
    "Google Cloud > Harita Yönetimi'nden oluşturulur. Boş bırakırsanız gelişmiş işaretçiler için 'DEMO_MAP_ID' kullanılır.",
  "settings.key.set": "Tanımlı",
  "settings.key.missing": "Tanımlı değil",
  "settings.key.fromEnv": "ortam değişkeninden",
  "settings.key.paste": "Anahtarı buraya yapıştırın",
  "settings.key.replace": "Değiştirmek için yeni anahtarı yapıştırın",
  "settings.key.saved": "Anahtar güvenli şekilde kaydedildi.",
  "settings.key.test": "Anahtarı test et",
  "settings.budget.title": "Aylık API bütçesi",
  "settings.budget.desc":
    "Uygulama tahmini Google harcamasını sayar. %80'de uyarır, %100'de yeni ücretli taramaları ve zenginleştirmeleri durdurur.",
  "settings.budget.monthly": "Aylık bütçe (USD)",
  "settings.budget.thisMonth": "Bu ay ({month})",
  "settings.budget.warning": "Bütçenin %80'ine ulaşıldı.",
  "settings.budget.blocked": "Bütçe doldu: yeni ücretli çağrılar durduruldu.",
  "settings.budget.sku": "Hizmet",
  "settings.budget.calls": "Çağrı",
  "settings.budget.cost": "Tahmini ücret",
  "settings.budget.none": "Bu ay henüz çağrı yapılmadı.",
  "settings.budget.disclaimer":
    "Fiyatlar {date} tarihli Google liste fiyatlarına dayanır; tahmindir, kesin tutar Google Cloud faturanızdır.",
  "settings.budget.quotaTip":
    "Gerçek bir güvenlik ağı için Google Cloud'da Places API (New) için günlük kota sınırı da koyun; bütçe uyarısı Google tarafında harcamayı durdurmaz.",
  "settings.markets.title": "Hedef pazarlar",
  "settings.markets.desc":
    "Keşif ve kampanyalar varsayılan olarak yalnızca seçtiğiniz ülkelerle sınırlıdır.",
  "settings.markets.filter": "Ülke ara",
  "settings.markets.count": "{n} ülke seçili",
  "settings.markets.trNote": "varsayılan kapalı",
  "settings.markets.note":
    "Türkiye ihracat odağı nedeniyle varsayılan olarak seçili değildir; isterseniz ekleyebilirsiniz.",
  "settings.company.title": "Gönderen firma bilgileri",
  "settings.company.desc":
    "E-postaların altında görünecek gönderen kimliği. Eksiksiz doldurulmadan gönderim etkinleştirilmez.",
  "settings.novelty.title": "Yenilik eşikleri",
  "settings.novelty.desc":
    "Skorun hangi değerden sonra 'yüksek' veya 'muhtemel' sayılacağı ve 'yeni tespit' ipucunun kaç gün geçerli olacağı.",
  "settings.novelty.high": "Yüksek yenilik (en az)",
  "settings.novelty.likely": "Muhtemel yeni (en az)",
  "settings.novelty.window": "Yeni ipucu süresi (gün)",
  "settings.novelty.invalid": "'Muhtemel' eşiği 'Yüksek' eşiğinden küçük olmalı.",
  "settings.categories.title": "Kategoriler",
  "settings.categories.desc":
    "Hangi işletme türlerinin taranacağı. Her tür ve anahtar kelime ayrı bir sorgudur; çok fazla eklemek çağrı sayısını artırır.",
  "settings.categories.queries": "{n} sorgu",
  "settings.categories.addType": "Google türü ekle (örn. tea_house)",
  "settings.categories.addKeyword": "Anahtar kelime ekle",
  "settings.data.title": "Veri ve hakkında",
  "settings.data.desc": "Tüm veriler bu bilgisayarda saklanır. Geliştiriciye veri gönderilmez.",
  "settings.data.folder": "Veri klasörü",
  "settings.data.version": "Sürüm",
  "settings.data.consent": "Kullanım onayı",
  "settings.data.cacheDays": "Google verisi yenileme uyarısı (gün)",
  "settings.data.googleNote":
    "Google kaynaklı alanlar (ad, adres, web sitesi vb.) dışa aktarmada varsayılan olarak yer almaz ve belirtilen günden eskiyse 'bayat' uyarısı gösterilir. Google'ın güncel saklama ve kullanım şartlarını kontrol etmek sizin sorumluluğunuzdadır.",
  "settings.about.title": "Atıflar ve gizlilik",
  "settings.about.geonames":
    "Şehir listesi GeoNames (geonames.org) verisinden türetilmiştir, lisans: CC BY 4.0.",
  "settings.about.google":
    "Harita ve işletme verileri Google Maps Platform'dan gelir; Google'ın şartları ve atıf kuralları geçerlidir.",
  "settings.about.local": "Uygulama kullanım verisi toplamaz ve telemetri göndermez.",
  "settings.demo.title": "Demo araçları",
  "settings.demo.body":
    "'Zamanı ilerlet' ile 14 gün sonraki ikinci taramayı simüle edin: yeni işletmeler belirir, bazıları açılır. Sonra aynı alanı yeniden tarayıp 'yeni tespit'i görün.",
  "settings.demo.advance": "Zamanı ilerlet (+14 gün)",
  "settings.demo.reset": "Başa al",
  "settings.demo.current": "Demo dönemi: {n}",
  "settings.demo.epoch": "Demo dönemi {n} oldu.",
  "settings.demo.purge": "Demo verilerini sil",
  "settings.demo.purge.title": "Demo verileri silinsin mi?",
  "settings.demo.purge.body":
    "Demo işletmeler, demo taramalar ve demo kullanım kayıtları silinir. Gerçek Google verilerine dokunulmaz.",
  "settings.demo.purge.confirm": "Demo verilerini sil",
  "settings.demo.purged": "{n} demo işletme silindi.",

  // Firma alanları
  "company.legalName": "Ticari unvan",
  "company.address": "Adres",
  "company.taxId": "Vergi / sicil numarası",
  "company.phone": "Telefon",
  "company.contactName": "İhracat sorumlusu (ad soyad)",
  "company.contactTitle": "Unvan",
  "company.website": "Web sitesi",

  // Kurulum sihirbazı
  "setup.tagline": "Yeni açılan işletmeleri bul, kontrollü ulaş",
  "setup.steps": "Kurulum adımları",
  "setup.step.welcome": "Onay",
  "setup.step.company": "Firma",
  "setup.step.markets": "Pazarlar",
  "setup.step.google": "Google",
  "setup.step.budget": "Bütçe",
  "setup.step.finish": "Başla",
  "setup.back": "Geri",
  "setup.next": "Devam",
  "setup.welcome.title": "Hoş geldiniz",
  "setup.welcome.body":
    "Universal Mail, yurt dışındaki yeni açılan işletmeleri bulmanıza ve onlara kontrollü, yalnızca iş amaçlı e-postalar göndermenize yardım eder. Başlamadan önce kullanım şartlarını onaylayın.",
  "setup.consent.name": "Onaylayan kişi (ad soyad)",
  "setup.consent.title": "Unvan",
  "setup.consent.accept": "Yukarıdaki şartları okudum ve şirketim adına kabul ediyorum.",
  "setup.consent.note":
    "Onayınız tarih ve adınızla birlikte bu bilgisayarda denetim kaydına yazılır. Onay verilmeden veri toplama işlevleri çalışmaz.",
  "consent.1":
    "Bu yazılımı yalnızca şirketimin kendi ürünlerini işletmelere (B2B) tanıtmak için kullanacağım.",
  "consent.2": "Kişisel e-posta adreslerine ve bireylere gönderim yapmayacağım.",
  "consent.3":
    "Gönderen olarak e-postaların içeriğinden, alıcı seçiminden ve ilgili ülkelerin mevzuatına uygunluktan şirketimin sorumlu olduğunu kabul ediyorum.",
  "consent.4":
    "Yazılımın uyum ayarlarını (ülke politikası, çıkış bağlantısı, temas sınırları, engel listesi) devre dışı bırakmaya çalışmayacağım.",
  "consent.5": "Alıcıların çıkış ve silme taleplerini derhal uygulayacağım.",
  "consent.6":
    "Google Maps Platform ve e-posta sağlayıcımın kullanım şartlarını kendi hesabımda kabul ettiğimi biliyorum.",
  "setup.company.title": "Gönderen firma",
  "setup.company.body":
    "Bu bilgiler gönderilecek e-postaların altında gönderen kimliği olarak yer alır. Şirket adına hukuki gönderen sizsiniz.",
  "setup.markets.title": "Hedef pazarlar",
  "setup.markets.body":
    "Hangi ülkelere ihracat yapmak istiyorsunuz? Keşif yalnızca seçtiğiniz ülkelerle sınırlı olur; sonradan değiştirebilirsiniz.",
  "setup.markets.note":
    "Bazı ülkelerde (örn. Almanya, Avusturya) soğuk e-posta için ön onay gerekir. Ülke kuralları e-posta gönderimi aşamasında uygulanır.",
  "setup.google.title": "Google bağlantısı",
  "setup.google.body":
    "Gerçek işletmeleri bulmak için Google anahtarlarınızı girin. Önce uygulamayı denemek isterseniz demo modunu seçin.",
  "setup.google.guide": "Anahtarları nasıl alacağınız için projedeki 'Faz 0 Kılavuzu'na bakın.",
  "setup.google.demoNote":
    "Demo modunda yapay işletmeler üretilir; Google'a istek atılmaz, ücret doğmaz. Gerçek anahtarları sonradan Ayarlar'dan girebilirsiniz.",
  "setup.budget.title": "Aylık bütçe",
  "setup.budget.body":
    "Uygulamanın bir ayda harcayabileceği tahmini Google tutarı. Bu tutara yaklaşınca uyarılır, ulaşınca yeni ücretli çağrılar durur.",
  "setup.budget.tip1":
    "Google, her ay belirli sayıda çağrıyı ücretsiz verir; küçük taramalar çoğunlukla ücretsiz kalır.",
  "setup.budget.tip2": "Taramadan önce tahmini maliyeti her zaman görürsünüz ve onay verirsiniz.",
  "setup.budget.tip3": "Ek güvenlik için Google Cloud'da günlük kota sınırı koymanız önerilir.",
  "setup.finish.title": "Hazırsınız",
  "setup.finish.body":
    "Ayarları gözden geçirin. Hepsini daha sonra Ayarlar'dan değiştirebilirsiniz.",
  "setup.finish.cta": "Kurulumu tamamla",
  "setup.finish.missing": "Eksik: {list}",
  "setup.summary.signer": "Onaylayan",
  "setup.summary.company": "Firma",
  "setup.summary.markets": "Hedef pazarlar",
  "setup.summary.provider": "Veri kaynağı",
  "setup.summary.budget": "Aylık bütçe",

  // Hata sayfası
  "error.title": "Bir şeyler ters gitti",
  "error.body":
    "Sayfa yüklenirken beklenmeyen bir hata oluştu. Verileriniz güvende. Yeniden denemek için aşağıdaki düğmeyi kullanın.",
  "error.retry": "Yeniden dene",
} as const;
