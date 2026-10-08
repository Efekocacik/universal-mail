# Universal Mail — Yazılım Gereksinim Spesifikasyonu (SRS)

| Alan | Değer |
|---|---|
| Proje | Universal Mail — Yeni açılan işletmeleri bulup e-posta ile ulaşan yerel satış aracı |
| Sürüm | 1.0 (taslak) |
| Tarih | 8 Ekim 2026 |
| Hedef kullanıcı | Müşteri şirketin yetkilisi (tek kullanıcı); kendi bilgisayarında kurar ve çalıştırır |
| Ticari model | Geliştirici, yazılımı müşteri şirkete fatura keserek teslim eder (bkz. 1.5 ve `docs/03-SOZLESME-CERCEVESI.md`) |
| Dağıtım | Özel (private) depo, internete açık sunucu yok; müşteri kendi bilgisayarına kurar, veri geliştiriciye gitmez |
| Depo | https://github.com/Efekocacik/universal-mail.git |

---

## 1. Giriş

### 1.1 Amaç
Bu belge, **yurt dışı pazarlarda (öncelikle Avrupa)** **yeni açılan veya yakında açılacak** işletmeleri (kafe, restoran, otel, hastane, ofis vb.) Google Haritalar verisinden otomatik tespit eden, bu işletmelerin iletişim e-postalarını bulan ve düzenlenebilir şablonlarla **tek tek, kontrollü** satış e-postası gönderen masaüstü/yerel web uygulamasının gereksinimlerini tanımlar.

Müşteri şirketin ürün grubu: tek kullanımlık çatal-bıçak, amerikan servis, ıslak mendil, peçete, karton bardak ve benzeri **sarf malzemeleri**. Ana amaç, müşteri şirketin **yurt dışındaki dağıtım ağını büyütmek**: bu malzemeleri düzenli tüketen ve henüz tedarikçisi oturmamış **yeni** işletmelere (B2B) e-posta ile ulaşıp distribütör/bayi/tedarik ilişkisi başlatmaktır.

Türkiye, ihracat odağı nedeniyle **varsayılan hedef pazar değildir**; müşteri isterse ayarlardan açabilir (İYS şartıyla, Bölüm 8.2).

### 1.2 Kapsam
Uygulama şunları yapar:
1. Seçilen ülke/şehir ve kategori listesine göre Google Places API (New) üzerinden işletme tarar.
2. Taramaları düzenli tekrarlayıp **önceki tarama ile karşılaştırarak** yeni ortaya çıkan işletmeleri işaretler ("yeni açıldı" sinyali).
3. "Yakında açılacak" (FUTURE_OPENING) işletmeleri ayrıca çeker.
4. İşletmenin web sitesini tarayarak e-posta adresi bulur, doğrular.
5. Ülke/kategori/yenilik skoru/e-posta durumu gibi alanlara göre filtreleme sağlar.
6. Harita + liste görünümüyle (Google Maps gömülü) şık bir arayüz sunar.
7. Dil bazlı, değişkenli e-posta şablonları ile kampanya oluşturur; gönderimi hız sınırlı kuyruğa alır.
8. Yanıt, geri dönüş (bounce) ve abonelikten çıkma (unsubscribe) takibi yapar; ülke bazlı yasal kuralları uygular.

Kapsam dışı (v1): SMS/WhatsApp gönderimi, CRM entegrasyonu, çok kullanıcılı erişim, bulut sunucu kurulumu, **bireylere (tüketicilere) gönderim**, hazır e-posta listesi satışı, müşteri dışında bir üçüncü taraf adına gönderim.

### 1.3 Tanımlar
| Terim | Anlam |
|---|---|
| Lead | Potansiyel müşteri işletme kaydı |
| Place ID | Google'ın her işletmeye verdiği kalıcı kimlik |
| Snapshot | Belirli bir tarih ve bölge için yapılan tarama sonucu |
| Yenilik skoru | İşletmenin ne kadar "yeni" olduğuna dair 0–100 arası hesaplanan puan |
| Field mask | Places API'de hangi alanların isteneceğini belirten liste; fiyatı belirler |
| SKU | Google'ın fiyatlandırma birimi (Essentials / Pro / Enterprise) |
| Suppression list | Asla e-posta gönderilmeyecek adresler listesi (çıkanlar, şikâyet edenler, bounce) |
| İYS | İleti Yönetim Sistemi (Türkiye'de ticari elektronik ileti izin sistemi) |

### 1.4 Referanslar
- Google Places API (New) fiyatlandırma: https://developers.google.com/maps/billing-and-pricing/pricing
- Places API (New) alanlar ve SKU'lar: https://developers.google.com/maps/documentation/places/web-service/data-fields
- Places API (New) sürüm notları (`openingDate`, `includeFutureOpeningBusinesses`): https://developers.google.com/maps/documentation/places/web-service/release-notes
- Google Maps Platform Hizmet Şartları (önbellekleme kuralları): https://cloud.google.com/maps-platform/terms
- UK Companies House Public Data API: https://developer.company-information.service.gov.uk/
- Fransa INSEE Sirene API: https://api.insee.fr/catalogue/
- Gmail gönderim limitleri: https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace
- 6563 sayılı Elektronik Ticaretin Düzenlenmesi Hakkında Kanun ve Ticari İletişim Yönetmeliği (Türkiye)
- UK PECR, Almanya UWG §7, Fransa CNIL B2B rehberi (bkz. Bölüm 8)

### 1.5 Roller ve ticari çerçeve

Yazılım, müşteri şirkete **fatura karşılığı** teslim edilen bir araçtır. Roller şöyle ayrılır:

| Rol | Kim | Sorumluluk |
|---|---|---|
| Yazılım sağlayıcı | Geliştirici | Yazılımı sözleşmedeki kapsamda geliştirir, teslim eder, kararlaştırılan bakım/destek süresince hataları giderir. Müşterinin verisine erişmez, veri barındırmaz. |
| İşleten / gönderen | Müşteri şirket | Tüm hesapların sahibi (Google Cloud, alan adı, Workspace). Kime, ne, kaç kez e-posta göndereceğine karar verir. E-postaların hukuki göndereni ve kişisel veri sorumlusu müşteri şirkettir. |
| Alıcı | Hedef işletme | Çıkış hakkı, silme hakkı ve itiraz hakkı vardır. |

İlkeler (tasarımı bağlar):
1. **Hesaplar müşteriye aittir.** Google Cloud projesi, API anahtarları, alan adı ve posta kutusu müşteri adına açılır; faturalar müşteriye gelir. Geliştiricinin kendi anahtarı hiçbir zaman dağıtılan kuruluma konmaz.
2. **Veri yerelde kalır.** Telemetri, uzak günlük, otomatik raporlama yoktur. Destek gerekirse müşteri ekran paylaşır veya veriyi kendisi dışa aktarır.
3. **Kullanım amacı sınırlıdır.** Yalnızca müşterinin kendi ürünlerinin B2B tanıtımı. Başkası adına gönderim, liste satışı, bireylere gönderim yasaktır (sözleşmede ve ilk açılış onayında yazılıdır).
4. **Uyum varsayılan olarak açıktır.** Ülke politikası, çıkış bağlantısı, temas sınırları ve engel listesi kapatılamaz (Bölüm 5.6.1 ve 8).
5. **Garanti kapsamı:** Yazılımın belirtilen şekilde çalışması taahhüt edilir; bulunan e-posta sayısı, teslim edilebilirlik, yanıt oranı veya satış sonucu taahhüt edilmez.

---

## 2. Genel Açıklama

### 2.1 Ürün perspektifi
Kullanıcının bilgisayarında çalışan, tarayıcıdan `http://localhost:3000` ile açılan yerel bir web uygulamasıdır. Dış dünyayla yalnızca şu API'ler üzerinden konuşur:

```
┌──────────────────────────────────────────────────────────────┐
│  Kullanıcının bilgisayarı                                    │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────┐   │
│  │ Web arayüzü  │◄──►│ API sunucusu │◄──►│ SQLite veri   │   │
│  │ (harita+liste│    │ (Next.js)    │    │ tabanı        │   │
│  └──────────────┘    └──────┬───────┘    └───────────────┘   │
│                             │                                │
│                      ┌──────▼───────┐                        │
│                      │ İş kuyruğu / │                        │
│                      │ zamanlayıcı  │                        │
│                      └──────┬───────┘                        │
└─────────────────────────────┼────────────────────────────────┘
                              │ HTTPS
        ┌─────────────┬───────┴──────┬──────────────┬──────────────┐
        ▼             ▼              ▼              ▼              ▼
  Google Places   Google Maps    İşletme web    Gmail API /    Şirket sicil
  API (New)       JS API         siteleri       SMTP           API'leri
  (tarama)        (harita)       (e-posta       (gönderim)     (Companies
                                 bulma)                         House, Sirene)
```

### 2.2 Kullanıcı profili
Tek kullanıcı: müşteri şirketin yetkilisi (ihracat/satış sorumlusu), teknik uzman değil. Arayüz Türkçe (ikincil İngilizce), adımlar sade, "ne yapmalıyım" sorusunu arayüz kendisi yanıtlamalı. Kurulum tek komut veya tek tıklamayla yapılmalı.

### 2.3 Çalışma ortamı
- macOS 13+ veya Windows 10/11 (öncelik macOS, kullanıcının mevcut makinesi).
- Node.js 20+ (kurulum betiğiyle otomatik kontrol edilir).
- İnternet bağlantısı (API çağrıları için).
- Google Cloud hesabı + faturalandırma açık (ücretsiz kota için bile zorunlu).
- Kendi alan adı (örn. `firmaadi.com`) ve bu alan adına bağlı Google Workspace **veya** Microsoft 365 posta kutusu. Kişisel `@gmail.com` adresinden soğuk e-posta gönderimi **tavsiye edilmez** (spam riski ve hesap kapanma riski).

### 2.4 Kısıtlar
| # | Kısıt | Etki |
|---|---|---|
| K1 | Places API'de "açılış tarihi" alanı yalnızca **gelecekte açılacak** işletmeler için dolu (`businessStatus = FUTURE_OPENING`). Geçmişe dönük "ne zaman açıldı" bilgisi yok. | "Yeni açıldı" tespiti snapshot karşılaştırması ve dolaylı sinyallerle yapılmak zorunda. |
| K2 | Google şartları: Places'ten **yalnızca Place ID kalıcı**, **enlem/boylam en fazla 30 gün** saklanabilir; işletme adı, adres vb. içeriğin toplu indirilip kendi veritabanında saklanması kısıtlıdır (kesin metin, Google'ın güncel şartlarından avukatla doğrulanmalı). | Google kaynaklı içerik kalıcı lead veritabanının temeli olmamalı: kalıcı tutulan veri place_id + kullanıcının kendi eklediği/doğruladığı alanlar (e-posta, notlar, durum); ad/adres/koordinat gibi alanlar gösterim için 30 günü geçmeden yeniden çekilir. Lead listesinin ana kaynağı işletmelerin kendi web siteleri ve şirket sicilleri olmalı. |
| K3 | Google ToS: Places verisi Google dışı bir harita üzerinde gösterilemez. | Harita bileşeni Google Maps JavaScript API olmalı (zaten istenen). |
| K4 | Places API e-posta adresi **vermez**. | E-posta ayrı bir zenginleştirme adımıyla (web sitesi tarama) bulunur. |
| K5 | Gmail/Workspace günlük gönderim limiti (Workspace: 2.000/gün; deneme hesabı: 500). Soğuk e-postada güvenli pratik çok daha düşüktür. | Gönderim kuyruğu günlük tavan + ısınma (warm-up) eğrisiyle çalışır. |
| K6 | Ülkelere göre B2B soğuk e-posta mevzuatı farklıdır (Almanya çok katı). | Ülke bazlı gönderim politikası motoru zorunlu. |
| K7 | Tek kullanıcı, yerel kurulum. | Harici kuyruk sistemi (Redis vb.) kullanılmaz; her şey SQLite + tek süreç. |

### 2.5 Varsayımlar
- Kullanıcı kendi alan adından gönderim yapacak ve SPF/DKIM/DMARC kayıtlarını (kurulum rehberi eşliğinde) ekleyecek.
- Aylık API bütçesi başlangıçta ≤ 50 USD; uygulama bunu aşmamak için kendi bütçe sayacını tutar.
- Türkiye gönderimleri açılırsa müşteri İYS'ye hizmet sağlayıcı olarak kayıt yaptıracaktır.
- Gönderen kimliği (unvan, adres, vergi/sicil numarası) müşteri şirketin bilgileridir; footer'da bu bilgiler yer alır.
- Müşteri, Google Cloud ve posta hesaplarını kendi adına açar ve kendi kartıyla faturalandırır.

---

## 3. Hedef Segmentler ve Kategori Haritası

Ürünlerin tüketildiği her nokta hedef. Aşağıdaki tablo Google Places "Table A" tiplerine eşlenmiştir (tip adları Google'ın güncel listesiyle uygulama başında doğrulanacaktır).

| Segment | Neden hedef | Google Places tipleri (örnek) | Öncelik |
|---|---|---|---|
| Kafe / kahveci | Peçete, karıştırıcı, bardak, ıslak mendil | `cafe`, `coffee_shop`, `tea_house`, `cat_cafe`, `dog_cafe` | ★★★ |
| Restoran / fast food / paket servis | Çatal-bıçak, amerikan servis, peçete | `restaurant`, `fast_food_restaurant`, `meal_takeaway`, `meal_delivery`, `pizza_restaurant`, `hamburger_restaurant`, ve diğer `*_restaurant` tipleri | ★★★ |
| Fırın / pastane / tatlıcı | Servis malzemesi | `bakery`, `dessert_shop`, `ice_cream_shop`, `donut_shop` | ★★★ |
| Bar / pub / gece kulübü | Peçete, karıştırıcı | `bar`, `pub`, `wine_bar`, `night_club` | ★★ |
| Otel / hostel / pansiyon | Kahvaltı servisi, oda ikramı | `hotel`, `hostel`, `bed_and_breakfast`, `guest_house`, `motel`, `resort_hotel` | ★★ |
| Catering / etkinlik mekânı / düğün salonu | Toplu servis | `catering_service`, `event_venue`, `banquet_hall`, `wedding_venue` | ★★ |
| Hastane / klinik / diş / fizik tedavi | Islak mendil, hasta yemeği servisi | `hospital`, `dental_clinic`, `doctor`, `physiotherapist`, `medical_lab` | ★★ |
| Huzurevi / bakım evi / kreş / okul | Yemekhane sarfı | `child_care_agency`, `preschool`, `school`, `university` (huzurevi için Text Search anahtar kelime) | ★ |
| Ofis / ortak çalışma alanı | Mutfak sarfı, ıslak mendil | `corporate_office`, `coworking_space` | ★ |
| Spor salonu / güzellik / kuaför / spa | Islak mendil, tek kullanımlık havlu | `gym`, `fitness_center`, `beauty_salon`, `hair_salon`, `barber_shop`, `nail_salon`, `spa` | ★ |
| Benzinlik marketi / büfe / kantin | Paket servis sarfı | `gas_station`, `convenience_store`, `cafeteria` | ★ |

Kullanıcı bu listeyi arayüzden **açıp kapatabilir**, kendi anahtar kelimelerini (örn. "kokoreççi", "çiğ köfteci", "boba tea") ekleyebilir.

---

## 4. Veri Kaynakları ve API Kararları

### 4.1 Birincil kaynak: Google Places API (New)

| Kullanım | Uç nokta | Not |
|---|---|---|
| Bölge + kategori taraması | **Text Search (New)** `places:searchText` | `includedType`, `locationBias`/`locationRestriction`, `pageToken` ile sayfalama (sayfa başı 20 sonuç, en fazla 60/sorgu) |
| Dar bölge taraması (yoğun merkezler) | **Nearby Search (New)** `places:searchNearby` | Yarıçap ≤ 50 km, `includedTypes` listesi, sayfalama yok (maks. 20) → şehir ızgaraya bölünür |
| Yakında açılacaklar | Her iki aramada `includeFutureOpeningBusinesses: true` | `businessStatus = FUTURE_OPENING`, `openingDate` dolu gelir. **En değerli lead sinyali.** |
| Tekil tazeleme | **Place Details (New)** `places/{id}` | 30 günlük önbellek süresi dolan kayıtlar için |

**Field mask stratejisi (maliyet kontrolü):** Faturalama, istenen en pahalı alana göre belirlenir. Uygulama iki ayrı mask kullanır:

| Mask adı | Alanlar | SKU | Ne zaman |
|---|---|---|---|
| `DISCOVERY` | `places.id, places.displayName, places.formattedAddress, places.location, places.types, places.primaryType, places.businessStatus, places.openingDate` | Text Search **Pro** | İlk tarama ve snapshot karşılaştırması. Yeni place_id tespiti için yeterli. |
| `ENRICH` | Yukarıdakiler + `places.websiteUri, places.nationalPhoneNumber, places.internationalPhoneNumber, places.userRatingCount, places.googleMapsUri` | Text Search **Enterprise** | Yalnızca **yeni** olarak işaretlenen veya kullanıcının seçtiği kayıtlar için. |

Yorum metni (`reviews`) ve `rating` gibi "Atmosphere" alanları **istenmez** (en pahalı SKU; ihtiyaç yok).

**Güncel liste fiyatları (Ekim 2026, doğrulanmalı):**

| SKU | Aylık ücretsiz | Sonrası (ilk 100k) |
|---|---|---|
| Text Search Pro | 5.000 çağrı | 32 USD / 1.000 |
| Text Search Enterprise | 1.000 çağrı | 35 USD / 1.000 |
| Place Details Pro / Enterprise | 5.000 / 1.000 | ~17 / ~20 USD / 1.000 |
| Maps JavaScript (Dynamic Maps) | 10.000 yükleme | 7 USD / 1.000 |

Bir Text Search çağrısı 20 işletme döndürür; yani Enterprise mask ile **10.000 işletmenin web sitesi + telefonu ≈ 500 çağrı ≈ 17,5 USD** (ilk 1.000 çağrı ücretsiz). Maliyet projenin engeli değildir; esas kısıt yasal uyum ve e-posta bulma kalitesidir.

### 4.2 "Yeni açıldı" tespiti — çok sinyalli yaklaşım
Google bu bilgiyi API'den vermediği için **yenilik skoru** şu sinyallerden hesaplanır:

| Sinyal | Puan | Açıklama |
|---|---|---|
| `businessStatus = FUTURE_OPENING` | +100 | Kesin: henüz açılmamış, tedarikçi arıyor |
| Place ID önceki snapshot'ta yok, bu snapshot'ta var (bölge daha önce taranmışsa) | +70 | Snapshot diff. İlk tarama için geçerli değil (baz çizgi). |
| `FUTURE_OPENING` → `OPERATIONAL` geçişi gözlendi | +90 | Açılış anı yakalandı |
| `userRatingCount` ≤ 5 | +25 | Çok az yorum = büyük ihtimalle yeni |
| `userRatingCount` 6–20 | +10 | |
| Şirket sicilinde son 90 günde kuruluş kaydı eşleşti (bkz. 4.3) | +60 | Ad + posta kodu/şehir bulanık eşleştirme |
| Web sitesi alan adı son 6 ayda kaydedilmiş (RDAP sorgusu, ücretsiz) | +20 | `rdap.org` üzerinden |

Skor ≥ 60 "Yeni", 30–59 "Muhtemel", < 30 "Yerleşik" olarak etiketlenir. Eşikler ayarlardan değiştirilebilir.

**Snapshot stratejisi:** Her bölge+kategori kombinasyonu için ilk tarama "baz çizgi"dir. Sonraki taramalar (varsayılan: 14 günde bir) yalnızca `DISCOVERY` mask ile yapılır (ucuz), fark bulunan place_id'ler `ENRICH` ile zenginleştirilir.

### 4.3 İkincil kaynak: ücretsiz şirket sicilleri (Faz 5)
Yeni kurulan şirketler, Google'a düşmeden haftalar önce sicile düşer. Bu, rakiplerden önce ulaşma avantajı sağlar.

| Ülke | Kaynak | Erişim | Filtre |
|---|---|---|---|
| Birleşik Krallık | Companies House Advanced Search API `GET /advanced-search/companies` | Ücretsiz, API anahtarı, 600 istek/5 dk | `sic_codes=56101,56102,56103,56210,56302,55100,86101,86210,86230` + `incorporated_from=YYYY-MM-DD` |
| Fransa | INSEE Sirene API `siret` uç noktası | Ücretsiz, hesap gerekli | `activitePrincipaleEtablissement:56.30Z OR 56.10A OR 56.10C OR 55.10Z` + `dateCreationEtablissement:[... TO ...]` (2027'de NAF 2025 kodlarına geçiş planlanmalı) |
| İrlanda | CRO Open Services | Ücretsiz | Kuruluş tarihi + NACE |
| Belçika | KBO/BCE Open Data | Ücretsiz dökümler | NACE 56.30 |
| Almanya | Resmi API yok (Handelsregister); OffeneRegister / North Data | Kısıtlı / ücretli | v1'de kapsam dışı; Almanya zaten e-posta için opt-in gerektiriyor |
| Hollanda | KVK API | Ücretli | Kapsam dışı (v1) |
| Türkiye | MERSİS / Ticaret Sicil Gazetesi | Herkese açık API yok | Kapsam dışı; Google snapshot diff yeterli |

Sicil kayıtları Google ile **ad + şehir** üzerinden bulanık eşleştirilir; eşleşmeyenler "sicilde var, haritada yok" olarak ayrı listelenir (telefon/posta ile ulaşım için).

### 4.4 Toplu veri için opsiyonel ücretli alternatifler
Resmi API yerine/yanında, çok büyük hacimlerde (100k+) daha ucuz olabilen servisler: **Outscraper**, **Apify Google Maps Scraper**, **SerpApi**. Bunlar Google'ın hizmet şartları açısından gri alandır ve veriyi Google haritası üzerinde göstermek ayrı sorun yaratabilir. **Karar:** v1 yalnızca resmi Places API kullanır. Bu servisler ileride "içe aktarma (CSV)" özelliğiyle desteklenebilir.

### 4.5 E-posta bulma (zenginleştirme)
Sıralı, ucuzdan pahalıya:

1. **Kendi web sitesi tarayıcısı (ücretsiz, birincil)**
   - `websiteUri` ana sayfası + aday sayfalar: `/contact`, `/contact-us`, `/iletisim`, `/kontakt`, `/impressum` (DE/AT — yasal zorunlulukla e-posta içerir), `/mentions-legales` (FR), `/about`, `/hakkimizda`.
   - `mailto:` bağlantıları, düz metin regex, `schema.org` JSON-LD `email` alanı, Cloudflare e-posta gizleme çözme.
   - Statik HTML için `cheerio`; JS ile oluşturulan siteler için `Playwright` (headless, yalnızca gerektiğinde).
   - `robots.txt`'e saygı, site başına ≤ 6 istek, 1 sn aralık, kimliği belli User-Agent.
   - Sosyal medya bağlantıları (Instagram/Facebook URL) de yakalanır ve lead kartında gösterilir (manuel ulaşım için).
2. **Harici e-posta bulucu API (opsiyonel, kullanıcı anahtarı girerse)**: Hunter.io Domain Search, Snov.io, Prospeo. Yalnızca 1. adım boş dönerse ve kullanıcı açıkça etkinleştirdiyse.
3. **Doğrulama**: Sözdizimi → alan adı MX kaydı var mı → (opsiyonel) SMTP el sıkışma denemesi → tek kullanımlık (disposable) alan adı listesi. Dış doğrulama servisi (ZeroBounce, NeverBounce) opsiyonel.

Sonuç `email_status`: `found_verified`, `found_unverified`, `generic` (info@, hello@), `not_found`, `invalid`.

### 4.6 E-posta gönderimi
| Seçenek | Uygunluk | Karar |
|---|---|---|
| **Gmail API (Google Workspace, kendi alan adı)** | OAuth ile güvenli, "Gönderilmiş" klasörüne düşer, yanıtlar aynı kutuya gelir, Workspace 2.000/gün | **v1 birincil** |
| Microsoft 365 (Graph API veya SMTP) | Eşdeğer | v1 alternatif (SMTP ile) |
| Genel SMTP (nodemailer) | Her sağlayıcı | Destek var |
| Amazon SES | Çok ucuz, ama yeni hesapta itibar sıfır, soğuk e-posta için risk | v2 opsiyon |
| Resend / Brevo / SendGrid | Kullanım şartları soğuk e-postayı genelde yasaklar | **Kullanılmaz** |
| Instantly / Smartlead / lemlist | Soğuk e-posta için ısınma + çoklu posta kutusu rotasyonu dahil, aylık ~30–100 USD | Hacim büyürse önerilir; uygulama bunlara CSV dışa aktarım yapar |

**Gönderim politikası (varsayılanlar, değiştirilebilir):** posta kutusu başına 1. hafta 20/gün, her hafta +10, tavan 80/gün; gönderimler arası 90–240 sn rastgele; yalnızca alıcının yerel saatiyle 09:00–17:00 hafta içi; her mesajda tek tıkla çıkma bağlantısı ve fiziksel adres.

### 4.7 Harita görünümü
**Google Maps JavaScript API** + `@vis.gl/react-google-maps`. Özel Map ID ile sade stil (Cloud-based map styling). Advanced Markers + kümeleme (`@googlemaps/markerclusterer`). Aylık 10.000 harita yüklemesi ücretsiz; tek kullanıcı için fazlasıyla yeterli.

### 4.8 Opsiyonel: yapay zekâ ile kişiselleştirme
Lead'in web sitesi/menüsünden 1–2 cümlelik kişisel giriş üretmek için Claude API (`claude-sonnet-5-5`) kullanılabilir. Kullanıcı anahtar girmezse özellik gizlenir. Üretilen metin **her zaman** gönderilmeden önce kullanıcıya gösterilir; otomatik gönderilmez.

---

## 5. Fonksiyonel Gereksinimler

Öncelik: **Z** = Zorunlu (MVP), **Ö** = Önemli, **İ** = İsteğe bağlı.

### 5.1 Kurulum ve ayarlar
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-SET-01 | Uygulama tek komutla (`npm run setup && npm start`) veya çift tıklanabilir başlatıcı ile kurulur; Node sürümünü kontrol eder, veritabanını oluşturur. | Z |
| FR-SET-02 | İlk açılışta "Kurulum Sihirbazı": Google API anahtarı, gönderim hesabı (Gmail OAuth veya SMTP), firma bilgileri (unvan, adres, MERSİS no, telefon), varsayılan dil. | Z |
| FR-SET-03 | API anahtarları ve OAuth token'ları işletim sistemi anahtarlığında (macOS Keychain / Windows Credential Manager) veya şifreli dosyada saklanır; düz metin `.env` içinde **tutulmaz**. | Z |
| FR-SET-04 | Google anahtarı girildiğinde test çağrısı yapılır; faturalandırma/kota hatası anlaşılır Türkçe mesajla gösterilir. | Z |
| FR-SET-05 | Aylık API bütçe tavanı (USD) ayarlanır; uygulama tahmini harcamayı sayar, %80'de uyarır, %100'de otomatik taramaları durdurur. | Z |
| FR-SET-06 | SPF/DKIM/DMARC kurulum rehberi ve alan adı için otomatik kontrol (DNS sorgusu) ekranı. | Ö |
| FR-SET-07 | **Gönderen firma profili** zorunludur: ticari unvan, adres, vergi/sicil numarası, telefon, ihracat sorumlusu adı. Doldurulmadan gönderim açılmaz; tüm e-postaların footer'ı bu profilden üretilir. | Z |
| FR-SET-08 | **İlk açılış kullanım onayı:** kullanım amacı (yalnızca kendi ürünlerinin B2B tanıtımı), gönderenin sorumluluğu, ülke politikalarının bağlayıcılığı ve temas sınırları özetlenir; yetkili onaylamadan uygulama kullanılamaz. Onay sürümü, tarihi ve onaylayan ad-soyad audit log'a yazılır. | Z |
| FR-SET-09 | Hedef pazar seçimi: kurulumda "hangi ülkelere ihracat yapıyorsunuz?" sorusuyla ülke listesi seçilir; keşif ve kampanyalar varsayılan olarak yalnızca bu ülkelerle sınırlıdır. Türkiye varsayılan kapalıdır. | Z |

### 5.2 Tarama (Discovery)
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-DIS-01 | Kullanıcı bir **tarama bölgesi** tanımlar: ülke → şehir seçimi (hazır liste: Avrupa + Türkiye'nin 500+ şehri), veya haritada dikdörtgen/daire çizerek. | Z |
| FR-DIS-02 | Kullanıcı bir **kategori seti** seçer (Bölüm 3 tablosu, açılıp kapatılabilir) ve serbest anahtar kelime ekleyebilir. | Z |
| FR-DIS-03 | Tarama, bölgeyi otomatik ızgaraya böler (Nearby Search 20 sonuç sınırı için) ve kapsama boşluğu bırakmaz; ızgara boyutu işletme yoğunluğuna göre uyarlanır. | Z |
| FR-DIS-04 | Her tarama `includeFutureOpeningBusinesses: true` ile çalışır; `FUTURE_OPENING` kayıtlar `openingDate` ile saklanır. | Z |
| FR-DIS-05 | Tarama başlamadan önce **tahmini çağrı sayısı ve maliyet** gösterilir; kullanıcı onaylar. | Z |
| FR-DIS-06 | Tarama arka planda çalışır, ilerleme çubuğu ve durdur/devam et kontrolü vardır; kapanıp açılınca kaldığı yerden devam eder. | Z |
| FR-DIS-07 | Tekrarlayan tarama zamanlayıcısı: bölge başına 7/14/30 gün seçenekleri; uygulama açıkken çalışır, kaçan çalışmalar sonraki açılışta telafi edilir. | Ö |
| FR-DIS-08 | Snapshot karşılaştırması: önceki taramada olmayan place_id'ler "yeni" olarak işaretlenir; kaybolanlar "kapanmış olabilir" olarak işaretlenir. | Z |
| FR-DIS-09 | Yenilik skoru Bölüm 4.2'ye göre hesaplanır ve her lead'de gösterilir; eşikler ayarlanabilir. | Z |
| FR-DIS-10 | Google ToS gereği, place_id dışındaki Google alanları 30 günü geçince "bayat" işaretlenir ve bir sonraki taramada tazelenir veya kullanıcı onayıyla silinir. | Z |
| FR-DIS-11 | Şirket sicili tarayıcıları (UK Companies House, FR Sirene): SIC/NAF kodları ve tarih aralığı ile sorgulama; Google kayıtlarıyla bulanık eşleştirme. | İ (Faz 5) |
| FR-DIS-12 | CSV/XLSX içe aktarma (ad, adres, web sitesi, ülke) — harici kaynaklardan gelen listeler aynı hatta girer. | Ö |

### 5.3 Lead havuzu ve filtreleme
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-LEAD-01 | Tüm lead'ler tek tabloda; sütunlar: ad, kategori, şehir, ülke, yenilik skoru/etiketi, e-posta durumu, telefon, web sitesi, son temas, kampanya durumu. | Z |
| FR-LEAD-02 | Filtreler (çoklu seçim, birleştirilebilir): ülke, şehir, kategori, yenilik etiketi, e-posta durumu, `businessStatus`, yorum sayısı aralığı, "hiç temas edilmedi", "yanıt verdi", "çıktı", tarama tarihi aralığı, sicil eşleşmesi var/yok. | Z |
| FR-LEAD-03 | Kaydedilmiş filtreler ("Londra yeni kafeler", "Türkiye yakında açılacaklar"). | Ö |
| FR-LEAD-04 | Lead detay paneli: tüm alanlar, harita konumu, Google Haritalar bağlantısı, bulunan e-postalar (kaynak sayfa bağlantısıyla), zaman çizelgesi (bulundu → zenginleştirildi → gönderildi → açıldı → yanıtladı). | Z |
| FR-LEAD-05 | Manuel düzenleme: e-posta ekle/düzelt, not ekle, etiket ekle, "ilgilenmiyor"/"müşteri oldu" durumuna al. | Z |
| FR-LEAD-06 | Toplu işlemler: seçilileri kampanyaya ekle, zenginleştir, etiketle, dışa aktar, sil. | Z |
| FR-LEAD-07 | Yinelenen kayıt tespiti (aynı place_id, aynı web alanı veya aynı ad+posta kodu). | Z |
| FR-LEAD-08 | CSV/XLSX dışa aktarma (filtreye göre). | Z |

### 5.4 Zenginleştirme (e-posta bulma)
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-ENR-01 | Seçili lead'ler için web sitesi tarayıcısı Bölüm 4.5 sırasıyla çalışır; bulunan her e-posta kaynak URL'si ile kaydedilir. | Z |
| FR-ENR-02 | Doğrulama zinciri (sözdizimi, MX, disposable) otomatik; SMTP denemesi ayarlardan açılır. | Z |
| FR-ENR-03 | Genel adresler (`info@`, `hello@`, `kontakt@`) `generic` olarak işaretlenir; kişi adresleri varsa tercih edilir. | Ö |
| FR-ENR-04 | Harici bulucu (Hunter/Snov) yalnızca kullanıcı anahtar girip "yerelde bulunamayanlar için kullan" seçeneğini açarsa çalışır; kalan kota gösterilir. | İ |
| FR-ENR-05 | Zenginleştirme eşzamanlılığı ≤ 4 site; başarısızlar 24 saat sonra bir kez tekrar denenir. | Z |
| FR-ENR-06 | Sosyal medya hesapları ve iletişim formu URL'si yakalanır (e-posta yoksa "formdan ulaş" önerisi). | Ö |

### 5.5 Şablonlar
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-TPL-01 | Zengin metin + HTML şablon editörü; konu ve gövde; değişkenler: `{{isletme_adi}}`, `{{sehir}}`, `{{kategori}}`, `{{acilis_tarihi}}`, `{{gonderen_ad}}`, `{{firma}}`, `{{cikis_linki}}`, `{{kisisel_giris}}`. | Z |
| FR-TPL-02 | Şablonlar **dil bazlı** (TR, EN, DE, FR, ES, IT, NL, PT, PL + eklenebilir); lead'in ülkesine göre otomatik dil seçimi, elle değiştirilebilir. | Z |
| FR-TPL-03 | Kategori bazlı varyant (kafe için ayrı, hastane için ayrı metin) ve A/B varyantı (iki konu satırı). | Ö |
| FR-TPL-04 | Gerçek bir lead ile canlı önizleme; eksik değişken uyarısı. | Z |
| FR-TPL-05 | Takip (follow-up) adımları: ilk e-postadan sonra en fazla **2 takip** (toplam 3 e-posta); adımlar arası en az 5 gün; yanıt, çıkış veya bounce olursa kalan adımlar iptal edilir. Her adım ayrı şablon. | Ö |
| FR-TPL-06 | Zorunlu alt bilgi (footer) otomatik eklenir: gönderen unvanı, fiziksel adres, çıkış bağlantısı; TR için MERSİS no. Kullanıcı kaldıramaz, yalnızca düzenler. | Z |
| FR-TPL-07 | Spam kelime kontrolü ve ilk gönderim öncesi "test e-postası kendime gönder". | Ö |
| FR-TPL-08 | Hazır başlangıç şablonları (TR/EN, kafe/restoran/otel/klinik) ürünle gelir. | Z |

### 5.6 Kampanya ve gönderim
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-CMP-01 | Kampanya = filtre/seçim + şablon seti + gönderim penceresi + posta kutusu. Sihirbazla 4 adımda oluşturulur. | Z |
| FR-CMP-02 | Kampanyaya eklenirken **uyum kontrolü**: suppression listesinde mi, ülke politikası izin veriyor mu (Bölüm 8), e-posta doğrulanmış mı, Bölüm 5.6.1 temas sıklığı sınırlarına uyuyor mu. Geçemeyenler sebebiyle listelenir ve hariç tutulur. | Z |
| FR-CMP-03 | Gönderim kuyruğu Bölüm 4.6 politikasını uygular (günlük tavan, ısınma, rastgele aralık, yerel saat penceresi). | Z |
| FR-CMP-04 | Her gönderim öncesi son durum: "Bugün 23 e-posta gidecek, ilk 5'ini önizle". Kullanıcı **Başlat**'a basmadan hiçbir şey gönderilmez. | Z |
| FR-CMP-05 | Duraklat / devam / iptal; kuyruğun tamamı görünür ve tek tek çıkarılabilir. | Z |
| FR-CMP-06 | Bounce (geri dönüş) tespiti: Gmail API ile gelen DSN mesajları okunur; hard bounce → suppression listesine. | Z |
| FR-CMP-07 | Yanıt tespiti: aynı konu/`In-Reply-To` eşleşen gelen e-postalar lead'e bağlanır, kampanya adımları durur, lead "yanıtladı" olur. | Z |
| FR-CMP-08 | Çıkış (unsubscribe): `List-Unsubscribe` ve `List-Unsubscribe-Post` başlıkları + gövdede bağlantı. Bağlantı yerel sunucuya değil, kullanıcının bir statik sayfasına ya da `mailto:` çıkış adresine gider; gelen çıkış talepleri otomatik işlenir (≤ 3 iş günü kuralı için anında). | Z |
| FR-CMP-09 | Açılma takibi (tracking pixel) **varsayılan kapalı**; açılırsa gizlilik notu şablona eklenir. Tıklama takibi yok (v1). | İ |
| FR-CMP-10 | Gönderim günlüğü: her e-posta için zaman, alıcı, konu, durum, hata mesajı; dışa aktarılabilir. | Z |
| FR-CMP-11 | **Temas sıklığı sınırları** (Bölüm 5.6.1) kod seviyesinde uygulanır; kullanıcı yalnızca daha sıkı yapabilir, gevşetemez. | Z |

#### 5.6.1 Temas sıklığı sınırları ("rahatsız etme" kuralları)

Amaç: aynı işletmeye tekrar tekrar yazmamak, şikâyet ve spam riskini en aza indirmek. Bu kurallar kampanya ayarlarından bağımsız, her gönderimden önce kontrol edilir.

| Kural | Varsayılan | Kullanıcı değiştirebilir mi |
|---|---|---|
| Bir işletmeye (aynı lead / aynı web alan adı / aynı e-posta) gönderilecek toplam e-posta (ilk + takip) | En fazla **3** | Yalnızca azaltabilir |
| Takip e-postaları arası bekleme | En az **5 gün** | Yalnızca artırabilir |
| Dizi bittiğinde (3 e-posta, yanıt yok) | Lead "yanıt yok, dinlenmede" olur; **180 gün** hiçbir e-posta gitmez | Yalnızca artırabilir |
| 180 gün sonra yeniden temas | Otomatik **yapılmaz**; kullanıcı elle "yeniden etkinleştir" demeli, o zaman da yeni ilk e-posta olarak tek seferlik | Evet, elle |
| Aynı alan adına (zincir/çok şubeli işletme) | Tüm şubeler için **toplam** 3 e-posta ve aynı gün en fazla 1 | Yalnızca azaltabilir |
| Aynı kişiye iki farklı kampanyadan e-posta | Engellenir (son temastan sonra 30 gün) | Yalnızca artırabilir |
| Yanıt gelirse (olumlu veya olumsuz) | Otomatik dizi durur; lead insan müdahalesine kalır | — |
| "İlgilenmiyorum" benzeri yanıt (anahtar kelime tespiti: "no thanks", "ilgilenmiyoruz", "unsubscribe", "stop" vb.) | Otomatik suppression listesine eklenir, kullanıcıya bildirilir | — |
| Çıkış, bounce, şikâyet | Kalıcı suppression; bir daha asla | Hayır |
| Posta kutusu şikâyet/bounce oranı | Bounce > %3 veya şikâyet > %0,1 ise tüm gönderim otomatik durur ve kullanıcıya uyarı çıkar | Eşik yalnızca sıkılaştırılabilir |
| Gönderim hacmi | Bölüm 4.6 ısınma eğrisi (başlangıç 20/gün) | Tavan aşılamaz |

Bu kurallar `tests/` içinde birim testle doğrulanır (aynı lead'e 4. e-posta kuyruğa alınamaz, aynı alan adına aynı gün 2. e-posta alınamaz, vb.).

### 5.7 Harita ve arayüz
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-UI-01 | Ana ekran: sol liste, sağ Google Haritası (bölünmüş görünüm, oranı sürüklenebilir). Liste ↔ harita seçimleri senkron. | Z |
| FR-UI-02 | İşaretçi renkleri: Yeni (yeşil), Yakında açılacak (mor), Muhtemel (sarı), Yerleşik (gri), Gönderildi (mavi çerçeve), Yanıtladı (yıldız). Kümeleme açık. | Z |
| FR-UI-03 | Haritada bölge çizerek tarama başlatma ve "bu görünümdeki lead'leri seç". | Ö |
| FR-UI-04 | Dashboard: toplam lead, yeni (son 30 gün), yakında açılacak, e-postası bulunan, gönderilen/yanıtlanan, aylık API harcaması, bugünkü kuyruk. | Z |
| FR-UI-05 | Koyu/açık tema, Türkçe/İngilizce arayüz, klavye kısayolları (J/K liste gezinme, E zenginleştir, C kampanyaya ekle). | Ö |
| FR-UI-06 | Boş durumlar ve ilk kullanım rehberi ("Henüz tarama yok → İlk taramanı başlat"). | Z |
| FR-UI-07 | Her ekranda "Bu nedir?" açıklama balonları (teknik olmayan kullanıcı). | Ö |

### 5.8 Uyum ve veri yönetimi
| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-CMPL-01 | Ülke politikası tablosu (Bölüm 8) uygulama içinde düzenlenebilir; her ülke için `izinli / yalnızca genel adres / yasak` modu. | Z |
| FR-CMPL-02 | Suppression listesi: elle ekleme, CSV içe aktarma, otomatik (bounce, çıkış, şikâyet). Alan adı bazlı engelleme de desteklenir. | Z |
| FR-CMPL-03 | "Veriyi sil" talebi geldiğinde tek tıkla lead'in tüm kişisel verisi silinir, yalnızca hash'lenmiş e-posta suppression'da kalır. | Z |
| FR-CMPL-04 | Kişisel veri saklama süresi: temas edilmemiş lead'ler 12 ay sonra otomatik silinir (ayarlanabilir). | Ö |
| FR-CMPL-05 | Yedekleme: veritabanının şifreli dışa aktarımı ve geri yükleme. | Ö |
| FR-CMPL-06 | İşlem kaydı (audit log): kim/ne zaman/ne gönderdi, hangi filtreyle; dışa aktarılabilir (denetim talebi için). | Ö |
| FR-CMPL-07 | **Yalnızca işletmelere (B2B):** kişisel/ücretsiz posta alan adları (gmail.com, hotmail.com, outlook.com, yahoo.com, icloud.com, gmx.* vb.) varsayılan olarak kampanyadan hariç tutulur; hariç tutma sebebi lead'de görünür. Liste ayarlardan genişletilebilir, daraltılamaz. | Z |
| FR-CMPL-08 | Gönderen unvanı, adresi ve sicil numarası olmayan hiçbir şablon gönderilemez; kullanıcı bu alanları şablondan silerse kayıt reddedilir. | Z |

---

## 6. Fonksiyonel Olmayan Gereksinimler

| ID | Kategori | Gereksinim |
|---|---|---|
| NFR-01 | Gizlilik | Tüm veri yerel diskte (SQLite). Telemetri yok. Dışa yalnızca Bölüm 4'teki API'lere bağlantı. |
| NFR-02 | Güvenlik | Anahtarlar OS anahtarlığında; yerel sunucu yalnızca `127.0.0.1`'e bağlanır; CSRF koruması; bağımlılıklar `npm audit` temiz. |
| NFR-03 | Performans | 100.000 lead ile liste filtreleme < 300 ms; harita 5.000 işaretçiyi kümelenmiş olarak akıcı gösterir. |
| NFR-04 | Dayanıklılık | Tüm dış çağrılar üstel geri çekilme ile 3 kez denenir; 429/kota hatalarında tarama otomatik duraklar. |
| NFR-05 | Maliyet güvenliği | Bütçe sayacı her çağrıyı SKU'ya göre tahmini fiyatla kaydeder; tavan aşımında dış çağrı yapılmaz. |
| NFR-06 | Kullanılabilirlik | Teknik olmayan kullanıcı, rehberle 30 dakikada ilk taramayı tamamlayabilmeli. |
| NFR-07 | Taşınabilirlik | macOS ve Windows; Linux "çalışır ama test edilmez". |
| NFR-08 | Bakım | TypeScript, ESLint, Prettier; birim testleri (Vitest) kritik modüllerde (skorlama, uyum kontrolü, e-posta çıkarma) ≥ %80 kapsama. |
| NFR-09 | Yerelleştirme | Arayüz TR/EN; şablonlar çok dilli; tarih/saat alıcı saat dilimine göre. |
| NFR-10 | Güncellenebilirlik | `git pull && npm run migrate` ile sürüm yükseltme; veritabanı göçleri geriye uyumlu. |

---

## 7. Veri Modeli (özet)

```
regions            (id, name, country_code, geometry, grid_size_m, schedule_days, last_scan_at)
category_sets      (id, name, place_types[], keywords[])
scans              (id, region_id, category_set_id, started_at, finished_at, calls_pro, calls_enterprise, est_cost_usd, status)
places             (place_id PK, name, formatted_address, lat, lng, country_code, city, primary_type, types[],
                    business_status, opening_date, website, phone, user_rating_count, google_maps_uri,
                    google_fetched_at, first_seen_scan_id, last_seen_scan_id, stale boolean)
place_snapshots    (scan_id, place_id, business_status, user_rating_count)      -- diff için
leads              (id, place_id FK nullable, source enum[google,registry,import], novelty_score, novelty_label,
                    status enum[new,enriched,queued,sent,replied,not_interested,customer,do_not_contact],
                    language, notes, tags[], created_at, updated_at)
lead_emails        (id, lead_id, email, source_url, kind enum[personal,generic], verify_status, verified_at, is_primary)
lead_contacts      (id, lead_id, type enum[instagram,facebook,contact_form,linkedin], url)
registry_matches   (id, lead_id, registry enum[companies_house,sirene,...], company_number, incorporated_on, match_score)
templates          (id, name, language, category_filter, subject, body_html, body_text, step_index, is_followup)
campaigns          (id, name, template_ids[], mailbox_id, filter_json, send_window_json, daily_cap, status)
campaign_leads     (campaign_id, lead_id, step_index, scheduled_at, sent_at, message_id, status, error)
messages           (id, lead_id, direction enum[out,in], message_id, in_reply_to, subject, snippet, received_at)
suppressions       (email_hash, domain, reason enum[unsubscribe,bounce,complaint,manual], added_at)
mailboxes          (id, provider enum[gmail,smtp], address, daily_cap, warmup_started_at, credentials_ref)
country_policies   (country_code, mode enum[allowed,generic_only,blocked], note)
api_usage          (id, provider, sku, calls, est_cost_usd, day)
settings           (key, value)
audit_log          (id, at, action, entity, entity_id, detail_json)
```

---

## 8. Yasal ve Uyum Gereksinimleri

> Bu bölüm hukuki tavsiye değildir. Yüksek hacme çıkmadan önce bir avukata danışılması önerilir.

### 8.1 Google Maps Platform Hizmet Şartları
- Place ID süresiz saklanabilir; enlem/boylam en fazla **30 gün** önbellekte tutulabilir. Diğer içerik (işletme adı, adres vb.) için toplu indirme ve saklama kısıtlıdır; bu yüzden yalnızca gösterim için kısa süreli tutulur ve yeniden çekilir → FR-DIS-10. **Bu madde canlıya çıkmadan önce Google'ın güncel şartlarından ve avukatla doğrulanmalıdır.**
- Places verisi yalnızca Google haritası ile birlikte gösterilebilir → Google Maps JS API kullanılır.
- Toplu indirme ve veritabanı oluşturma amacıyla kullanım yasaktır; uygulama bu nedenle veriyi "lead yönetimi" bağlamında, tazeleme zorunluluğuyla tutar ve ham Google verisini dışa aktarımda **yalnızca place_id + kullanıcının kendi eklediği/doğruladığı alanlarla** sınırlar (ayarlardan bilinçli olarak açılabilir, uyarıyla).

### 8.2 Ülke bazlı B2B e-posta politikası (başlangıç tablosu)
| Ülke | Kural (özet) | Uygulama modu |
|---|---|---|
| Birleşik Krallık | PECR: kurumsal abonelere izin; kimlik + çıkış zorunlu. Şahıs işletmeleri (sole trader) birey sayılır → genel adres tercih. | `allowed` |
| Türkiye | 6563 s. Kanun m.6/2: tacir/esnafa ön onay aranmaz; ancak İYS kaydı, MERSİS/unvan bilgisi ve ret hakkı (3 iş günü) zorunlu. | `allowed`, ama **varsayılan kapalı** (ihracat odağı); açılırsa İYS kaydı onay kutusu işaretlenmeden gönderim açılmaz |
| Fransa | CNIL: mesleki ilgiyle sınırlı, bilgilendirme + çıkış şartıyla B2B izinli. | `allowed` |
| Hollanda, Belçika, İrlanda, İsveç, Danimarka, Finlandiya, Portekiz, Polonya, Çekya | Genel olarak meşru menfaatle kurumsal adrese B2B izinli; çıkış zorunlu. | `allowed` |
| İspanya | LSSI: önceki ilişki yoksa onay esas; genel kurumsal adres (info@) daha düşük risk. | `generic_only` |
| İtalya | Onay esaslı; B2B istisna dar. | `generic_only` |
| Almanya, Avusturya | UWG §7: B2B dahil **önceden açık onay** gerekir; cezalar yüksek. | `blocked` (yalnızca telefon/posta listesi üretilir) |
| Diğer AB/AEA | Varsayılan temkinli | `generic_only` |

Kullanıcı modu değiştirebilir; `blocked` → `allowed` değişikliği ek bir uyarı ve "hukuki danışmanlık aldım" onayı ister.

### 8.3 Her mesajda zorunlu unsurlar
Gönderen gerçek adı ve firma unvanı, fiziksel posta adresi, çalışan çıkış mekanizması, konu satırının içerikle tutarlılığı, reklam niteliğinin gizlenmemesi, TR için MERSİS numarası.

### 8.4 Kişisel veri (GDPR / KVKK)
`info@` gibi kurumsal adresler kişisel veri sayılmayabilir; `ahmet@kafe.com` gibi adresler kişisel veridir. Meşru menfaat kaydı (LIA) şablonu docs klasöründe tutulur; silme talepleri FR-CMPL-03 ile 72 saat içinde karşılanır; saklama süresi FR-CMPL-04.

### 8.5 Sorumluluk dağılımı ve sözleşme
> Hukuki tavsiye değildir; bir bilişim/yazılım avukatı tarafından gözden geçirilmelidir.

- E-postaların hukuki göndereni ve kişisel veri sorumlusu **müşteri şirkettir**; yazılım sağlayıcı verilere erişmediği ve gönderim kararlarını vermediği için veri işleyen konumunda değildir. Bu durum **yazılımın hiçbir veriyi geliştiriciye göndermemesi** şartına dayanır (NFR-01).
- Google Maps Platform sözleşmesi müşteri ile Google arasındadır (müşterinin hesabı ve anahtarı). Yazılım, Google şartlarına uygun kullanım için tasarlanır (Bölüm 8.1); şartlar değişirse güncelleme sağlayıcı tarafından sağlanır, uyum sorumluluğu ise nihayetinde müşterideki kullanımdadır.
- Sözleşme çerçevesi (kapsam, fikri mülkiyet, kullanım amacı, sorumluluk sınırı, tazminat, garanti reddi, destek süresi) `docs/03-SOZLESME-CERCEVESI.md` dosyasında madde madde listelenmiştir.
- Yazılım, kullanım amacına aykırı kullanımı (bireylere gönderim, engelli ülkeler, temas sınırlarını aşma) teknik olarak zorlaştıracak şekilde tasarlanmıştır; bu, sorumluluk ayrımının savunulabilirliği için bilinçli bir tasarım kararıdır.

---

## 9. Arayüz Tasarım İlkeleri

- **Tek ekran, iki pano:** sol liste/filtre, sağ harita; üstte ince komut çubuğu (arama, bütçe göstergesi, kuyruk sayacı).
- **Renk dili:** yeşil = fırsat (yeni), mor = yakında açılacak, mavi = temas edildi, gri = yerleşik, kırmızı yalnızca hata/engelli için.
- **Tipografi:** Inter; sayılar `tabular-nums`.
- **Hareket:** işaretçi seçildiğinde liste öğesine yumuşak kaydırma; aşırı animasyon yok.
- **Harita stili:** sade açık/koyu Map ID, POI etiketleri kapalı (kendi işaretçilerimiz öne çıksın).
- **Güven:** gönderim gibi geri alınamaz adımlarda her zaman önizleme + açık sayı + tek büyük onay düğmesi.
- Ekran listesi: Dashboard · Keşif (harita+liste) · Lead detayı (yan panel) · Şablonlar · Kampanyalar · Kuyruk/Günlük · Suppression · Ayarlar/Kurulum sihirbazı.

---

## 10. Teknoloji Kararı

| Katman | Seçim | Gerekçe |
|---|---|---|
| Dil | TypeScript (tek dil, uçtan uca) | Teknik olmayan sahip için tek ekosistem; Playwright, Google istemcileri, Gmail API hepsi birinci sınıf |
| Uygulama çatısı | Next.js 15 (App Router) + React 19 | Arayüz + API tek projede; `localhost`'ta çalışır |
| Veritabanı | SQLite + Drizzle ORM | Sıfır kurulum, tek dosya yedek, 100k+ kayıt rahat |
| Arka plan işleri | Ayrı Node işçi süreci (`worker.ts`), kuyruk tablosu SQLite'ta, zamanlayıcı `croner` | Redis vb. dış bağımlılık yok |
| Harita | Google Maps JS API, `@vis.gl/react-google-maps`, `@googlemaps/markerclusterer` | ToS uyumu, istenen görünüm |
| Places istemcisi | `@googlemaps/places` (Node) veya doğrudan REST + field mask | Field mask kontrolü için REST tercih |
| Web tarama | `undici` + `cheerio`; gerekirse `playwright` | Hafif → ağır sıralaması |
| E-posta | `googleapis` (Gmail), `nodemailer` (SMTP), `mailparser` (gelen) | |
| Arayüz bileşenleri | Tailwind CSS + shadcn/ui + TanStack Table/Virtual | Hızlı, erişilebilir, sanal kaydırma |
| Test | Vitest, Playwright (e2e) | |
| Paketleme | v1: `npm start` + başlatıcı betik; v2: Tauri ile tek tıklanabilir masaüstü uygulaması | |

Alternatif değerlendirildi: Python (FastAPI) + React. Scraping tarafında güçlü ancak iki dil/iki paket yöneticisi tek kişilik bakım yükünü artırır. Reddedildi.

---

## 11. Riskler

| Risk | Olasılık | Etki | Önlem |
|---|---|---|---|
| Gönderici alan adının spam'e düşmesi | Orta | Yüksek | Isınma eğrisi, düşük günlük tavan, ayrı gönderim alan adı (`firma-mail.com`), SPF/DKIM/DMARC kontrol ekranı, bounce oranı > %3 ise otomatik durdurma |
| Google API faturası beklenmedik artış | Düşük | Orta | Bütçe tavanı, tarama öncesi tahmin, Pro/Enterprise mask ayrımı |
| Yasal şikâyet (özellikle DE/AT/IT/ES) | Orta | Yüksek | Ülke politikası motoru, varsayılan `blocked/generic_only`, çıkış ve kimlik zorunlu |
| E-posta bulunamayan lead oranı yüksek (%40–60 normal) | Yüksek | Orta | Sosyal medya/iletişim formu yakalama, telefon listesi dışa aktarımı, opsiyonel Hunter |
| Google ToS ihlali algısı (toplu veri) | Düşük | Orta | 30 gün tazeleme, dışa aktarım kısıtı, yalnızca resmi API |
| Google tip adlarının/alanların değişmesi | Orta | Düşük | Tip listesi yapılandırma dosyasında; sürüm notları takip |
| Tek kişilik bakım | Yüksek | Orta | Sade mimari, testler, dokümantasyon, otomatik güncelleme komutu |
| Müşterinin yazılımı amacı dışında kullanması | Düşük | Yüksek | Yazılı sözleşme, ilk açılış kullanım onayı (FR-SET-08), kapatılamayan uyum kuralları, B2B dışı adreslerin hariç tutulması |
| Geliştiriciye yöneltilen sorumluluk iddiası | Düşük | Yüksek | Sözleşmede sorumluluk sınırı ve tazminat maddeleri, veri barındırmama, avukat gözden geçirmesi, mümkünse faturayı şirket üzerinden kesme |
| Google şartlarının değişmesi / API erişiminin kısıtlanması | Orta | Yüksek | Müşterinin kendi anahtarı, Place ID merkezli veri modeli, şirket sicili ve web sitesi kaynaklarıyla çeşitlendirme, bakım dönemi güncellemeleri |

---

## 12. Maliyet Senaryosu (aylık, müşterinin işletme gideri)

Varsayım: 30 şehir × 12 kategori, ızgara ortalaması 3 çağrı → ~1.100 Discovery çağrısı/tarama; ayda 2 tarama; %15 yeni/değişen kayıt için Enrich.

| Kalem | Adet | Maliyet |
|---|---|---|
| Text Search Pro (Discovery) | ~2.200 çağrı | 0 USD (5.000 ücretsiz) |
| Text Search Enterprise (Enrich) | ~700 çağrı | 0 USD (1.000 ücretsiz) |
| Maps JS yükleme | < 1.000 | 0 USD |
| Google Workspace (1 kullanıcı) | 1 | ~7 USD |
| Alan adı | 1 | ~1 USD/ay |
| Hunter.io (opsiyonel, Starter) | — | 0–34 USD |
| **Toplam (temel)** | | **~8 USD/ay** |

Kapsam büyürse (150 şehir):

| Senaryo | Pro çağrı | Enterprise çağrı | Google faturası |
|---|---|---|---|
| 30 şehir, ayda 2 tarama | ~2.200 | ~700 | 0 USD (ücretsiz kota) |
| 150 şehir, ayda 2 tarama | ~11.000 | ~3.500 | ~280 USD |
| 150 şehir, ayda 1 tarama | ~5.500 | ~1.750 | ~15 USD |

Bütçe tavanı bu senaryoları kullanıcıya taramadan önce gösterir. Not: Autocomplete SKU'su (1.000 istekte 2,83 USD) projede kullanılmaz.

---

## 13. Kabul Kriterleri (MVP)

1. Kullanıcı sihirbazla anahtarlarını girip Londra + Amsterdam için "kafe, restoran, fırın" taramasını başlatabilir; tahmini maliyet gösterilir; tarama ≤ 10 dakikada biter.
2. Haritada ve listede sonuçlar görünür; `FUTURE_OPENING` kayıtlar mor işaretçiyle ayrılır.
3. 14 gün sonra tekrar taramada yeni place_id'ler "Yeni" etiketi alır.
4. Seçilen 100 lead için zenginleştirme çalışır; en az %40'ında en az bir e-posta bulunur ve kaynak URL gösterilir.
5. TR ve EN şablon oluşturulur, önizlenir, test e-postası kullanıcıya gelir.
6. 20 lead'lik kampanya: uyum kontrolü Almanya'daki kayıtları hariç tutar ve sebebini yazar; kalanlar günlük tavan ve saat penceresine göre kuyruğa girer; her e-posta "Gönderilmiş" klasöründe görünür ve çıkış bağlantısı içerir.
7. Bir alıcı yanıt verdiğinde lead "yanıtladı" olur ve takip adımı iptal edilir.
8. Bir adres bounce olduğunda suppression listesine düşer ve bir daha kuyruğa alınamaz.
9. Uygulama kapatılıp açıldığında tüm veri ve kuyruk durumu korunur.
10. Aylık API tahmini harcama dashboard'da görünür ve tavana ulaşınca tarama durur.
11. Gönderen firma profili ve ilk açılış kullanım onayı tamamlanmadan gönderim açılamaz; onay audit log'da görünür.
12. gmail.com gibi kişisel adresler kampanyaya alınmaz ve sebebi lead'de yazar.
13. Temiz kurulumda uygulamanın hiçbir geliştirici sunucusuna bağlanmadığı ağ trafiği izlenerek doğrulanır.

---

## Ek A — Başlangıç şablonu örneği (TR, kafe)

**Konu:** {{isletme_adi}} için açılış dönemi sarf malzemesi teklifi

Merhaba,

{{sehir}}'de yeni açılan {{isletme_adi}}'ni gördük, hayırlı olsun. {{kisisel_giris}}

Biz {{firma}} olarak kafelere peçete, karıştırıcı, karton bardak, amerikan servis ve ıslak mendil gibi günlük sarf malzemelerini tek tedarikçiden, düzenli teslimatla sağlıyoruz. Yeni açılan işletmelere ilk siparişte açılış indirimi ve ücretsiz numune gönderiyoruz.

Kısa bir fiyat listesi ve numune göndermemizi ister misiniz? Bu e-postaya yanıt vermeniz yeterli.

İyi çalışmalar,
{{gonderen_ad}} — {{firma}}
{{firma_adres}} · MERSİS: {{mersis_no}} · {{telefon}}
Bu tür e-postalar almak istemiyorsanız: {{cikis_linki}}

## Ek B — Başlangıç şablonu örneği (EN, café)

**Subject:** Opening-week supplies for {{isletme_adi}}

Hi there,

Congratulations on opening {{isletme_adi}} in {{sehir}}. {{kisisel_giris}}

At {{firma}} we supply cafés with napkins, stirrers, paper cups, placemats and wet wipes from a single supplier with regular deliveries. New businesses get an opening discount and free samples on their first order.

Would you like a short price list and a sample pack? Just reply to this email.

Best regards,
{{gonderen_ad}} — {{firma}}
{{firma_adres}} · {{telefon}}
Don't want emails like this? Unsubscribe: {{cikis_linki}}
