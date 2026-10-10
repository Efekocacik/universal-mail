# Universal Mail — Yazılım Gereksinim Spesifikasyonu (SRS)

| Alan | Değer |
|---|---|
| Proje | Universal Mail — Yeni açılan işletmeleri bulup e-posta ile ulaşan yerel satış aracı |
| Sürüm | 1.0 (taslak) |
| Tarih | 8 Ekim 2026 |
| Hedef kullanıcı | Müşteri şirketin yetkilisi (tek kullanıcı); kendi bilgisayarında kurar ve çalıştırır |
| Ticari model | Geliştirici, yazılımı müşteri şirkete fatura keserek teslim eder (bkz. 1.5 ve `docs/03-ANLASMA-NOTU.md`) |
| Dağıtım | Müşteri, hazır kurulum dosyasını (macOS `.dmg` / Windows `.exe`) kendi bilgisayarına kurar. Geliştiricinin bilgisayarında hiçbir şey çalışmaz; internete açık sunucu yok; veri geliştiriciye gitmez |
| Depo | https://github.com/Efekocacik/universal-mail.git |

---

## 1. Giriş

### 1.1 Amaç

Bu belge, **yurt dışı pazarlarda (öncelikle Avrupa)** yeni açılan veya yakında açılacak işletmeleri Google Haritalar ve uygun veri kaynakları aracılığıyla tespit etmeyi, bu işletmelerin iletişim e-posta adreslerini bulmayı ve düzenlenebilir şablonlar kullanarak **tek tek, kontrollü** satış e-postaları göndermeyi amaçlayan masaüstü/yerel web uygulamasının gereksinimlerini tanımlar.

Sistem, **başlangıç aşamasında öncelikli olarak kafe ve pub işletmelerini** hedefleyecek şekilde yapılandırılacaktır. Bununla birlikte restoran, otel, hastane, ofis ve benzeri işletme kategorilerini de kapsayabilecek esnek bir yapıda geliştirilecektir. Kullanıcı, hedef işletme kategorilerini ve tarama yapılacak coğrafi alanı (ülke, şehir veya belirli bir bölge) seçerek arama sonuçlarını ihtiyaçlarına göre filtreleyebilecektir.

Müşteri şirketin ürün grubu; tek kullanımlık çatal-bıçak, Amerikan servis, ıslak mendil, peçete, karton bardak ve benzeri **sarf malzemelerinden** oluşmaktadır. Projenin temel amacı, müşteri şirketin **yurt dışındaki dağıtım ağını genişletmek** ve bu ürünleri düzenli tüketme potansiyeli bulunan yeni işletmelere B2B e-posta iletişimi yoluyla ulaşarak distribütörlük, bayilik veya tedarik ilişkileri kurulmasını desteklemektir.

Türkiye, ihracat odaklı çalışma modeli nedeniyle **varsayılan hedef pazar değildir**. Ancak kullanıcı tarafından ayarlardan etkinleştirilebilir. Türkiye'deki e-posta iletişim süreçlerinde ilgili yasal yükümlülükler ve İYS gereklilikleri dikkate alınacaktır (Bölüm 8.2).

### 1.2 Kapsam

Uygulama aşağıdaki işlevleri yerine getirir:

1. Kullanıcının seçtiği ülke, şehir veya belirli bir coğrafi bölge ile işletme kategorilerine göre Google Places API (New) üzerinden işletme taraması gerçekleştirir. **Başlangıçta kafe ve pub kategorileri önceliklidir;** diğer işletme kategorileri de kullanıcı tarafından seçilebilir.

2. Taramaları belirlenen aralıklarla tekrarlayarak önceki tarama sonuçlarıyla karşılaştırır ve yeni tespit edilen işletmeleri işaretler. Bu sonuçlar, işletmenin kesin açılış tarihi olarak değil, **yeni açılmış olabileceğine ilişkin bir gösterge** olarak değerlendirilir.

3. Veri kaynağı tarafından desteklendiği ölçüde, **yakında açılacak (FUTURE_OPENING)** işletmeleri ayrıca tespit eder ve listeler.

4. Tespit edilen işletmelerin web siteleri üzerinden iletişim e-posta adreslerini araştırır ve bulunan adreslerin geçerliliğini kontrol eder.

5. İşletmeleri ülke, şehir, seçilen coğrafi bölge, kategori, yenilik skoru ve e-posta durumu gibi kriterlere göre filtreleme olanağı sağlar.

6. Tespit edilen işletmeleri **harita ve liste görünümü** üzerinden sunar. Kullanıcı, seçtiği bölgedeki işletmeleri görüntüleyebilir ve filtreleme sonuçlarını inceleyebilir.

7. Farklı dillere ve işletme kategorilerine uyarlanabilen, düzenlenebilir e-posta şablonlarıyla kampanya oluşturulmasını ve gönderimlerin belirlenen sınırlar çerçevesinde kontrollü şekilde yürütülmesini sağlar.

8. Gönderilen e-postalara ilişkin yanıt, teslim edilememe (bounce) ve iletişimden çıkma (unsubscribe) durumlarını takip eder. İletişim süreçlerinde hedef ülkenin ilgili yasal gereklilikleri ve gönderim kısıtları dikkate alınır.

**Kapsam dışı (v1):** SMS/WhatsApp gönderimi, CRM entegrasyonu, çok kullanıcılı erişim, bulut sunucu kurulumu, bireylere (tüketicilere) yönelik gönderimler, hazır e-posta listesi satışı ve müşteri şirket dışında üçüncü taraflar adına gönderim yapılması.

### 1.3 Tanımlar

| Terim | Anlam |
|---|---|
| Lead | Potansiyel müşteri işletme kaydı |
| Place ID | Google Places sisteminde işletmeyi tanımlamak için kullanılan benzersiz kimlik |
| Snapshot | Belirli bir tarih ve bölge için yapılan tarama sonucu |
| Yenilik skoru | İşletmenin ne kadar yeni olabileceğine ilişkin hesaplanan 0–100 arası puan |
| Field mask | Places API'de hangi veri alanlarının talep edileceğini belirten liste; API maliyetini etkiler |
| SKU | Google Maps Platform'da API kullanımının fiyatlandırılmasında kullanılan hizmet kategorisi |
| Suppression list | E-posta gönderimi engellenen adreslerin listesi (abonelikten çıkanlar, şikâyet edenler, kalıcı teslimat hatası alınanlar vb.) |
| İYS | İleti Yönetim Sistemi (Türkiye'de ticari elektronik ileti izinlerinin yönetildiği sistem) |

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
| Yazılım sağlayıcı | Geliştirici | Yazılımı kararlaştırılan kapsamda geliştirir, teslim eder, kararlaştırılan süre boyunca hataları giderir. Müşterinin verisine erişmez, veri barındırmaz. |
| İşleten / gönderen | Müşteri şirket | Tüm hesapların sahibi (Google Cloud, alan adı, Workspace). Kime, ne, kaç kez e-posta göndereceğine karar verir. E-postaların hukuki göndereni ve kişisel veri sorumlusu müşteri şirkettir. |
| Alıcı | Hedef işletme | Çıkış hakkı, silme hakkı ve itiraz hakkı vardır. |

İlkeler (tasarımı bağlar):
1. **Hesaplar müşteriye aittir.** Google Cloud projesi, API anahtarları, alan adı ve posta kutusu müşteri adına açılır; faturalar müşteriye gelir. Geliştiricinin kendi anahtarı hiçbir zaman dağıtılan kuruluma konmaz.
2. **Veri yerelde kalır.** Telemetri, uzak günlük, otomatik raporlama yoktur. Destek gerekirse müşteri ekran paylaşır veya veriyi kendisi dışa aktarır.
3. **Kullanım amacı sınırlıdır.** Yalnızca müşterinin kendi ürünlerinin B2B tanıtımı. Başkası adına gönderim, liste satışı, bireylere gönderim yasaktır (anlaşma notunda ve ilk açılış onayında yazılıdır).
4. **Uyum varsayılan olarak açıktır.** Ülke politikası, çıkış bağlantısı, temas sınırları ve engel listesi kapatılamaz (Bölüm 5.6.1 ve 8).
5. **Çalışma yeri müşterinin bilgisayarıdır.** Uygulama yalnızca müşterinin bilgisayarında, uygulama açıkken çalışır. Geliştiricinin bilgisayarında zamanlayıcı, sunucu veya arka plan işlemi çalışmaz; geliştirici yalnızca kodu yazar ve kurulum dosyasını üretir (Bölüm 2.6).
6. **Garanti kapsamı:** Yazılımın belirtilen şekilde çalışması taahhüt edilir; bulunan e-posta sayısı, teslim edilebilirlik, yanıt oranı veya satış sonucu taahhüt edilmez.

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
- macOS 13+ veya Windows 10/11 (müşterinin kullandığı sisteme göre; ikisi için de kurulum dosyası üretilir).
- Node.js veya başka bir yazılımın ayrıca kurulması **gerekmez**; kurulum dosyası her şeyi içerir.
- Disk: kurulum yaklaşık 300–500 MB, veri tabanı lead sayısına göre birkaç yüz MB.
- İnternet bağlantısı (API çağrıları için).
- Google Cloud hesabı + faturalandırma açık (ücretsiz kota için bile zorunlu).
- Kendi alan adı (örn. `firmaadi.com`) ve bu alan adına bağlı Google Workspace **veya** Microsoft 365 posta kutusu. Kişisel `@gmail.com` adresinden soğuk e-posta gönderimi **tavsiye edilmez** (spam riski ve hesap kapanma riski).

### 2.4 Kısıtlar
| # | Kısıt | Etki |
|---|---|---|
| K1 | Places API'de "açılış tarihi" alanı yalnızca **gelecekte açılacak** işletmeler için dolu (`businessStatus = FUTURE_OPENING`). Geçmişe dönük "ne zaman açıldı" bilgisi yok. | "Yeni açıldı" tespiti snapshot karşılaştırması ve dolaylı sinyallerle yapılmak zorunda. |
| K2 | Google Places verilerinin saklanması, önbelleğe alınması, yeniden kullanılması ve dışa aktarılması Google Maps Platform'un güncel kullanım koşullarına tabidir. Place ID ve diğer veri alanları için farklı kurallar geçerli olabilir. | Google kaynaklı içerik, kullanım hakkı doğrulanmadan kalıcı ve bağımsız bir pazarlama veritabanının temeli olarak kullanılamaz. Veri modeli, Google kaynaklı alanları bağımsız ve hukuka uygun kaynaklardan elde edilen bilgilerden ayıracak şekilde tasarlanır. Canlı kullanım öncesinde ilgili şartlar doğrulanır. |
| K3 | Google ToS: Places verisi Google dışı bir harita üzerinde gösterilemez. | Harita bileşeni Google Maps JavaScript API olmalı (zaten istenen). |
| K4 | Places API e-posta adresi **vermez**. | E-posta ayrı bir zenginleştirme adımıyla (web sitesi tarama) bulunur. |
| K5 | Gmail/Workspace günlük gönderim limiti (Workspace: 2.000/gün; deneme hesabı: 500). Soğuk e-postada güvenli pratik çok daha düşüktür. | Gönderim kuyruğu günlük tavan + ısınma (warm-up) eğrisiyle çalışır. |
| K6 | Ülkelere göre B2B soğuk e-posta mevzuatı farklıdır (Almanya çok katı). | Ülke bazlı gönderim politikası motoru zorunlu. |
| K7 | Tek kullanıcı, yerel kurulum. | Harici kuyruk sistemi (Redis vb.) kullanılmaz. İş kuyruğu SQLite üzerinde tutulur ve işlemler uygulamanın yönettiği yerel worker süreciyle yürütülür. |

### 2.5 Varsayımlar
- Kullanıcı kendi alan adından gönderim yapacak ve SPF/DKIM/DMARC kayıtlarını (kurulum rehberi eşliğinde) ekleyecek.
- Aylık API bütçesi başlangıçta ≤ 50 USD; uygulama bunu aşmamak için kendi bütçe sayacını tutar.
- Türkiye gönderimleri açılırsa müşteri İYS'ye hizmet sağlayıcı olarak kayıt yaptıracaktır.
- Gönderen kimliği (unvan, adres, vergi/sicil numarası) müşteri şirketin bilgileridir; footer'da bu bilgiler yer alır.
- Müşteri, Google Cloud ve posta hesaplarını kendi adına açar ve kendi kartıyla faturalandırır.

### 2.6 Dağıtım ve kurulum modeli

| Konu | Karar |
|---|---|
| Biçim | Masaüstü uygulaması (Electron). Müşteri bir kurulum dosyasını indirir, çift tıklar, uygulama açılır. Komut satırı, Node, terminal gerekmez. |
| Üretim | Kurulum dosyaları geliştiricinin bilgisayarında değil, **GitHub Actions** ile bulutta (macOS ve Windows) derlenir; sonuç GitHub Release olarak yayımlanır. Geliştirici makinesi sadece kod yazmak için kullanılır, derleme/çalıştırma yükü orada oluşmaz. |
| Teslim | Release dosyası müşteriye doğrudan link/dosya olarak verilir; depo özel olduğu için müşteri isterse depoya "okuma" yetkisiyle eklenir. |
| Veri yeri | İşletim sisteminin kullanıcı veri klasörü (macOS: `~/Library/Application Support/UniversalMail`, Windows: `%APPDATA%\UniversalMail`). Veritabanı, ayarlar, yedekler burada. |
| Çalışma | Uygulama açıkken çalışır (tarama, zamanlayıcı, gönderim kuyruğu). Kapatılınca hiçbir şey çalışmaz; sonraki açılışta kaçan işler telafi edilir (FR-DIS-07). Bilgisayar açılışında otomatik başlama **varsayılan kapalı**, ayarlardan açılabilir. |
| Güncelleme | Yeni sürüm = yeni kurulum dosyası; üstüne kurulur, veri korunur, veritabanı göçleri uygulama açılırken otomatik çalışır ve öncesinde otomatik yedek alınır. |
| Kaldırma | Uygulama normal şekilde silinir; veri klasörü için "verilerimi de sil" seçeneği sunulur. |
| İmzalama | Kurulum dosyaları başlangıçta **imzasız** olur. İlk açılışta macOS "tanımlanamayan geliştirici" (sağ tık → Aç), Windows SmartScreen "Yine de çalıştır" uyarısı gösterebilir. Rehberde ekran görüntülü anlatılır. Uyarısız deneyim için Apple Developer (~99 USD/yıl) ve Windows kod imzalama sertifikası gerekir; müşteri isterse sonradan eklenir. |
| Tarayıcı bileşeni | Dinamik siteleri okumak için ayrı Chromium indirilmez; Electron'un kendi gizli penceresi kullanılır (Playwright zorunlu değil). |

---

## 3. Hedef Segmentler ve Kategori Haritası

Sistem, müşteri şirketin ürünlerini tüketme potansiyeli bulunan farklı sektörlerdeki işletmeleri hedefleyecek şekilde tasarlanmıştır. **Başlangıç aşamasında kafe ve pub işletmeleri öncelikli hedef segmentler olarak belirlenecektir.** Bununla birlikte uygulama yalnızca bu iki kategoriyle sınırlı olmayacak; kullanıcı, ihtiyaçlarına göre diğer işletme kategorilerini de taramaya dahil edebilecektir.

Aşağıdaki tablo, hedef segmentlerin Google Places API işletme türleriyle örnek eşleştirmelerini ve genel öncelik seviyelerini göstermektedir. Tip adları, Google'ın güncel listesiyle geliştirme aşamasında doğrulanacaktır.

| Segment | Neden hedef | Google Places tipleri (örnek) | Öncelik |
|---|---|---|---|
| Kafe / kahveci | Peçete, karıştırıcı, bardak, ıslak mendil | `cafe`, `coffee_shop`, `tea_house`, `cat_cafe`, `dog_cafe` | ★★★ |
| Bar / pub / gece kulübü | Peçete, karıştırıcı, bardak | `bar`, `pub`, `wine_bar`, `night_club` | ★★★ |
| Restoran / fast food / paket servis | Çatal-bıçak, Amerikan servis, peçete | `restaurant`, `fast_food_restaurant`, `meal_takeaway`, `meal_delivery`, `pizza_restaurant`, `hamburger_restaurant` ve diğer `*_restaurant` tipleri | ★★★ |
| Fırın / pastane / tatlıcı | Servis malzemesi | `bakery`, `dessert_shop`, `ice_cream_shop`, `donut_shop` | ★★★ |
| Otel / hostel / pansiyon | Kahvaltı servisi, oda ikramı | `hotel`, `hostel`, `bed_and_breakfast`, `guest_house`, `motel`, `resort_hotel` | ★★ |
| Catering / etkinlik mekânı / düğün salonu | Toplu servis | `catering_service`, `event_venue`, `banquet_hall`, `wedding_venue` | ★★ |
| Hastane / klinik / diş / fizik tedavi | Islak mendil, hasta yemeği servisi | `hospital`, `dental_clinic`, `doctor`, `physiotherapist`, `medical_lab` | ★★ |
| Huzurevi / bakım evi / kreş / okul | Yemekhane sarfı | `child_care_agency`, `preschool`, `school`, `university` (huzurevi için Text Search anahtar kelime) | ★ |
| Ofis / ortak çalışma alanı | Mutfak sarfı, ıslak mendil | `corporate_office`, `coworking_space` | ★ |
| Spor salonu / güzellik / kuaför / spa | Islak mendil, tek kullanımlık havlu | `gym`, `fitness_center`, `beauty_salon`, `hair_salon`, `barber_shop`, `nail_salon`, `spa` | ★ |
| Benzinlik marketi / büfe / kantin | Paket servis sarfı | `gas_station`, `convenience_store`, `cafeteria` | ★ |

**Başlangıç yapılandırması:** Uygulama ilk açıldığında kafe ve pub kategorileri varsayılan olarak seçili olacaktır. Diğer kategoriler kullanıcı tarafından etkinleştirilebilecek veya devre dışı bırakılabilecektir.

Kullanıcı, hedef kategorileri arayüz üzerinden yönetebilir ve kendi anahtar kelimelerini (örn. "coffee shop", "specialty coffee", "cocktail bar", "gastropub", "brunch cafe") ekleyebilir. Anahtar kelimeler, hedef ülkenin yerel diline uygun olarak da belirlenebilir.

Tarama yapılacak ülke, şehir veya belirli coğrafi bölge kullanıcı tarafından seçilebilir. Böylece işletme aramaları ve filtreleme işlemleri, belirlenen hedef pazar ve coğrafi alan doğrultusunda gerçekleştirilebilir.

---

## 4. Veri Kaynakları ve API Kararları

### 4.1 Birincil Kaynak: Google Places API (New)

Google Places API (New), hedef ülkelerdeki işletmelerin keşfedilmesi, konum ve kategori bilgilerine ulaşılması ve mevcut kayıtların güncellenmesi için kullanılacaktır. Kullanıcı tarafından seçilen ülke, şehir, coğrafi bölge ve işletme kategorileri doğrultusunda tarama gerçekleştirilecektir.

| Kullanım | Uç nokta | Not |
|---|---|---|
| Bölge ve kategori taraması | **Text Search (New)** `places:searchText` | `includedType`, `locationBias` / `locationRestriction` ve `pageToken` kullanılarak arama yapılır. Sayfa başına en fazla 20, toplamda en fazla 60 sonuç alınabilir. |
| Dar bölge taraması (yoğun merkezler) | **Nearby Search (New)** `places:searchNearby` | En fazla 50 km yarıçap, `includedTypes` listesi ve sorgu başına en fazla 20 sonuç. Sayfalama bulunmadığından yoğun bölgeler daha küçük tarama alanlarına ayrılabilir. |
| Yakında açılacak işletmeler | Desteklenen aramalarda `includeFutureOpeningBusinesses: true` | `businessStatus = FUTURE_OPENING` olan işletmeler tespit edilir. `openingDate` bilgisi mevcut olduğunda alınır. **Öncelikli potansiyel müşteri göstergelerinden biridir.** |
| Tekil kayıt güncelleme | **Place Details (New)** `places/{id}` | Güncellenmesi gereken işletme kayıtları için ilgili alanlar yeniden sorgulanır. Önbellekleme ve veri saklama sürelerinde Google'ın güncel kullanım şartları esas alınır. |

**Tarama yaklaşımı:** Başlangıçta kafe ve pub kategorileri öncelikli olarak taranacaktır. Kullanıcı diğer işletme kategorilerini etkinleştirebilir ve tarama alanını ülke, şehir veya harita üzerinden belirlenen coğrafi bölgeyle sınırlandırabilir. Google Places arama sonuçlarının ilgili bölgedeki tüm işletmeleri eksiksiz kapsaması garanti edilmez.

**Field mask stratejisi (maliyet kontrolü):**

API maliyetlerini kontrol altında tutmak amacıyla ilk işletme keşfi ile ayrıntılı bilgi toplama işlemleri birbirinden ayrılacaktır. Faturalandırma, kullanılan uç nokta ve talep edilen alanların SKU sınıflandırmasına göre hesaplanacaktır.

| Mask adı | Alanlar | Kullanım |
|---|---|---|
| `DISCOVERY` | `places.id`, `places.displayName`, `places.formattedAddress`, `places.location`, `places.types`, `places.primaryType`, `places.businessStatus`, `places.openingDate` | İlk tarama ve snapshot karşılaştırması. Yalnızca gerekli alanlar talep edilir. |
| `ENRICH` | `websiteUri`, `nationalPhoneNumber`, `internationalPhoneNumber`, `userRatingCount`, `googleMapsUri` ve ihtiyaç duyulan temel işletme alanları | Yeni tespit edilen veya kullanıcı tarafından seçilen işletmelerin ayrıntılı bilgilerinin alınması. Tekil kayıtlar için Place Details (New) tercih edilebilir. |

Alan adları ve bunların kullanılabilirliği, seçilen API uç noktasına göre doğrulanacaktır. Özellikle `openingDate` gibi alanlar, yalnızca API tarafından desteklendiği ve veri mevcut olduğu durumlarda kullanılacaktır.

Yorum metinleri (`reviews`) ve proje açısından gerekli olmayan ek alanlar varsayılan olarak talep edilmeyecektir. Böylece gereksiz veri işleme ve API maliyetlerinin önüne geçilmesi hedeflenmektedir.

**API fiyatlandırması ve bütçe kontrolü:**

Google Maps Platform'un fiyatlandırması kullanılan API'ye, talep edilen alanlara, SKU kategorisine ve aylık kullanım miktarına bağlı olarak değişmektedir. Bu nedenle aşağıdaki değerler başlangıç planlaması için referans niteliğindedir ve geliştirme öncesinde güncel resmi fiyatlandırma üzerinden doğrulanacaktır.

| Hizmet | Maliyet değerlendirmesi |
|---|---|
| Text Search (New) | İstenen alanların SKU kategorisine ve aylık sorgu miktarına göre hesaplanır. |
| Nearby Search (New) | Talep edilen alanlara ve kullanım miktarına göre hesaplanır. |
| Place Details (New) | Tekil işletme sorgularında istenen alanların SKU kategorisine göre hesaplanır. |
| Maps JavaScript API | Harita yükleme ve kullanımına ilişkin geçerli fiyatlandırma esas alınır. |

Uygulama, başlangıçta belirlenen **aylık 50 USD API bütçesini** aşma riskini azaltmak amacıyla kullanım ve tahmini maliyet takibi yapacaktır. Bütçe sınırına yaklaşıldığında kullanıcı uyarılacak; uygulamanın kontrolündeki yeni ücretli sorgular belirlenen limite göre durdurulabilecektir. Kesin faturalandırma tutarı için Google Cloud hesabındaki resmi kullanım ve maliyet verileri esas alınacaktır.

**Maliyet hesaplama yaklaşımı:** Örneğin 10.000 işletmenin keşfedilmesi için gereken API çağrısı sayısı, sorgu başına dönen sonuçlara, sayfalama durumuna, tekrarlanan kayıtlara ve tarama alanına bağlıdır. Her sorgunun 20 farklı işletme döndürdüğü varsayımıyla teorik olarak 500 çağrı gerekebilir. Ancak gerçek maliyet, seçilen alanların SKU kategorisi ve ilgili dönemdeki ücretsiz kullanım hakları dikkate alınarak hesaplanacaktır.

Bu nedenle işletme başına sabit maliyet veya belirli sayıda işletmenin kesin olarak bulunacağı yönünde bir garanti verilmez. Projede API maliyetinin yanı sıra veri kalitesi, e-posta adreslerinin bulunabilirliği ve hedef ülkelerdeki yasal uyumluluk gereksinimleri de dikkate alınacaktır.

### 4.2 "Yeni Açıldı" Tespiti — Çok Sinyalli Yaklaşım

Google Places API, geçmişte açılmış işletmelerin kesin açılış tarihini genel olarak sağlamadığından, yeni açılmış olabilecek işletmelerin belirlenmesi için birden fazla veri kaynağından elde edilen göstergeler kullanılacaktır.

Bu göstergeler üzerinden **0–100 arasında bir yenilik skoru** hesaplanacaktır. Skor, işletmenin yeni açılmış olma ihtimalini değerlendirmek amacıyla kullanılacak; kesin açılış tarihi veya doğrulanmış bir bilgi olarak sunulmayacaktır.

| Sinyal | Puan | Açıklama |
|---|---|---|
| `businessStatus = FUTURE_OPENING` | +100 | İşletmenin henüz açılmadığını gösteren güçlü bir sinyaldir. Tedarikçi aradığı anlamına gelmez. |
| Place ID önceki snapshot'ta yok, yeni snapshot'ta var | +70 | İşletmenin önceki taramada tespit edilmediğini gösterir. Gerçek açılış tarihini doğrulamaz. İlk tarama için geçerli değildir. |
| `FUTURE_OPENING` → `OPERATIONAL` geçişi gözlendi | +90 | İşletmenin açılış durumunun değiştiğini gösteren güçlü bir sinyaldir. |
| `userRatingCount` ≤ 5 | +25 | Az sayıda değerlendirme bulunması, yeni işletme olasılığını destekleyebilir; tek başına yeterli değildir. |
| `userRatingCount` 6–20 | +10 | Destekleyici ancak düşük güvenilirlikte bir göstergedir. |
| Şirket sicilinde son 90 gün içinde kuruluş kaydı eşleşti | +60 | İşletme adı ve konum bilgileri üzerinden eşleştirme yapılır. Şirketin kuruluş tarihi ile işletmenin açılış tarihi farklı olabilir. |
| Web sitesi alan adı son 6 ayda kaydedilmiş | +20 | RDAP üzerinden erişilebilen alan adı kayıt bilgileri değerlendirilir. Alan adının yeni olması işletmenin yeni olduğunu kesinleştirmez. |

**Skor hesaplama:** Uygun sinyallerin puanları toplanır ve sonuç en fazla 100 olacak şekilde sınırlandırılır. Aynı durumu temsil eden sinyallerin birlikte değerlendirilmesi sırasında mükerrer puanlamayı önleyecek kurallar uygulanır.

İşletmeler hesaplanan yenilik skoruna göre aşağıdaki şekilde sınıflandırılır:

- **60–100:** Yüksek yenilik olasılığı
- **30–59:** Muhtemel yeni işletme
- **0–29:** Düşük yenilik göstergesi

Bu sınıflandırma, işletmenin kesin olarak yeni açıldığını veya uzun süredir faaliyet gösterdiğini garanti etmez. Skor eşikleri kullanıcı tarafından ayarlardan değiştirilebilir.

**Snapshot stratejisi:**

Her bölge ve kategori kombinasyonu için gerçekleştirilen ilk tarama, sonraki karşılaştırmalarda kullanılacak **başlangıç referansı (baz çizgi)** olarak kabul edilir.

Sonraki taramalar varsayılan olarak **14 günde bir** tekrarlanır. Karşılaştırma işlemleri için `DISCOVERY` kapsamında gerekli veriler alınır; yeni tespit edilen veya durumu değişen işletmeler, ihtiyaç duyulduğunda `ENRICH` aşamasına aktarılır.

Tarama kapsamının, kullanılan kategorilerin veya coğrafi sınırların değişmesi karşılaştırma sonuçlarını etkileyebileceğinden, bu durumlar sistem tarafından dikkate alınır. Önceki taramada bulunmayan her işletme doğrudan yeni açılmış kabul edilmez.

Tüm tarama ve karşılaştırma işlemlerinde Google Places API'nin güncel veri saklama ve kullanım koşullarına uyulur.

### 4.3 İkincil Kaynak: Ücretsiz Şirket Sicilleri (Faz 5)

Resmî şirket sicilleri, yeni kurulan şirketlerin tespit edilmesinde Google Places API'yi tamamlayıcı bir veri kaynağı olarak kullanılacaktır. Bazı işletmelerin kuruluş kayıtları, Google Haritalar'da görünmelerinden önce erişilebilir hâle gelebilir. Bu durum, potansiyel müşterilerin daha erken belirlenmesine katkı sağlayabilir.

Ancak **şirketin kuruluş tarihi, fiziksel işletmenin açılış tarihiyle aynı olmak zorunda değildir.** Bu nedenle sicil kayıtları tek başına kesin açılış bilgisi olarak değerlendirilmeyecek, yenilik skorunu destekleyen ek bir gösterge olarak kullanılacaktır.

| Ülke | Kaynak | Erişim | Filtreleme yaklaşımı |
|---|---|---|---|
| Birleşik Krallık | Companies House Advanced Search API `GET /advanced-search/companies` | API kimlik doğrulamasıyla erişim; güncel kullanım limitleri doğrulanacaktır. | SIC faaliyet kodları ve şirket kuruluş tarihi |
| Fransa | INSEE Sirene API | İlgili erişim ve kimlik doğrulama koşullarına göre | NAF faaliyet kodları ve işletme kuruluş tarihi; kod değişiklikleri dikkate alınacaktır. |
| İrlanda | CRO veri hizmetleri | Açık veri ve erişim koşulları doğrulanacaktır. | Kuruluş tarihi ve NACE faaliyet kodları |
| Belçika | KBO/BCE Open Data | Açık veri kullanım koşullarına göre | NACE faaliyet kodları ve kuruluş bilgileri |
| Almanya | Handelsregister ve uygun üçüncü taraf veri kaynakları | Erişim ve kullanım koşulları değişebilir. | İlk sürümde kapsam dışı |
| Hollanda | KVK API | Ücretli erişim koşulları bulunabilir. | İlk sürümde kapsam dışı |
| Türkiye | MERSİS / Türkiye Ticaret Sicili Gazetesi | Programatik erişim imkânları ayrıca değerlendirilecektir. | İlk sürümde kapsam dışı |

**Kategori ve ülke bazlı filtreleme:**

Şirket sicili taramalarında hedef ülkeye uygun faaliyet kodları kullanılacaktır. Başlangıçta **kafe ve pub işletmeleriyle ilişkili faaliyet alanlarına öncelik verilecek**, sistemin kapsamı genişletildiğinde restoran, otel ve diğer hedef segmentlere ait faaliyet kodları da kullanılabilecektir.

SIC, NAF ve NACE kodları ülkeler arasında farklılık gösterebildiğinden, her ülke için geçerli kod listesi ve veri kaynağının güncel sürümü esas alınacaktır.

**Sicil kayıtlarının Google Places verileriyle eşleştirilmesi:**

Sicil kayıtları, Google Places üzerinden tespit edilen işletmelerle ad, şehir, adres ve mevcut diğer uygun bilgiler kullanılarak eşleştirilecektir. İsim farklılıkları ve eksik bilgiler nedeniyle gerektiğinde bulanık eşleştirme yöntemleri kullanılacaktır.

Eşleşen kayıtlar, yenilik skorunun hesaplanmasında ek gösterge olarak değerlendirilecektir.

Google Haritalar'da eşleşmesi bulunamayan kayıtlar ise **"Sicilde var, haritada eşleşmedi"** durumuyla ayrı bir listede gösterilebilecektir. Bu kayıtlar otomatik olarak yeni açılmış işletme kabul edilmeyecek ve iletişim bilgileri doğrulanmadan gönderim sürecine dahil edilmeyecektir.

Şirket sicillerinden elde edilen verilerin kullanımı, ilgili ülkenin veri erişim şartlarına ve geçerli yasal düzenlemelerine uygun şekilde gerçekleştirilecektir.

### 4.4 Toplu Veri İçin Opsiyonel Ücretli Alternatifler

Yüksek hacimli işletme verisi toplama ihtiyaçlarında (100.000+ kayıt), **Outscraper**, **Apify Google Maps Scraper** ve **SerpApi** gibi üçüncü taraf servisler alternatif olarak değerlendirilebilir.

Ancak bu servislerin kullanımı; Google'ın güncel hizmet şartları, veri kullanım ve saklama kısıtları, ilgili servislerin lisans koşulları ve geçerli veri koruma mevzuatı açısından ayrıca değerlendirilmelidir. Üçüncü taraflardan elde edilen verilerin Google Maps üzerinde gösterilmesi de ilgili kullanım koşullarına uygun olmalıdır.

**Karar:** İlk sürümde (v1) işletme keşfi için yalnızca resmî **Google Places API (New)** kullanılacaktır. Üçüncü taraf servis entegrasyonları v1 kapsamı dışındadır. İlerleyen sürümlerde, gerekli kullanım hakları doğrulanan veri kaynakları için **CSV üzerinden veri içe aktarma** özelliği değerlendirilebilir.

### 4.5 E-posta Bulma (Zenginleştirme)

Sistem, tespit edilen işletmelerin iletişim e-posta adreslerini bulmak amacıyla maliyet ve erişilebilirlik açısından önceliklendirilmiş, üç aşamalı bir yaklaşım kullanacaktır.

**1. İşletmenin kendi web sitesinin taranması (birincil yöntem)**

- Google Places API üzerinden elde edilen `websiteUri` adresi kullanılarak işletmenin resmî web sitesi incelenir.
- Ana sayfanın yanı sıra `/contact`, `/contact-us`, `/kontakt`, `/impressum`, `/mentions-legales`, `/about` gibi iletişim ve kurumsal bilgi sayfaları kontrol edilir.
- Hedef ülkenin diline uygun sayfa adresleri ve bağlantı metinleri dikkate alınır.
- E-posta adresleri; `mailto:` bağlantıları, sayfa metinleri ve `schema.org` JSON-LD yapılandırılmış verileri üzerinden araştırılır.
- Statik HTML içerikleri için `cheerio` kullanılabilir. JavaScript ile oluşturulan sayfaların incelenmesinde gerektiğinde Electron'un mevcut tarayıcı altyapısından yararlanılabilir.
- Tarama sırasında `robots.txt` kuralları ve sitelerin erişim kısıtları dikkate alınır. Varsayılan olarak site başına en fazla 6 istek gerçekleştirilir ve istekler arasında en az 1 saniye beklenir. Uygulama tanımlanabilir bir User-Agent kullanır.
- İşletmenin web sitesinde bulunan Instagram ve Facebook gibi sosyal medya bağlantıları da kaydedilerek lead kartında manuel iletişim amacıyla gösterilebilir.

**2. Harici e-posta bulma servisleri (opsiyonel)**

İşletmenin web sitesinde uygun bir e-posta adresi bulunamadığında, kullanıcı tarafından açıkça etkinleştirilmiş olması koşuluyla harici e-posta bulma servislerinden yararlanılabilir.

Bu kapsamda Hunter.io, Snov.io ve Prospeo gibi servisler değerlendirilebilir.

- Harici servis kullanımı varsayılan olarak kapalıdır.
- Kullanıcı gerekli API anahtarını kendi hesabından sağlar.
- Servislerin kullanım limitleri, ücretlendirmeleri ve veri işleme koşulları dikkate alınır.
- Harici servislere yalnızca gerekli işletme veya alan adı bilgileri aktarılır.

**3. E-posta adreslerinin doğrulanması**

Bulunan e-posta adresleri, gönderim öncesinde aşağıdaki kontrollerden geçirilebilir:

- E-posta adresinin sözdizimi kontrolü.
- Alan adının DNS ve MX kayıtlarının incelenmesi.
- Tek kullanımlık (disposable) e-posta alan adlarının kontrol edilmesi.
- Gerektiğinde, teknik ve hukuki koşullar uygun olduğunda ek doğrulama yöntemlerinin kullanılması.
- Kullanıcının etkinleştirmesi durumunda ZeroBounce veya NeverBounce gibi harici doğrulama servislerinden yararlanılması.

Bu kontroller, e-posta adresinin kesin olarak aktif olduğunu veya gönderilen iletinin teslim edileceğini garanti etmez.

**E-posta durumu (`email_status`)**

| Durum | Açıklama |
|---|---|
| `found_verified` | Tanımlanan doğrulama kontrollerini başarıyla geçmiş e-posta adresi |
| `found_unverified` | Bulunmuş ancak doğrulaması tamamlanmamış e-posta adresi |
| `generic` | `info@`, `hello@`, `contact@` gibi genel işletme iletişim adresi |
| `not_found` | İşletme için e-posta adresi bulunamadı |
| `invalid` | Geçersiz olduğu tespit edilen e-posta adresi |

Bulunan adresin türü, kaynağı ve doğrulama durumu mümkün olduğunca kayıt altında tutulacaktır.

**Yasal uyumluluk:** Bir e-posta adresinin kamuya açık bir web sitesinde bulunması, o adrese ticari elektronik ileti gönderilmesine otomatik olarak izin verildiği anlamına gelmez. Gönderim kararı, hedef ülkenin ilgili mevzuatı ve sistemin ülke bazlı gönderim politikaları doğrultusunda verilecektir.

### 4.6 E-posta Gönderimi

Sistem, potansiyel müşterilere ticari teklif e-postalarının gönderilmesi için kullanıcının kendi kurumsal e-posta hesabını kullanacaktır. Gönderim altyapısı, güvenli kimlik doğrulama, sağlayıcı limitleri, ülke bazlı yasal uygunluk ve gönderim geçmişinin takip edilmesi esas alınarak tasarlanacaktır.

| Seçenek | Uygunluk | Karar |
|---|---|---|
| **Gmail API (Google Workspace, kurumsal alan adı)** | OAuth 2.0 ile güvenli yetkilendirme sağlar. Gönderilen mesajlar ve yanıtlar aynı kurumsal hesap üzerinden yönetilebilir. Günlük gönderim limitleri hesap türüne ve sağlayıcı politikalarına bağlıdır. | **v1 birincil** |
| Microsoft 365 (Microsoft Graph API / OAuth destekli SMTP) | Kurumsal hesaplarla güvenli gönderim için uygundur. Kullanılan yönteme göre yapılandırma ve yetkilendirme gerektirir. | v1 alternatif |
| Genel SMTP (`nodemailer`) | SMTP erişimi ve gerekli kimlik doğrulama yöntemlerini destekleyen sağlayıcılarla kullanılabilir. | v1 destek |
| Amazon SES | Yüksek hacimli gönderimler için değerlendirilebilir. Hesap onayı, kullanım politikaları ve gönderici itibarı gereksinimleri bulunur. | v2 opsiyon |
| Resend / Brevo / SendGrid | Ticari ileti ve istenmeyen e-posta politikaları nedeniyle kullanım uygunluğu ayrıca değerlendirilmelidir. | v1 kapsamında kullanılmaz |
| Instantly / Smartlead / lemlist | İleri düzey kampanya yönetimi sağlayabilir. Kullanım maliyetleri ve hizmet koşulları ayrıca değerlendirilir. | İlerleyen sürümlerde CSV dışa aktarımıyla desteklenebilir |

**Gönderim politikası (varsayılanlar, yapılandırılabilir):**

- **Günlük gönderim limiti:** Başlangıçta posta kutusu başına en fazla 20 e-posta.
- **Kademeli artış:** Gönderim performansı uygun olduğunda haftalık 10 e-posta artırılabilir. Varsayılan üst sınır günlük 80 e-postadır. Artış otomatik olarak garanti edilmez.
- **Gönderimler arası bekleme:** Varsayılan olarak 90–240 saniye arasında değişen aralıklar uygulanır.
- **Gönderim saatleri:** Alıcının yerel saatine göre hafta içi 09.00–17.00.
- **Gönderici bilgileri:** E-postalarda gerçek gönderici kimliği, işletmenin iletişim bilgileri ve geçerli mevzuatın gerektirdiği diğer bilgiler bulunur.
- **İletişimden çıkma:** Uygun bir abonelikten çıkma veya iletişimden vazgeçme yöntemi sağlanır. Çıkma talepleri kayıt altına alınır ve ilgili adreslere tekrar ticari ileti gönderilmesi engellenir.
- **Yasal uygunluk:** Hedef ülkenin ticari elektronik ileti kuralları değerlendirilir. Gerekli izin veya başka bir geçerli hukuki dayanak bulunmayan adreslere otomatik gönderim yapılmaz.

**Gönderim kontrolü ve takip:**

Sistem, gönderim öncesinde e-posta adresinin durumunu, daha önce ileti gönderilip gönderilmediğini, iletişimden çıkma taleplerini ve ülke bazlı gönderim uygunluğunu kontrol edecektir.

Başarılı gönderimler, başarısız denemeler ve sağlayıcı tarafından bildirilen hatalar kayıt altına alınacaktır. Kota aşımı, geçici servis hatası veya yüksek teslim edilememe oranı gibi durumlarda gönderim işlemleri duraklatılabilecek ve kullanıcı bilgilendirilecektir.

Gönderim limitleri ve bekleme süreleri, sağlayıcının kullanım şartlarını aşmak veya istenmeyen e-posta filtrelerini atlatmak amacıyla kullanılmayacaktır. Bu ayarlar yalnızca kontrollü gönderim ve kaynak yönetimi amacı taşır.

### 4.7 Harita Görünümü

İşletmelerin coğrafi dağılımını görselleştirmek ve kullanıcının hedef bölgeleri harita üzerinden inceleyebilmesini sağlamak amacıyla **Google Maps JavaScript API** kullanılacaktır.

Harita entegrasyonu için `@vis.gl/react-google-maps` kütüphanesi tercih edilecektir. Özel Map ID ve Cloud-based map styling aracılığıyla sade ve kullanıcı dostu bir harita görünümü oluşturulacaktır.

İşletmelerin harita üzerinde gösterilmesinde **Advanced Markers**, yoğun bölgelerdeki işaretçilerin gruplandırılmasında ise `@googlemaps/markerclusterer` kullanılacaktır.

Kullanıcı, seçtiği ülke, şehir, bölge ve işletme kategorilerine göre harita üzerindeki sonuçları filtreleyebilecektir.

Harita kullanım maliyetleri, Google Maps Platform'un güncel fiyatlandırması ve ücretsiz kullanım limitleri doğrultusunda değerlendirilecek; gereksiz harita yüklemelerinden kaçınılacaktır.

### 4.8 Opsiyonel: Yapay Zekâ ile Kişiselleştirme

Potansiyel müşterilere gönderilecek teklif e-postalarının daha ilgili ve kişiselleştirilmiş hazırlanabilmesi amacıyla opsiyonel bir yapay zekâ entegrasyonu sunulabilir.

Bu özellik kapsamında **Claude API** kullanılarak işletmenin web sitesinde veya erişilebilir menüsünde bulunan bilgilerden yararlanılarak 1–2 cümlelik kişiselleştirilmiş bir e-posta giriş metni oluşturulabilir.

- Kullanıcı kendi API anahtarını tanımlamadığı sürece özellik devre dışı kalır.
- Kullanılacak model, geliştirme aşamasında desteklenen Claude modelleri arasından belirlenir.
- Yapay zekâya yalnızca kişiselleştirme için gerekli bilgiler gönderilir.
- Üretilen metin, işletme hakkında doğrulanmamış iddialar içermemelidir.
- Oluşturulan içerik **her zaman gönderim öncesinde kullanıcıya gösterilir ve kullanıcı onayı olmadan gönderilmez.**
- API kullanımından doğabilecek maliyetler kullanıcıya bildirilir.

Bu özellik, temel işletme keşfi ve e-posta gönderim süreçlerinden bağımsız, opsiyonel bir geliştirme olarak değerlendirilecektir.

---

## 5. Fonksiyonel Gereksinimler

Öncelik: **Z** = Zorunlu (MVP), **Ö** = Önemli, **İ** = İsteğe bağlı.

### 5.1 Kurulum ve Ayarlar

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-SET-01 | Uygulama, desteklenen işletim sistemleri için hazır kurulum dosyası (macOS `.dmg`, Windows `.exe`) ile dağıtılır. Son kullanıcıdan ayrıca Node.js veya geliştirme araçları kurması beklenmez. İlk açılışta gerekli veri klasörünü ve yerel veritabanını oluşturur. Geliştirme ortamı için ayrıca `npm run setup` komutu bulunur. | Z |
| FR-SET-02 | İlk açılışta **Kurulum Sihirbazı** sunulur. Google API anahtarı, gönderim hesabı (Gmail OAuth veya desteklenen SMTP yöntemi), firma bilgileri ve varsayılan dil bu aşamada yapılandırılır. | Z |
| FR-SET-03 | API anahtarları ve OAuth token'ları, mümkün olduğunda işletim sistemi anahtarlığında (macOS Keychain / Windows Credential Manager) veya uygun şekilde şifrelenmiş güvenli depolamada saklanır. Gizli bilgiler düz metin `.env` dosyasında tutulmaz. | Z |
| FR-SET-04 | Google API anahtarı girildiğinde uygun bir test çağrısı yapılır. Yetkilendirme, faturalandırma, kota veya erişim hataları kullanıcıya anlaşılır Türkçe mesajlarla gösterilir. | Z |
| FR-SET-05 | Aylık API bütçe tavanı (USD) kullanıcı tarafından belirlenir. Uygulama tahmini API harcamasını takip eder, bütçenin %80'ine ulaşıldığında uyarı verir ve %100'e ulaşıldığında uygulama tarafından başlatılan otomatik taramaları durdurur. Tahmini maliyetin Google Cloud'un kesin faturalandırma tutarı olmadığı kullanıcıya belirtilir. | Z |
| FR-SET-06 | SPF, DKIM ve DMARC yapılandırması için kurulum rehberi sunulur. Kullanıcının gönderici alan adına ait DNS kayıtları kontrol edilerek eksik veya hatalı yapılandırmalar hakkında bilgilendirme yapılır. | Ö |
| FR-SET-07 | **Gönderen firma profili** zorunludur. Ticari unvan, adres, ilgili vergi veya ticaret sicil numarası, telefon ve ihracat sorumlusu adı kaydedilir. Gerekli bilgiler tamamlanmadan e-posta gönderimi etkinleştirilmez. E-postalardaki gönderici ve iletişim bilgileri bu profilden oluşturulur. | Z |
| FR-SET-08 | **İlk açılış kullanım onayı:** Uygulamanın kullanım amacı (firmanın kendi ürünlerinin B2B tanıtımı), gönderenin sorumlulukları, hedef ülkelere ilişkin gönderim politikaları ve iletişim sınırları kullanıcıya sunulur. Yetkili kişi onay vermeden uygulamanın gönderim ve veri toplama işlevleri etkinleştirilmez. Onay sürümü, tarihi ve onaylayan kişinin adı audit log'a kaydedilir. | Z |
| FR-SET-09 | **Hedef pazar seçimi:** Kurulum sırasında kullanıcıya ihracat yapılacak ülkeler sorulur ve hedef ülke listesi oluşturulur. İşletme keşfi ve kampanyalar varsayılan olarak seçilen ülkelerle sınırlandırılır. Türkiye başlangıçta seçili değildir; kullanıcı tarafından sonradan etkinleştirilebilir. | Z |

### 5.2 Tarama (Discovery)

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-DIS-01 | Kullanıcı bir **tarama bölgesi** tanımlar. Ülke ve şehir seçimi yapabilir veya harita üzerinde dikdörtgen/daire çizerek belirli bir coğrafi alanı hedefleyebilir. Başlangıçta Avrupa ülkeleri önceliklidir; Türkiye de kullanıcı tarafından seçilebilir. Ülke ve şehir listeleri genişletilebilir yapıdadır. | Z |
| FR-DIS-02 | Kullanıcı, Bölüm 3'te tanımlanan **işletme kategorileri** arasından seçim yapar ve isteğe bağlı olarak serbest anahtar kelimeler ekleyebilir. **İlk kullanımda kafe ve pub kategorileri varsayılan olarak seçili gelir.** Diğer kategoriler kullanıcı tarafından etkinleştirilebilir veya devre dışı bırakılabilir. | Z |
| FR-DIS-03 | Sistem, geniş tarama bölgelerini Google Places API'nin sonuç limitlerini dikkate alarak daha küçük alanlara böler. İşletme yoğunluğuna göre tarama alanları uyarlanabilir. Amaç kapsama oranını artırmaktır; API sonuç limitleri nedeniyle bölgedeki tüm işletmelerin eksiksiz bulunması garanti edilmez. | Z |
| FR-DIS-04 | Desteklenen Google Places aramalarında `includeFutureOpeningBusinesses: true` parametresi kullanılır. `FUTURE_OPENING` durumundaki işletmeler tespit edildiğinde kaydedilir; `openingDate` bilgisi API tarafından sağlanıyorsa ilgili kayda eklenir. | Z |
| FR-DIS-05 | Tarama başlamadan önce kullanıcıya **tahmini API çağrısı sayısı ve maliyet** gösterilir. Kullanıcı onay verdikten sonra tarama başlatılır. Gerçek kullanımın tahminden farklı olabileceği belirtilir. | Z |
| FR-DIS-06 | Tarama işlemleri arka planda yürütülür. Kullanıcı ilerleme durumunu görüntüleyebilir, taramayı duraklatabilir ve devam ettirebilir. Uygulama kapatıldığında tamamlanmamış taramanın durumu saklanır; sonraki açılışta kaldığı yerden devam ettirilebilir. | Z |
| FR-DIS-07 | Kullanıcı, her tarama bölgesi için **7, 14 veya 30 günlük** tekrar aralığı belirleyebilir. Varsayılan aralık 14 gündür. Zamanlanmış taramalar uygulama açıkken çalışır; uygulama kapalıyken kaçırılan çalışmalar sonraki açılışta kullanıcı ayarları ve bütçe sınırları doğrultusunda değerlendirilir. | Ö |
| FR-DIS-08 | Sistem, karşılaştırılabilir tarama sonuçları üzerinden **snapshot karşılaştırması** gerçekleştirir. Önceki taramada bulunmayan Place ID'ler "yeni tespit edildi" olarak işaretlenir. Önceden bulunan ancak sonraki taramada görünmeyen işletmeler "son taramada bulunamadı" olarak işaretlenir; yalnızca bu nedenle kapandıkları varsayılmaz. | Z |
| FR-DIS-09 | Her işletme için Bölüm 4.2'de tanımlanan göstergeler kullanılarak **yenilik skoru** hesaplanır ve lead detaylarında gösterilir. Kullanıcı skor eşiklerini ayarlardan değiştirebilir. | Z |
| FR-DIS-10 | Google Places API üzerinden elde edilen veriler, Google Maps Platform'un güncel veri saklama, önbellekleme ve kullanım koşullarına uygun şekilde yönetilir. Gerekli durumlarda kayıtlar yeniden sorgulanır, güncellenir veya silinir. Place ID ve diğer alanlar için geçerli olabilecek farklı saklama kuralları dikkate alınır. | Z |
| FR-DIS-11 | **Şirket sicili tarayıcıları (Faz 5):** Birleşik Krallık Companies House ve Fransa Sirene gibi kaynaklardan faaliyet kodları ve tarih aralıklarına göre kayıtlar sorgulanabilir. Elde edilen veriler Google Places kayıtlarıyla uygun eşleştirme yöntemleri kullanılarak ilişkilendirilebilir. | İ (Faz 5) |
| FR-DIS-12 | Kullanıcı, **CSV/XLSX dosyalarından işletme listelerini içe aktarabilir.** İşletme adı, adres, web sitesi ve ülke gibi alanlar desteklenir. İçe aktarılan kayıtlar veri kaynağı belirtilerek mevcut lead yönetimi sürecine dahil edilir; mükerrer kayıt kontrolü ve veri kullanım uygunluğu dikkate alınır. | Ö |

### 5.3 Lead Havuzu ve Filtreleme

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-LEAD-01 | Tüm lead'ler tek bir tabloda görüntülenir. Sütunlar: işletme adı, kategori, şehir, ülke, yenilik skoru/etiketi, e-posta durumu, telefon, web sitesi, son temas tarihi ve kampanya durumu. | Z |
| FR-LEAD-02 | Kullanıcı birden fazla filtreyi birlikte uygulayabilir: ülke, şehir, kategori, yenilik etiketi, e-posta durumu, `businessStatus`, değerlendirme sayısı aralığı, "hiç temas edilmedi", "yanıt verdi", "iletişimden çıktı", tarama tarihi aralığı ve sicil eşleşmesi var/yok. Yalnızca ilgili verisi bulunan kayıtlar için geçerli filtreler uygulanır. | Z |
| FR-LEAD-03 | Kullanıcı sık kullandığı filtre kombinasyonlarını isimlendirerek kaydedebilir (ör. "Londra yeni kafeler", "Paris yakında açılacak publar") ve daha sonra yeniden kullanabilir. | Ö |
| FR-LEAD-04 | Lead detay panelinde işletmeye ait mevcut bilgiler, harita konumu, Google Haritalar bağlantısı, bulunan e-posta adresleri ve kaynak sayfaları gösterilir. Ayrıca işletmenin işlem geçmişi zaman çizelgesi şeklinde sunulur (tespit edildi → zenginleştirildi → gönderildi → yanıt alındı). E-posta açılma bilgisi yalnızca teknik olarak desteklendiğinde ve ilgili gizlilik kurallarına uygun olduğunda gösterilir. | Z |
| FR-LEAD-05 | Kullanıcı lead bilgilerini manuel olarak düzenleyebilir; e-posta adresi ekleyebilir veya düzeltebilir, not ve etiket oluşturabilir, işletmeyi "ilgilenmiyor" veya "müşteri oldu" durumuna alabilir. İletişimden çıkma talepleri ayrıca korunur ve sonraki gönderimlerde dikkate alınır. | Z |
| FR-LEAD-06 | Kullanıcı seçili lead'ler üzerinde toplu işlemler gerçekleştirebilir: kampanyaya ekleme, zenginleştirme, etiketleme, dışa aktarma ve silme. Toplu işlemlerde gerekli uygunluk kontrolleri yapılır; silme gibi geri alınması zor işlemler için kullanıcı onayı istenir. | Z |
| FR-LEAD-07 | Sistem, aynı Place ID, web sitesi alan adı veya işletme adı ve posta kodu gibi bilgiler üzerinden olası yinelenen kayıtları tespit eder. Kesin eşleşmeler ile olası eşleşmeler ayırt edilir; belirsiz kayıtlar kullanıcı onayı olmadan birleştirilmez. | Z |
| FR-LEAD-08 | Kullanıcı, lead listesini uyguladığı filtrelere göre CSV veya XLSX formatında dışa aktarabilir. Dışa aktarılan alanlar mevcut veri kullanım koşulları ve erişim izinleri doğrultusunda sınırlandırılır. | Z |

### 5.4 Zenginleştirme (E-posta Bulma)

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-ENR-01 | Kullanıcı tarafından seçilen lead'ler için e-posta bulma süreci Bölüm 4.5'te tanımlanan öncelik sırasıyla yürütülür. İşletmenin resmî web sitesi ve uygun iletişim sayfaları taranır. Bulunan her e-posta adresi, kaynak URL'si ve tespit tarihiyle birlikte kaydedilir. | Z |
| FR-ENR-02 | Bulunan e-posta adresleri için sözdizimi, DNS/MX ve tek kullanımlık alan adı kontrolleri otomatik gerçekleştirilir. Ek doğrulama yöntemleri, teknik uygunluk ve ilgili kullanım koşulları değerlendirilerek ayarlardan etkinleştirilebilir. Doğrulama sonuçları kesin teslimat garantisi olarak değerlendirilmez. | Z |
| FR-ENR-03 | `info@`, `hello@`, `kontakt@` gibi genel işletme adresleri `generic` olarak sınıflandırılır. Kişiye ait adresler ayrıca ayırt edilir. Gönderimde kullanılacak adres, iletişim amacı ve hedef ülkenin yasal gereksinimleri dikkate alınarak belirlenir. | Ö |
| FR-ENR-04 | Hunter.io veya Snov.io gibi harici e-posta bulma servisleri, yalnızca kullanıcı API anahtarını tanımlayıp **"Yerel taramada bulunamayanlar için kullan"** seçeneğini etkinleştirdiğinde çalışır. Servis tarafından sağlanabiliyorsa kalan kullanım kotası gösterilir; olası ücretler kullanıcıya bildirilir. | İ |
| FR-ENR-05 | Web sitesi taramalarında aynı anda en fazla **4 site** işlenir. Başarısız işlemler, hata türü dikkate alınarak varsayılan olarak 24 saat sonra en fazla bir kez yeniden denenir. Erişim yasağı veya açık engelleme bulunan durumlarda otomatik tekrar yapılmaz. | Z |
| FR-ENR-06 | İşletmenin web sitesinde bulunan sosyal medya hesapları ve iletişim formu bağlantıları kaydedilir. E-posta adresi bulunamadığında kullanıcıya mevcut iletişim formu üzerinden **manuel iletişim** seçeneği gösterilebilir. | Ö |

### 5.5 Şablonlar

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-TPL-01 | Zengin metin ve HTML destekli şablon editörü sunulur. Konu ve gövde düzenlenebilir. Desteklenen değişkenler: `{{isletme_adi}}`, `{{sehir}}`, `{{kategori}}`, `{{acilis_tarihi}}`, `{{gonderen_ad}}`, `{{firma}}`, `{{firma_adres}}`, `{{telefon}}`, `{{cikis_linki}}`, `{{kisisel_giris}}`. Veri bulunmayan değişkenler için uyarı veya güvenli alternatif metin kullanılır; eksik bilgiler uydurulmaz. | Z |
| FR-TPL-02 | Şablonlar dil bazlı yönetilir (TR, EN, DE, FR, ES, IT, NL, PT, PL ve eklenebilir diller). Lead'in ülkesine göre önerilen dil otomatik seçilebilir; kullanıcı değiştirebilir. Ülke bilgisinin alıcının tercih ettiği dili kesin olarak göstermediği dikkate alınır. | Z |
| FR-TPL-03 | İşletme kategorilerine göre farklı şablonlar ve A/B konu satırı varyantları oluşturulabilir. Başlangıçta kafe ve pub kategorilerine yönelik şablonlar önceliklidir. | Ö |
| FR-TPL-04 | Kullanıcı gerçek bir lead üzerinden canlı şablon önizlemesi yapabilir. Eksik değişkenler, doğrulanmamış açılış tarihi ve zorunlu gönderici bilgilerindeki eksiklikler gösterilir. | Z |
| FR-TPL-05 | İlk e-postadan sonra en fazla **2 takip e-postası** tanımlanabilir. Takipler arasında en az 5 gün bulunur. Yanıt, iletişimden çıkma, kalıcı teslimat hatası veya gönderim uygunluğunun kaybedilmesi durumunda kalan takipler iptal edilir. Her takip adımı için ayrı şablon kullanılabilir. | Ö |
| FR-TPL-06 | Şablonlara zorunlu gönderici ve iletişim bilgileri otomatik eklenir: ticari unvan, fiziksel adres ve gerekli çıkış yöntemi. İlgili ülkenin mevzuatının gerektirdiği sicil veya vergi bilgileri de eklenir. Kullanıcı bu zorunlu bilgileri kaldıramaz; firma profili üzerinden güncelleyebilir. | Z |
| FR-TPL-07 | Şablonlarda yanıltıcı veya riskli ifadeler için içerik kontrolü sunulur. Kullanıcı ilk gönderim öncesinde kendi adresine test e-postası gönderebilir. Bu kontrol, iletinin spam olarak değerlendirilmemesini garanti etmez. | Z |
| FR-TPL-08 | Uygulama, başlangıçta Türkçe ve İngilizce hazır şablonlarla gelir. Kafe ve pub şablonları önceliklidir; restoran, otel ve klinik gibi diğer hedef segmentler için de örnekler sunulabilir. | Z |

### 5.6 Kampanya ve Gönderim

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-CMP-01 | Kampanya; hedef lead seçimi veya filtre, şablon seti, gönderim zaman aralığı ve gönderici posta kutusundan oluşur. Kullanıcı kampanyayı dört aşamalı bir sihirbaz üzerinden oluşturabilir. | Z |
| FR-CMP-02 | Lead kampanyaya eklenirken ve gönderimden hemen önce **uygunluk kontrolü** yapılır. Suppression listesi, ülke politikası (Bölüm 8), e-posta doğrulama durumu ve Bölüm 5.6.1 temas sıklığı kuralları kontrol edilir. Uygun olmayan kayıtlar gerekçeleriyle gösterilir ve gönderim dışında bırakılır. | Z |
| FR-CMP-03 | Gönderim kuyruğu Bölüm 4.6'da tanımlanan günlük limitleri, gönderimler arası beklemeyi ve alıcının yerel saatine göre belirlenen gönderim penceresini uygular. Sağlayıcı kotaları ve geçerli kullanım koşulları ayrıca dikkate alınır. | Z |
| FR-CMP-04 | Kampanya başlamadan önce kullanıcıya gönderilecek tahmini e-posta sayısı, planlanan zaman aralığı ve örnek mesaj önizlemeleri gösterilir. Kullanıcı **Başlat** komutunu vermeden kampanya gönderimi başlamaz. Başlatılan kampanyanın planlanan adımları, geçerli uygunluk kontrollerinden geçmek koşuluyla otomatik yürütülebilir. | Z |
| FR-CMP-05 | Kullanıcı kampanyayı duraklatabilir, devam ettirebilir veya iptal edebilir. Gönderim kuyruğu görüntülenebilir ve henüz gönderilmemiş kayıtlar tek tek çıkarılabilir. | Z |
| FR-CMP-06 | Desteklenen posta sağlayıcılarında teslim edilememe bildirimleri (bounce/DSN) izlenir. Kalıcı teslimat hatası doğrulanan adresler suppression listesine eklenir. Geçici hatalar ayrı değerlendirilir. Bildirim alınamaması, iletinin başarıyla teslim edildiği anlamına gelmez. | Z |
| FR-CMP-07 | Gelen yanıtlar, sağlayıcının desteklediği mesaj ve konuşma kimlikleri ile `In-Reply-To` ve `References` gibi başlıklar kullanılarak ilgili lead ve kampanyayla eşleştirilir. Eşleşen yanıt sonrasında otomatik takip adımları durdurulur ve lead insan değerlendirmesine bırakılır. | Z |
| FR-CMP-08 | Her ticari e-postada erişilebilir bir **iletişimden çıkma yöntemi** bulunur. Uygun altyapı sağlandığında `List-Unsubscribe` ve `List-Unsubscribe-Post` başlıkları desteklenir. Gerçek tek tıklamalı çıkış için gerekli HTTPS uç noktası veya eşdeğer güvenilir hizmet sağlanır; yalnızca `mailto:` bağlantısı tek tıklamalı çıkış olarak kabul edilmez. Gelen çıkış talepleri mümkün olan en kısa sürede işlenir ve yeni gönderimler derhal engellenir. | Z |
| FR-CMP-09 | E-posta açılma takibi varsayılan olarak kapalıdır. Etkinleştirilmesi, geçerli gizlilik ve veri koruma gereksinimlerine uygunluk değerlendirmesine bağlıdır. Açılma verilerinin kesin olmadığı kullanıcıya belirtilir. Tıklama takibi v1 kapsamı dışındadır. | İ |
| FR-CMP-10 | Her gönderim için tarih/saat, alıcı, konu, gönderici hesap, durum ve varsa hata bilgisi kaydedilir. Kullanıcı gönderim günlüğünü uygun veri koruma koşulları çerçevesinde dışa aktarabilir. | Z |
| FR-CMP-11 | Bölüm 5.6.1'deki **temas sıklığı sınırları**, tüm kampanyalarda ve her gönderim öncesinde uygulanır. Kullanıcı bu sınırları yalnızca daha kısıtlayıcı olacak şekilde değiştirebilir. | Z |

#### 5.6.1 Temas Sıklığı Sınırları ("Rahatsız Etme" Kuralları)

Amaç, aynı işletmeye gereğinden fazla ileti gönderilmesini önlemek, olumsuz geri bildirimleri azaltmak ve iletişim tercihlerine saygı göstermektir.

Bu kurallar kampanya ayarlarından bağımsız olarak her gönderim öncesinde uygulanır. Yasal gönderim uygunluğu bulunmayan durumlarda aşağıdaki sayısal sınırların karşılanması tek başına gönderim izni sağlamaz.

| Kural | Varsayılan | Kullanıcı değiştirebilir mi? |
|---|---|---|
| Aynı işletme veya aynı e-posta adresine bir iletişim dizisinde gönderilecek toplam mesaj | İlk e-posta ve en fazla 2 takip olmak üzere **3 mesaj** | Yalnızca azaltabilir |
| Takip mesajları arasındaki süre | En az **5 gün** | Yalnızca artırabilir |
| Yanıt alınmadan dizi tamamlandığında | Lead "yanıt yok, dinlenmede" durumuna alınır; en az **180 gün** yeni kampanyaya eklenmez | Yalnızca artırabilir |
| Bekleme süresi sonrasında yeniden temas | Otomatik yapılmaz. Kullanıcı manuel değerlendirme yapar; yeniden temas ancak geçerli gönderim uygunluğu varsa ve önceki mesajlarla birlikte tanımlanan toplam sınırlar aşılmıyorsa mümkündür | Otomatikleştirilemez |
| Aynı web alan adını kullanan işletmeler | Varsayılan olarak alan adı genelinde aynı gün en fazla **1 mesaj**, aynı iletişim dizisinde en fazla **3 mesaj**. Bağımsız şubeler için yanlış eşleştirme ihtimali ayrıca değerlendirilir | Yalnızca sıkılaştırabilir |
| Aynı e-posta adresinin farklı kampanyalarda bulunması | Son temastan itibaren en az **30 gün** yeni kampanya gönderimi engellenir; aktif takip dizileri ayrıca kontrol edilir | Yalnızca artırabilir |
| Herhangi bir yanıt alınması | Otomatik takip dizisi durur; kayıt kullanıcı değerlendirmesine bırakılır | Hayır |
| Olumsuz yanıt veya iletişim istememe talebi | Açık ret veya çıkış talebi tespit edilirse gönderim engellenir. Belirsiz yanıtlar manuel incelemeye yönlendirilir | Hayır |
| İletişimden çıkma veya doğrulanmış spam şikâyeti | İlgili adrese yeni ticari gönderim engellenir. Geçerli kaldırma talebi veya hukuken uygun düzeltme süreci dışında engel kaldırılmaz | Hayır |
| Kalıcı teslimat hatası (hard bounce) | İlgili adres suppression listesine alınır; geçici hatalar ayrı değerlendirilir | Hayır |
| Posta kutusu bounce ve şikâyet oranı | Yeterli ve güvenilir ölçüm verisi bulunduğunda bounce oranı %3'ü veya şikâyet oranı %0,1'i aşarsa yeni gönderimler durdurulur ve kullanıcı uyarılır. Sağlayıcının daha sıkı kuralları önceliklidir | Eşikler yalnızca sıkılaştırılabilir |
| Gönderim hacmi | Bölüm 4.6'daki günlük başlangıç limiti ve üst sınır uygulanır | Üst sınır aşılamaz |

**Test gereksinimleri:**

Bu kurallar `tests/` altında birim testlerle doğrulanacaktır. En azından aşağıdaki senaryolar kapsanacaktır:

- Bir iletişim dizisine dördüncü mesaj eklenememesi.
- Aynı alana ait iki mesajın aynı gün planlanmasının engellenmesi.
- Yanıt veya çıkış talebi sonrasında bekleyen takiplerin iptal edilmesi.
- 180 günlük bekleme süresinin otomatik olarak yeni gönderim başlatmaması.
- Farklı kampanyalar üzerinden temas sınırlarının aşılamaması.
- Bounce veya şikâyet eşiği aşıldığında kuyruğun durdurulması.

İletişimden çıkma ve gönderim engelleme kararları, uygulama yeniden başlatıldığında da korunacaktır.

### 5.7 Harita ve Arayüz

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-UI-01 | Ana ekran, solda işletme listesi ve sağda Google Haritası bulunan bölünmüş görünüm sunar. Panellerin genişlik oranı kullanıcı tarafından değiştirilebilir. Liste ve harita seçimleri birbiriyle senkronize çalışır. | Z |
| FR-UI-02 | Harita işaretçileri işletmenin durumuna göre görsel olarak ayrıştırılır: yüksek yenilik olasılığı (yeşil), yakında açılacak (mor), muhtemel yeni (sarı), düşük yenilik göstergesi (gri). Gönderim ve yanıt durumları ayrı simge veya işaretçi özellikleriyle gösterilir. Yoğun bölgelerde işaretçi kümeleme kullanılır. | Z |
| FR-UI-03 | Kullanıcı harita üzerinde dikdörtgen veya daire çizerek tarama bölgesi belirleyebilir. | Z |
| FR-UI-04 | Dashboard üzerinde toplam lead, son 30 günde yeni tespit edilen işletmeler, yakında açılacak işletmeler, e-posta adresi bulunan lead'ler, gönderim ve yanıt sayıları, tahmini aylık API harcaması ve güncel gönderim kuyruğu gösterilir. | Z |
| FR-UI-05 | Koyu/açık tema, Türkçe/İngilizce arayüz ve klavye kısayolları desteklenir. Örnek kısayollar: `J/K` liste gezinme, `E` zenginleştirme, `C` kampanyaya ekleme. | Ö |
| FR-UI-06 | İlk kullanımda yönlendirici açıklamalar ve boş durum ekranları gösterilir (ör. "Henüz tarama yapılmadı → İlk taramanı başlat"). | Z |
| FR-UI-07 | Teknik olmayan kullanıcılar için ilgili ekranlarda **"Bu nedir?"** açıklamaları sunulur. | Ö |

### 5.8 Uyum ve Veri Yönetimi

| ID | Gereksinim | Öncelik |
|---|---|---|
| FR-CMPL-01 | Bölüm 8'de tanımlanan ülke bazlı gönderim politikaları uygulama içinde yönetilir. Her ülke için `izinli`, `yalnızca genel işletme adresi` veya `yasak` gibi operasyonel modlar tanımlanabilir. Bu modlar hukuki uygunluğun tek başına kanıtı değildir. Kullanıcı daha kısıtlayıcı ayarlar yapabilir; zorunlu yasal engelleri kaldıramaz. | Z |
| FR-CMPL-02 | Suppression listesi; manuel kayıt ekleme, CSV içe aktarma ve otomatik engelleme işlemlerini destekler. İletişimden çıkma, doğrulanmış şikâyet ve kalıcı teslimat hataları uygun gerekçelerle kaydedilir. Alan adı bazlı engelleme desteklenir. | Z |
| FR-CMPL-03 | Geçerli veri silme talebi alındığında ilgili kişisel veriler, uygulanabilir yasal saklama yükümlülükleri dikkate alınarak silinir veya anonimleştirilir. Yeniden ileti gönderilmesini önlemek için gerekli asgari suppression bilgisi, uygun hukuki dayanak ve güvenlik önlemleriyle saklanabilir. Hash'lenmiş e-posta adresinin her durumda anonim veri olmadığı dikkate alınır. | Z |
| FR-CMPL-04 | Temas edilmemiş lead'ler için varsayılan kişisel veri saklama süresi **12 ay** olarak belirlenir. Süre, veri kaynağının koşulları ve ilgili mevzuatın gerektirdiği daha kısa sınırlar dikkate alınarak uygulanır. Kullanıcı süreyi yalnızca geçerli koşullara uygun şekilde yapılandırabilir. | Ö |
| FR-CMPL-05 | Yerel veritabanının şifreli yedeği oluşturulabilir ve kullanıcı tarafından geri yüklenebilir. Yedeklerin güvenli saklanması ve geri yükleme sırasında veri bütünlüğünün korunması sağlanır. | Ö |
| FR-CMPL-06 | Audit log üzerinde kullanıcı işlemleri, gönderim kararları, tarih/saat, ilgili kampanya ve kullanılan filtre bilgileri kayıt altına alınır. Kayıtlar gerekli erişim kontrolleri ve veri saklama kuralları çerçevesinde dışa aktarılabilir. | Ö |
| FR-CMPL-07 | **B2B hedefleme:** Uygulama yalnızca uygun işletme iletişimlerine yönelik kullanılır. `gmail.com`, `hotmail.com`, `outlook.com`, `yahoo.com`, `icloud.com` gibi yaygın kişisel posta sağlayıcıları varsayılan olarak otomatik kampanyalardan hariç tutulur. Hariç tutma nedeni lead üzerinde gösterilir. Bu kontrol tek başına alıcının tüketici veya işletme olduğunu kesinleştirmez; ülke bazlı hukuki uygunluk kontrolleri ayrıca uygulanır. | Z |
| FR-CMPL-08 | Gerekli gönderici firma bilgileri (ticari unvan, fiziksel adres ve uygulanabilir sicil/vergi bilgileri) bulunmayan şablonlar gönderime alınmaz. Zorunlu alanlar şablon içeriğinden silinse bile sistem tarafından gönderim aşamasında eklenir; firma profilindeki eksiklikler giderilmeden gönderim başlatılmaz. | Z |

---

## 6. Fonksiyonel Olmayan Gereksinimler

| ID | Kategori | Gereksinim |
|---|---|---|
| NFR-01 | Gizlilik | İşletme kayıtları, kampanyalar, ayarlar ve işlem geçmişi yerel SQLite veritabanında saklanır. Uygulama kullanım telemetrisi toplamaz. Dış sistemlerle iletişim, Bölüm 4'te tanımlanan API'ler, işletme web siteleri, gerekli DNS hizmetleri ve etkinleştirilmiş diğer entegrasyonlarla sınırlandırılır. Kullanıcı verileri izinsiz olarak üçüncü taraflara aktarılmaz. |
| NFR-02 | Güvenlik | API anahtarları ve OAuth token'ları işletim sisteminin güvenli kimlik bilgisi deposunda veya uygun şekilde şifrelenmiş depolamada tutulur. Yerel sunucu kullanılıyorsa yalnızca `127.0.0.1` üzerinden erişilebilir olacak şekilde yapılandırılır. İlgili uç noktalarda CSRF ve yetkisiz erişim korumaları uygulanır. Bağımlılıklar güvenlik taramasından geçirilir; tespit edilen kritik güvenlik açıkları yayımlama öncesinde giderilir. |
| NFR-03 | Performans | 100.000 lead içeren veritabanında yaygın listeleme ve filtreleme işlemlerinin hedef yanıt süresi **300 ms'nin altında** olacaktır. Harita, 5.000 işletme işaretçisini kümeleme yöntemiyle kullanıcı etkileşimini belirgin şekilde aksatmadan gösterebilmelidir. Performans hedefleri tanımlanmış test ortamında doğrulanacaktır. |
| NFR-04 | Dayanıklılık | Geçici ağ ve servis hatalarında uygun dış çağrılar, üstel geri çekilme yöntemiyle en fazla 3 yeniden deneme yapılarak yürütülür. Kalıcı yetkilendirme hataları ve yeniden denemeyle düzelmeyecek hatalar tekrar edilmez. `429` ve kota hatalarında sağlayıcının bildirdiği bekleme süresi dikkate alınır; gerektiğinde ilgili işlemler otomatik duraklatılır. |
| NFR-05 | Maliyet Güvenliği | Uygulama, ücretli API çağrılarını kullanılan hizmet ve ilgili SKU kategorisine göre tahmini maliyetleriyle kaydeder. Belirlenen bütçe sınırına ulaşıldığında uygulamanın kontrolündeki yeni ücretli tarama ve zenginleştirme işlemleri durdurulur. Tahmini maliyet ile sağlayıcının kesin faturalandırma tutarı arasında farklılık olabileceği dikkate alınır. |
| NFR-06 | Kullanılabilirlik | Teknik bilgisi sınırlı bir kullanıcı, kurulum rehberi ve uygulama içi yönlendirmeler yardımıyla ilk taramasını **30 dakika içinde** yapılandırıp başlatabilmelidir. Taramanın tamamlanma süresi bölge büyüklüğüne ve API koşullarına bağlıdır. |
| NFR-07 | Taşınabilirlik | Uygulama macOS ve Windows için ayrı kurulum paketleriyle dağıtılır. Desteklenen işletim sistemi sürümlerinde kurulum ve temel işlevler test edilir. Linux resmî olarak desteklenmez ve çalışacağı garanti edilmez. |
| NFR-08 | Bakım | Kod tabanında TypeScript, ESLint ve Prettier kullanılır. Kritik modüller (yenilik skorlama, gönderim uygunluğu, temas sıklığı ve e-posta çıkarma) için Vitest birim testleri hazırlanır. Bu modüllerde en az **%80 kod kapsama oranı** hedeflenir. |
| NFR-09 | Yerelleştirme | Uygulama arayüzü Türkçe ve İngilizce dillerini destekler. E-posta şablonları çok dilli olarak yönetilebilir. Tarih ve saat gösterimleri ilgili kullanıcı veya alıcı saat dilimine göre düzenlenir; gönderim planlamasında alıcının yerel saati esas alınır. |
| NFR-10 | Güncellenebilirlik | Kullanıcı, yeni kurulum paketini mevcut uygulamanın üzerine kurarak sürüm güncellemesi yapabilir. Güncelleme sırasında yerel veriler korunur. Gerekli veritabanı şema geçişleri kontrollü ve otomatik gerçekleştirilir; işlem öncesinde yedek alınır. Başarısız geçişlerde veri kaybını önleyecek kurtarma mekanizmaları uygulanır. |
| NFR-11 | Geliştirici Makinesi | Dağıtılan uygulamanın çalışması için geliştiricinin bilgisayarında sürekli açık bir servis, zamanlayıcı veya sunucu bulunması gerekmez. Uygulama paketlerinin derlenmesi ve uygun test süreçleri GitHub Actions üzerinden yürütülür. Geliştirme bağımlılıkları (`node_modules`) ve derleme çıktıları `.gitignore` ile sürüm kontrolü dışında tutulur. |

---

## 7. Veri Modeli (Özet)

Aşağıdaki yapı, uygulamanın temel veri varlıklarını ve aralarındaki ilişkileri özetlemektedir. Nihai tablo yapıları, veri tipleri, indeksler ve ilişkisel kısıtlar geliştirme aşamasında ayrıntılandırılacaktır.

```text
regions
  (id, name, country_code, geometry, grid_size_m,
   schedule_days, last_scan_at)

category_sets
  (id, name, place_types[], keywords[])

scans
  (id, region_id, category_set_id, started_at, finished_at,
   calls_by_sku_json, est_cost_usd, status, progress_json)

places
  (place_id PK, name, formatted_address, lat, lng,
   country_code, city, primary_type, types[],
   business_status, opening_date, website, phone,
   user_rating_count, google_maps_uri, google_fetched_at,
   first_seen_scan_id, last_seen_scan_id, stale)

place_snapshots
  (scan_id, place_id, business_status, user_rating_count)
  -- Tarama karşılaştırması için; veri saklama koşullarına tabi

leads
  (id, place_id FK nullable,
   source enum[google,registry,import],
   novelty_score, novelty_label,
   status enum[new,enriched,queued,sent,replied,
               not_interested,customer,do_not_contact],
   language, notes, tags[], created_at, updated_at)

lead_emails
  (id, lead_id, email, source_url, found_at,
   kind enum[personal,generic],
   verify_status enum[verified,unverified,invalid],
   verified_at, is_primary)

lead_contacts
  (id, lead_id,
   type enum[instagram,facebook,contact_form,linkedin],
   url)

registry_matches
  (id, lead_id,
   registry enum[companies_house,sirene,...],
   company_number, incorporated_on, match_score)

templates
  (id, name, language, category_filter,
   subject, body_html, body_text,
   step_index, is_followup)

campaigns
  (id, name, template_ids[], mailbox_id,
   filter_json, send_window_json, daily_cap, status)

campaign_leads
  (campaign_id, lead_id, step_index,
   scheduled_at, sent_at, message_id, status, error)

messages
  (id, lead_id, campaign_id, mailbox_id,
   direction enum[out,in],
   message_id, thread_id, in_reply_to,
   subject, snippet, sent_at, received_at, status)

suppressions
  (id, email_hash, domain,
   reason enum[unsubscribe,bounce,complaint,
               manual,negative_reply],
   added_at)

mailboxes
  (id, provider enum[gmail,microsoft365,smtp],
   address, daily_cap, warmup_started_at,
   credentials_ref)

country_policies
  (country_code,
   mode enum[allowed,generic_only,blocked],
   note, updated_at)

api_usage
  (id, provider, sku, calls, est_cost_usd, day)

settings
  (key, value)

audit_log
  (id, at, action, entity, entity_id, detail_json)
```

**Veri bütünlüğü ve yönetimi:**

- Lead kayıtları farklı kaynaklardan gelebilir. Google Places kaydı bulunmayan sicil veya içe aktarma kaynaklı lead'ler için `place_id` boş bırakılabilir.
- E-posta adresinin türü (`personal` / `generic`) ile doğrulama durumu birbirinden bağımsız tutulur.
- Gönderim geçmişi ve mesaj kimlikleri, kampanya adımlarının izlenmesi ve gelen yanıtların doğru eşleştirilmesi amacıyla saklanır.
- Suppression kayıtları, farklı kampanyalar üzerinden aynı alıcıya yeniden gönderim yapılmasını önlemek için merkezi olarak kontrol edilir.
- Google Places verileri, ilgili API'nin güncel saklama ve kullanım koşullarına uygun şekilde yönetilir. Uzun süreli tarama karşılaştırmalarında saklanmasına izin verilen veriler esas alınır.
- API anahtarları ve OAuth token'ları doğrudan SQLite tablolarında düz metin olarak tutulmaz. `credentials_ref`, güvenli depolamadaki ilgili kayda işaret eder.
- SQLite üzerinde liste olarak gösterilen alanların (`types[]`, `tags[]`, `template_ids[]` vb.) fiziksel saklama biçimi geliştirme aşamasında belirlenir.
- Sık kullanılan filtreler ve ilişkiler için uygun indeksler ve benzersizlik kısıtları tanımlanır.
---

## 8. Yasal ve Uyum Gereksinimleri

> Bu bölüm hukuki tavsiye niteliği taşımaz. Uygulama gerçek ticari gönderimlerde kullanılmadan önce hedef ülkelerin mevzuatı, veri kaynaklarının kullanım koşulları ve tarafların yükümlülükleri konusunda uzman hukuki değerlendirme alınmalıdır.

### 8.1 Google Maps Platform Hizmet Şartları

- Google Places API (New) üzerinden elde edilen veriler, Google Maps Platform'un güncel hizmet şartlarına ve Places API politikalarına uygun şekilde kullanılacaktır.
- Place ID değerleri, ilgili politikaların izin verdiği şekilde saklanabilir. İşletme adı, adres, koordinatlar, değerlendirme sayısı ve diğer Google kaynaklı alanlar için saklama, önbellekleme ve yeniden kullanım koşulları ayrı ayrı değerlendirilecektir.
- Places API sonuçları Google haritası üzerinde gösterildiğinde gerekli Google ve üçüncü taraf atıfları korunacaktır. Harita dışında gösterim yapılması durumunda da ilgili logo ve atıf kuralları uygulanacaktır.
- Google Places verilerinin toplu şekilde indirilmesi, kalıcı işletme veritabanı oluşturulması veya bağımsız pazarlama listelerine dönüştürülmesi konusunda geçerli kısıtlamalar dikkate alınacaktır. Verilerin belirli aralıklarla yenilenmesi, tek başına bu kullanımları uygun hâle getirmez.
- Dışa aktarma işlemleri, saklanmasına ve yeniden kullanılmasına izin verilen alanlarla sınırlandırılacaktır. Kullanıcının bağımsız ve hukuka uygun kaynaklardan elde ettiği bilgiler, Google kaynaklı verilerden ayrı yönetilecektir.
- **Uygulamanın Google Places üzerinden otomatik lead toplama ve saklama modeli, geliştirme ve canlı kullanım öncesinde güncel Google şartlarına göre doğrulanacaktır.** Gerekirse veri kaynağı veya uygulama mimarisi değiştirilecektir.

### 8.2 Ülke Bazlı B2B E-posta Politikası (Başlangıç Tablosu)

Ülke bazlı politikalar, otomatik ticari e-posta gönderiminde ön değerlendirme amacıyla kullanılır. Her ülke için geçerli elektronik pazarlama, kişisel veri koruma ve alıcı türü kuralları ayrıca doğrulanmalıdır.

| Ülke / Bölge | Başlangıç değerlendirmesi | Varsayılan uygulama modu |
|---|---|---|
| Birleşik Krallık | PECR kapsamında kurumsal aboneler ile şahıs işletmeleri arasında ayrım yapılır. Kurumsal alıcılara yönelik belirli B2B iletilerde önceden onay gerekmeyebilir; kişisel veri işleme ve iletişimden çıkma yükümlülükleri devam eder. | `blocked` — hukuki doğrulama sonrası etkinleştirilebilir |
| Türkiye | Tacir ve esnafa yönelik ticari elektronik iletilerde belirli ön onay istisnaları bulunabilir. İYS, gönderici kimliği, ret hakkı ve diğer yükümlülükler gönderim türüne göre değerlendirilir. Türkiye, ihracat odağı nedeniyle başlangıçta hedef dışıdır. | `blocked` — varsayılan kapalı |
| Fransa | CNIL rehberine göre mesleki faaliyetle ilgili belirli B2B iletişimlerde meşru menfaat ve itiraz hakkı çerçevesi uygulanabilir. Bilgilendirme ve iletişimden çıkma koşulları değerlendirilir. | `blocked` — hukuki doğrulama sonrası etkinleştirilebilir |
| Hollanda, Belçika, İrlanda, İsveç, Danimarka, Finlandiya, Portekiz, Polonya, Çekya | Elektronik pazarlama kuralları ülkeye göre farklılık gösterebilir. GDPR kapsamındaki meşru menfaat, tek başına izinsiz e-posta gönderme hakkı oluşturmaz. | `blocked` — ülke bazında doğrulama gerekli |
| İspanya | Elektronik ticari iletişimlerde önceden onay ve mevcut müşteri ilişkisine ilişkin istisnalar ayrıca değerlendirilmelidir. Genel işletme adresi kullanılması tek başına gönderim izni oluşturmaz. | `blocked` |
| İtalya | Elektronik pazarlama ve kişisel veri koruma koşulları bakımından önceden onay gereksinimleri ve istisnalar doğrulanmalıdır. | `blocked` |
| Almanya, Avusturya | İstenmeyen ticari e-posta gönderiminde sıkı onay ve haksız rekabet kuralları uygulanır. Doğrulanmış hukuki dayanak olmadan otomatik gönderim yapılmaz. | `blocked` |
| Diğer AB/AEA ülkeleri | Ülkeye özgü elektronik iletişim mevzuatı doğrulanmadan otomatik gönderim etkinleştirilmez. | `blocked` |

**Uygulama politikası:**

- Başlangıçta hiçbir ülke için otomatik ticari gönderim izni varsayılmaz.
- Ülke politikaları hukuki değerlendirme sonrasında yapılandırılır ve değişiklik gerekçeleri kayıt altına alınır.
- `allowed`, `generic_only` ve `blocked` modları teknik kontrol amacı taşır; tek başına hukuki uygunluk garantisi değildir.
- `generic_only` modu, yalnızca genel işletme adreslerini hedefleyen ek bir kısıtlamadır; izin veya onay gerekliliklerini ortadan kaldırmaz.
- Kullanıcı, zorunlu hukuki engelleri yalnızca bir onay kutusu işaretleyerek kaldıramaz.
- Gönderim uygunluğu, ülkenin yanı sıra alıcı türü, e-posta adresinin niteliği, iletişimin amacı, gerekli izinler ve önceki itirazlar dikkate alınarak değerlendirilir.

### 8.3 Her Mesajda Zorunlu Unsurlar

Ticari e-postalar, hedef ülkede uygulanabilir kurallar doğrultusunda aşağıdaki unsurları içerecektir:

- Gönderenin doğru ticari kimliği ve firma unvanı.
- Gerekli fiziksel adres ve iletişim bilgileri.
- Geçerli ve erişilebilir iletişimden çıkma yöntemi.
- Mesaj içeriğiyle uyumlu, yanıltıcı olmayan konu satırı.
- Ticari veya reklam niteliğinin gizlenmemesi.
- İlgili ülkenin gerektirdiği sicil, vergi veya diğer kurumsal kimlik bilgileri.

Türkiye'ye yönelik gönderimlerde gerekli MERSİS, ticaret sicili veya diğer tanımlayıcı bilgiler, gönderenin hukuki statüsüne ve uygulanabilir mevzuata göre belirlenecektir.

Zorunlu bilgiler eksikse gönderim başlatılmayacaktır.

### 8.4 Kişisel Veri (GDPR / KVKK)

- `info@` gibi genel işletme adresleri her durumda kişisel veri olmayabilir. `ad.soyad@firma.com` gibi belirli bir kişiyi tanımlayan adresler kişisel veri olarak değerlendirilir. Adresin niteliği, ilgili kayıtla birlikte ele alınır.
- Kişisel verilerin toplanması, saklanması, zenginleştirilmesi ve ticari iletişim amacıyla kullanılması için geçerli hukuki dayanak belirlenir.
- Meşru menfaatin kullanılacağı durumlarda gerekli değerlendirme yapılır ve uygun olduğunda **Legitimate Interest Assessment (LIA)** kaydı `docs/` klasöründe tutulur.
- İlgili kişilerin bilgilendirme, itiraz, erişim ve silme talepleri uygulanabilir mevzuata göre değerlendirilir.
- İletişimden çıkma ve doğrudan pazarlamaya itiraz talepleri, yeni gönderimleri engelleyecek şekilde gecikmeden işlenir.
- Veri silme talepleri için uygulama içinde **72 saatlik operasyonel işlem hedefi** belirlenebilir. Bu hedef, GDPR veya KVKK kapsamında geçerli yasal yanıt sürelerinin yerine geçmez.
- Veri silme ve suppression kayıtlarının yönetimi FR-CMPL-03, saklama süreleri FR-CMPL-04 kapsamında yürütülür.
- Kişisel veri içeren kayıtlar ve yedekler için erişim, saklama ve güvenlik önlemleri uygulanır.

### 8.5 Sorumluluk Dağılımı

> Bu bölüm tarafların planlanan operasyonel görevlerini tanımlar; hukuki sorumlulukların kesin olarak belirlenmesi yerine geçmez.

- **Müşteri şirket**, kendi ticari faaliyetleri kapsamında hedef kitleyi, gönderim amaçlarını, kullanılacak hesapları ve kampanya kararlarını belirler. Ticari iletilerin göndereni olarak ilgili mevzuata uyumundan sorumludur.
- **Yazılım geliştiricisi**, uygulamanın kararlaştırılan teknik gereksinimlere uygun geliştirilmesi, güvenlik önlemlerinin uygulanması ve belirlenen yazılım teslim yükümlülüklerinden sorumludur.
- Yazılımın yerel çalışması ve geliştiricinin müşteri verilerine rutin erişiminin bulunmaması, tarafların veri koruma mevzuatı kapsamındaki rollerinin değerlendirilmesinde dikkate alınır. Veri sorumlusu veya veri işleyen sıfatları, fiilî veri işleme faaliyetlerine göre belirlenir.
- Google Maps Platform hesabı ve API anahtarları müşteri şirket tarafından yönetilir. Google'ın hizmet şartlarına uygun kullanım, hem uygulama tasarımında hem de müşterinin operasyonel süreçlerinde dikkate alınır.
- Google API şartlarında veya hedef ülkelerin mevzuatında değişiklik olması durumunda gerekli güncellemelerin kapsamı, süresi ve sorumluluğu taraflar arasında kararlaştırılır. Sınırsız veya otomatik güncelleme garantisi verilmez.
- Hesap sahipliği, gönderici kimliği, API maliyetleri, kod sahipliği, bakım ve güncelleme kapsamı, teslim koşulları ve tarafların sorumlulukları `docs/03-ANLASMA-NOTU.md` dosyasında özetlenir. Bu belge, gerekli hâllerde yazılı sözleşme veya hukuki danışmanlık ihtiyacını ortadan kaldırmaz.
- Uygulama, izinsiz gönderimleri, suppression kayıtlarının aşılmasını, temas sıklığı sınırlarının ihlalini ve uygunluğu doğrulanmamış ülkelere otomatik gönderimi teknik olarak engelleyecek veya sınırlandıracak şekilde tasarlanır.
- Hiçbir teknik kontrol, tüm hukuki risklerin veya e-posta teslimat sorunlarının tamamen ortadan kaldırıldığını garanti etmez.

---

## 9. Arayüz Tasarım İlkeleri

- **Genel yerleşim:** Ana keşif ekranı iki panelli yapıdadır. Sol panelde işletme listesi ve filtreler, sağ panelde harita bulunur. Üst bölümde arama, tahmini API bütçesi ve gönderim kuyruğu gibi temel göstergeleri içeren sade bir komut çubuğu yer alır. Panel genişlikleri kullanıcı tarafından ayarlanabilir.
- **Renk dili:** Yeşil = yüksek yenilik olasılığı, mor = yakında açılacak, sarı = muhtemel yeni, gri = düşük yenilik göstergesi, mavi = iletişim kurulmuş. Kırmızı yalnızca hata, engelleme veya kritik uyarılar için kullanılır. İşletmenin yenilik durumu ile iletişim durumu ayrı görsel işaretlerle gösterilir.
- **Tipografi:** Temel yazı tipi Inter olarak belirlenir. Sayısal verilerde hizalamayı kolaylaştırmak amacıyla `tabular-nums` kullanılır. Metin boyutları ve kontrast, okunabilirliği destekleyecek şekilde düzenlenir.
- **Hareket ve etkileşim:** Harita üzerinde bir işaretçi seçildiğinde ilgili liste öğesi görünür alana kaydırılır ve vurgulanır. Animasyonlar kısa ve işlevsel tutulur; gereksiz hareketli efektlerden kaçınılır.
- **Harita stili:** Google Maps için sade açık ve koyu tema kullanılır. Harita görünümü, uygun Map ID yapılandırmalarıyla özelleştirilir. Gereksiz POI etiketleri azaltılarak uygulamanın işletme işaretçilerinin öne çıkması sağlanır.
- **Güvenli kullanıcı işlemleri:** E-posta gönderimi, toplu silme ve benzeri geri alınması zor işlemlerde kullanıcıya açık bir işlem özeti, etkilenecek kayıt sayısı ve belirgin bir onay mekanizması sunulur. Kampanya gönderimleri kullanıcı onayı olmadan başlatılmaz.
- **Uyarlanabilir yerleşim:** Arayüz farklı masaüstü ekran boyutlarına uyum sağlar. Dar pencerelerde liste ve harita panelleri gerektiğinde yeniden boyutlandırılabilir veya ayrı görüntülenebilir.
- **Kullanılabilirlik:** Teknik bilgisi sınırlı kullanıcılar için anlaşılır alan adları, açıklayıcı hata mesajları, boş durum yönlendirmeleri ve tutarlı gezinme yapısı kullanılır.

**Temel ekranlar:**

1. **Dashboard:** Genel istatistikler, API bütçesi ve gönderim özeti.
2. **Keşif:** Harita, işletme listesi, arama ve filtreleme.
3. **Lead Detayı:** İşletme bilgileri, iletişim bilgileri ve işlem geçmişi.
4. **Şablonlar:** E-posta şablonlarının oluşturulması, düzenlenmesi ve önizlenmesi.
5. **Kampanyalar:** Kampanya oluşturma, yönetme ve takip etme.
6. **Kuyruk / Günlük:** Planlanan gönderimler, tamamlanan işlemler ve hata kayıtları.
7. **Suppression:** İletişim kurulmayacak adreslerin ve engelleme nedenlerinin yönetimi.
8. **Ayarlar / Kurulum Sihirbazı:** API bağlantıları, gönderici hesapları, firma bilgileri ve uygulama ayarları.

---

## 10. Teknoloji Kararı

| Katman | Seçim | Gerekçe |
|---|---|---|
| Programlama dili | TypeScript | Frontend, backend ve arka plan işlemlerinde ortak dil kullanılarak geliştirme ve bakım kolaylaştırılır. |
| Uygulama çatısı | Next.js (App Router) + React | Arayüz ve yerel API işlevlerinin aynı teknoloji ekosisteminde geliştirilmesini sağlar. Kullanılacak sürümler geliştirme başlangıcında uyumluluk ve destek durumuna göre kesinleştirilir. |
| Veritabanı | SQLite + Drizzle ORM | Ayrı veritabanı sunucusu gerektirmez. Yerel veri saklama, ilişkisel sorgular ve yedekleme işlemleri için uygundur. |
| Masaüstü uygulaması | Electron | Web tabanlı arayüzün Windows ve macOS üzerinde masaüstü uygulaması olarak çalışmasını sağlar. Yerel dosya sistemi ve işletim sistemi entegrasyonlarını destekler. |
| Arka plan işlemleri | Ayrı Node.js worker süreci, SQLite tabanlı iş kuyruğu ve `croner` | Tarama, zenginleştirme ve gönderim işlemlerinin arayüzü engellemeden yürütülmesini sağlar. Redis gibi ek bir sunucu bağımlılığı gerektirmez. |
| Harita | Google Maps JavaScript API, `@vis.gl/react-google-maps`, `@googlemaps/markerclusterer` | Harita gösterimi, işletme işaretçileri ve yoğun bölgelerde kümeleme işlevlerini destekler. Google Maps Platform kullanım koşullarına uygun yapılandırılır. |
| Google Places entegrasyonu | Places API (New), REST istekleri ve Field Mask | Kullanılan veri alanları üzerinde kontrol sağlar. Gereksiz alanların istenmesini önleyerek API maliyetlerinin yönetilmesine yardımcı olur. |
| Web sitesi tarama | `undici` + `cheerio`; gerektiğinde `playwright` | Öncelikle hafif HTTP ve HTML ayrıştırma yöntemleri kullanılır. JavaScript ile oluşturulan sayfalarda ihtiyaç duyulursa tarayıcı otomasyonuna başvurulur. |
| E-posta entegrasyonu | `googleapis` (Gmail API), `nodemailer` (SMTP), `mailparser` | E-posta gönderimi, gelen mesajların işlenmesi ve yanıt takibi için kullanılır. Microsoft 365 entegrasyonu gerektiğinde Microsoft Graph üzerinden sağlanır. |
| Arayüz bileşenleri | Tailwind CSS + shadcn/ui + TanStack Table / Virtual | Tutarlı arayüz bileşenleri, gelişmiş tablo özellikleri ve büyük lead listelerinde sanal kaydırma sağlar. |
| Test | Vitest + Playwright | Birim testleri, kritik iş kuralları ve uçtan uca kullanıcı senaryolarının doğrulanmasını sağlar. |
| Paketleme ve dağıtım | Electron Builder + GitHub Actions | Windows ve macOS kurulum paketleri oluşturulur. Next.js'in gerekli çalışma çıktıları uygulama paketine dahil edilir. Derleme ve temel test süreçleri GitHub Actions üzerinden yürütülür. |

### Mimari Uygulama Notları

- **Yerel çalışma:** Uygulamanın ana veritabanı ve iş mantığı kullanıcının bilgisayarında çalışır. Son kullanıcının ayrıca Node.js veya veritabanı sunucusu kurması gerekmez.
- **Next.js ve Electron entegrasyonu:** Next.js arayüzü ve gerekli yerel sunucu bileşenleri Electron içinde paketlenir. Üretim ortamında geliştirme sunucusu kullanılmaz. Paketleme yöntemi, seçilen Next.js ve Electron sürümleriyle doğrulanır.
- **Arka plan işlemleri:** Worker süreci uygulama tarafından yönetilir. Tarama ve gönderim kuyruğunun durumu SQLite üzerinde saklanır; uygulama yeniden açıldığında tamamlanmamış işler uygunluk kontrollerinden geçirilerek devam ettirilebilir.
- **Zamanlanmış görevler:** Yerel worker ve `croner`, uygulama çalışırken görevleri yürütür. Uygulama tamamen kapalıyken arka plan işlemlerinin çalışacağı varsayılmaz. Kaçırılan zamanlanmış görevler uygulama yeniden açıldığında değerlendirilir.
- **Güvenlik:** Electron arayüzü ile yerel sistem işlevleri arasında kontrollü iletişim kullanılır. API anahtarları ve kimlik bilgileri güvenli depolamada tutulur.
- **Harici hizmetler:** Google Places, e-posta sağlayıcıları ve gerektiğinde abonelikten çıkma işlemlerini karşılayan sınırlı dış hizmetler kullanılabilir. Bunlar ana uygulamanın yerel çalışma yaklaşımını değiştirmez.

### Değerlendirilen Alternatifler

**Tauri:** Daha hafif masaüstü uygulamaları geliştirmek için değerlendirilmiştir. Ancak mevcut projede Node.js tabanlı arka plan işlemleri, web tarama araçları ve yerel entegrasyonların Electron ile daha doğrudan kullanılabilmesi nedeniyle tercih edilmemiştir.

**Python (FastAPI) + React:** Web tarama ve veri işleme açısından güçlü bir alternatiftir. Ancak iki farklı programlama dili ve geliştirme ekosisteminin bakım yükünü artıracağı değerlendirilerek mevcut proje için tercih edilmemiştir.

---

## 11. Riskler

| Risk | Olasılık | Etki | Önlem |
|---|---|---|---|
| Gönderici alan adının spam olarak değerlendirilmesi veya gönderim itibarının zarar görmesi | Orta | Yüksek | Bölüm 4.6'da belirlenen kademeli gönderim politikası, düşük günlük limitler, SPF/DKIM/DMARC kontrolleri, uygun gönderici alan adı yapılandırması ve bounce/şikâyet oranlarının izlenmesi. Belirlenen eşikler aşıldığında gönderimler durdurulur. |
| Google API maliyetlerinin beklenenden yüksek olması | Orta | Orta | Tarama öncesi tahmini maliyet gösterimi, API çağrılarının kullanılan SKU'ya göre izlenmesi, gereksiz alan taleplerinin önlenmesi ve uygulama içi bütçe sınırları. Sağlayıcının gerçek faturası ayrıca takip edilir. |
| Hedef ülkelerde ticari e-posta mevzuatının ihlal edilmesi | Orta | Yüksek | Bölüm 8'deki ülke politikalarının uygulanması, hukuki uygunluğu doğrulanmamış ülkelerde gönderimin varsayılan olarak engellenmesi, zorunlu gönderici bilgileri, iletişimden çıkma mekanizması ve canlı kullanım öncesinde hukuki değerlendirme. |
| Lead'lerin önemli bir bölümünde e-posta adresi bulunamaması | Yüksek | Orta | İşletmelerin resmî web sitelerinde çok aşamalı tarama, iletişim formu ve sosyal medya bağlantılarının kaydedilmesi, gerektiğinde kullanıcı onaylı harici e-posta bulma servisleri. E-posta bulunma oranı için önceden kesin bir başarı garantisi verilmez. |
| Google Maps Platform kullanım şartlarıyla uyumsuz veri toplama veya saklama | Yüksek | Yüksek | Google Places verilerinin saklanması, yeniden kullanılması ve dışa aktarılmasına ilişkin koşulların geliştirme öncesinde doğrulanması. Kalıcı lead havuzunun izin verilen veri kaynaklarıyla oluşturulması ve gerektiğinde veri toplama mimarisinin değiştirilmesi. |
| Google Places API alanlarının, işletme kategorilerinin veya yanıt yapısının değişmesi | Orta | Orta | API entegrasyonunun ayrı modüllerde tutulması, kategori eşlemelerinin yapılandırılabilir olması, API sürüm değişikliklerinin takip edilmesi ve entegrasyon testlerinin uygulanması. |
| Tek geliştiriciye bağlı bakım ve geliştirme yükü | Yüksek | Orta | Sade ve modüler mimari, TypeScript kullanımı, kritik modüller için otomatik testler, güncel teknik dokümantasyon ve GitHub Actions üzerinden tekrarlanabilir derleme süreçleri. |
| Müşterinin uygulamayı belirlenen kullanım amacı dışında kullanması | Orta | Yüksek | İlk kullanımda açık kullanım koşulları onayı (FR-SET-08), B2B hedefleme kontrolleri, suppression ve temas sıklığı kurallarının zorunlu uygulanması, ülke bazlı gönderim kısıtlamaları ve tarafların sorumluluklarının yazılı olarak belirlenmesi. |
| Yazılım geliştiricisine yönelik hukuki veya sözleşmesel sorumluluk iddiaları | Düşük | Yüksek | Müşteri ve geliştiricinin görevlerinin yazılı olarak belirlenmesi, teslim ve bakım kapsamının netleştirilmesi, güvenlik ve uyum kontrollerinin belgelenmesi, müşteri verilerine erişimin sınırlandırılması ve gerekli konularda hukuki danışmanlık alınması. |
| Google hizmet şartlarının değişmesi veya API erişiminin kısıtlanması | Orta | Yüksek | Müşterinin kendi Google Cloud hesabını kullanması, API bağımlılıklarının modüler tasarlanması, hukuken uygun alternatif veri kaynaklarının değerlendirilmesi ve bakım kapsamında gerekli entegrasyon güncellemelerinin planlanması. |

**Risk yönetimi yaklaşımı:**

- Yüksek etkili riskler geliştirme öncesinde değerlendirilir ve mümkün olduğunda teknik kontrollerle azaltılır.
- API maliyetleri, gönderim hataları ve kota kullanımı uygulama üzerinden takip edilir.
- Veri kaynakları ve hedef ülke politikaları, ilgili hizmet şartları veya mevzuat değiştiğinde yeniden değerlendirilir.
- Risklerin gerçekleşmesi durumunda etkilenen işlemler güvenli şekilde durdurulur ve kullanıcıya anlaşılır bir uyarı gösterilir.
- Risk olasılığı ve etki seviyeleri başlangıç değerlendirmesidir; test ve gerçek kullanım sonuçlarına göre güncellenebilir.

---

## 12. Maliyet Senaryosu (Aylık, Müşterinin İşletme Gideri)

Bu bölüm, Universal Mail uygulamasının kullanımından kaynaklanabilecek aylık işletme giderlerini örnek senaryolar üzerinden değerlendirmektedir. Belirtilen rakamlar kesin fiyat teklifi veya fatura garantisi değildir.

### 12.1 Başlangıç Senaryosu

**Varsayımlar:**

- Hedeflenen şehir sayısı: 30
- Şehir başına taranacak kategori sayısı: 12
- Kategori başına ortalama API çağrısı: 3
- Aylık tarama sıklığı: 2
- Yeni veya değişen işletmeler için ek bilgi sorgulama oranı: varsayımsal %15

**Tahmini Discovery çağrıları:**

30 şehir × 12 kategori × 3 çağrı = **1.080 çağrı/tarama**

Ayda iki tarama gerçekleştirildiğinde yaklaşık **2.160 Discovery çağrısı** oluşur.

Bu hesap yalnızca başlangıç varsayımıdır. Gerçek çağrı sayısı; bölgenin büyüklüğü, ızgara yoğunluğu, kategori dağılımı ve arama sonuçlarının kapsamına göre değişebilir.

### 12.2 Aylık Maliyet Kalemleri

| Kalem | Tahmini kullanım | Maliyet değerlendirmesi |
|---|---|---|
| Google Places Discovery | Yaklaşık 2.160 çağrı/ay | Kullanılan arama yöntemi, Field Mask ve ilgili SKU'nun ücretsiz kullanım sınırına göre hesaplanır. |
| Google Places Enrichment / Details | Yeni veya değişen işletme sayısına bağlı | Place Details veya ilgili diğer API işlemlerinin SKU'suna göre hesaplanır. |
| Google Maps JavaScript API | Kullanıcının harita açma sıklığına bağlı | İlgili harita yükleme SKU'su ve güncel ücretsiz kullanım sınırı esas alınır. |
| Google Workspace | 1 kullanıcı | Seçilen abonelik planına, ödeme dönemine ve geçerli fiyatlara bağlıdır. |
| Gönderici alan adı | 1 alan adı | Yıllık yenileme ücreti aylık ortalamaya dönüştürülerek hesaplanır. |
| Harici e-posta bulma servisi | Opsiyonel | Hunter.io veya benzeri hizmetlerin seçilen planına ve kullanım kotasına bağlıdır. |
| Abonelikten çıkma altyapısı | Gerektiğinde | Harici HTTPS hizmeti kullanılması durumunda barındırma veya servis maliyeti oluşabilir. |
| **Toplam aylık işletme gideri** | | **Gerçek entegrasyon tercihleri ve güncel fiyatlar doğrulandıktan sonra hesaplanacaktır.** |

### 12.3 Büyüme Senaryoları

Aşağıdaki tablo, aynı kategori ve ortalama çağrı varsayımları korunarak farklı kullanım hacimlerini karşılaştırmaktadır.

| Senaryo | Discovery çağrısı/ay | Enrichment çağrısı | Google API maliyeti |
|---|---:|---|---|
| 30 şehir, ayda 2 tarama | ~2.160 | Bulunan benzersiz işletme sayısına bağlı | SKU bazında hesaplanacak |
| 150 şehir, ayda 2 tarama | ~10.800 | Bulunan benzersiz işletme sayısına bağlı | SKU bazında hesaplanacak |
| 150 şehir, ayda 1 tarama | ~5.400 | Bulunan benzersiz işletme sayısına bağlı | SKU bazında hesaplanacak |

Enrichment çağrıları, Discovery çağrılarının sabit bir yüzdesi olarak kabul edilmez. Önce bulunan benzersiz işletme sayısı ve ek bilgi gerektiren kayıtlar belirlenir.

### 12.4 Bütçe Kontrolü

- Kullanıcı, tarama başlatmadan önce tahmini API çağrı sayısını ve maliyeti görüntüler.
- Maliyet hesabında kullanılan API yöntemi, Field Mask ve ilgili SKU dikkate alınır.
- Aylık bütçenin %80'ine ulaşıldığında kullanıcı uyarılır.
- Uygulama tarafından izlenen bütçe sınırına ulaşıldığında yeni ücretli tarama ve zenginleştirme çağrıları durdurulur.
- Google Cloud üzerinde ayrıca bütçe uyarıları ve uygun API kota sınırları yapılandırılması önerilir.
- Uygulamanın hesapladığı maliyet ile sağlayıcının kesin faturası arasında farklılık oluşabilir.

### 12.5 Maliyet Hesabının Doğrulanması

Geliştirme sırasında küçük ölçekli bir pilot tarama gerçekleştirilerek gerçek API çağrı sayıları ve kullanılan SKU'lar belirlenecektir.

Pilot taramanın ardından bu bölümdeki maliyet senaryoları güncellenecek ve müşteriye daha gerçekçi bir aylık gider tahmini sunulacaktır.

Autocomplete özelliği v1 kapsamında planlanmadığından başlangıç maliyet senaryosuna dahil edilmemiştir.

**Not:** Google Maps Platform, Google Workspace ve harici e-posta bulma servislerinin fiyatları zaman içinde değişebilir. Canlı kullanımdan önce sağlayıcıların güncel fiyatlandırmaları kontrol edilmelidir.
---

## 13. Kabul Kriterleri (MVP)

MVP sürümünün kabulü, aşağıdaki senaryoların belirlenen test ortamında başarıyla gerçekleştirilmesine bağlıdır. Harici API'lerin erişilebilirliği, veri kapsamı ve üçüncü taraf hizmetlerin çalışma koşulları test sonuçlarında ayrıca değerlendirilir.

1. **Kurulum ve ilk tarama:** Kullanıcı, ilk kurulum sihirbazı üzerinden gerekli API anahtarlarını ve ayarlarını tanımlayabilir. Londra ve Amsterdam şehirlerini seçerek "kafe, restoran, fırın" kategorileri için tarama başlatabilir. Tarama öncesinde tahmini API çağrı sayısı ve maliyet gösterilir. Küçük ölçekli test bölgesinde tarama işlemi hedef olarak 10 dakika içinde tamamlanır; daha geniş bölgelerde ilerleme ve tahmini durum bilgisi sunulur.

2. **Harita ve liste gösterimi:** Tarama sonucunda bulunan işletmeler harita ve liste üzerinde görüntülenir. API tarafından `FUTURE_OPENING` olarak bildirilen kayıtlar mor işaretçilerle ayrıştırılır. Harita ve liste seçimleri birbiriyle senkronize çalışır.

3. **Yeni işletme tespiti:** İlk tarama referans veri kümesini oluşturur. Aynı bölge ve kategoriler için 14 gün sonra kullanıcı tarafından **manuel olarak başlatılan** ikinci taramada, önceki taramada bulunmayan Place ID'ler "Yeni tespit edildi" etiketiyle gösterilir. Bu etiket, işletmenin kesin olarak yeni açıldığını ifade etmez.

4. **E-posta zenginleştirme:** Seçilen 100 lead için web sitesi üzerinden e-posta bulma süreci çalıştırılır. Bulunan adresler kaynak URL'leri ve doğrulama durumlarıyla birlikte gösterilir. E-posta bulunamayan işletmeler uygun durum etiketiyle işaretlenir. Bulma oranı raporlanır; harici web sitelerinin veri kapsamına bağlı olduğundan sabit bir başarı yüzdesi garanti edilmez.

5. **E-posta şablonları:** Kullanıcı Türkçe ve İngilizce e-posta şablonları oluşturabilir, değişkenleri kullanabilir ve gerçek bir lead üzerinden önizleme yapabilir. Eksik değişkenler için uyarı gösterilir. Kullanıcı kendi adresine test e-postası gönderebilir ve mesajın içeriğini kontrol edebilir.

6. **Kampanya oluşturma ve gönderim:** Kullanıcı 20 lead içeren bir test kampanyası oluşturabilir. Ülke politikası nedeniyle gönderime kapalı olan Almanya kayıtları gerekçeleriyle hariç tutulur. Uygun kayıtlar günlük gönderim sınırı ve alıcının yerel saat penceresine göre kuyruğa alınır. Kullanıcı onayı olmadan gönderim başlamaz. Yetkilendirilmiş test alıcılarına gönderilen mesajlar ilgili posta sağlayıcısının gönderim kayıtlarında doğrulanabilir ve geçerli iletişimden çıkma yöntemini içerir.

7. **Yanıt tespiti:** Test alıcısından gelen yanıt, ilgili lead ve kampanyayla eşleştirilir. Lead'in durumu "Yanıtladı" olarak güncellenir ve bekleyen otomatik takip adımları iptal edilir.

8. **Teslimat hatası ve suppression:** Kalıcı teslimat hatası (hard bounce) doğrulanan bir e-posta adresi suppression listesine eklenir. Bu adres, sonraki kampanyalarda gönderim kuyruğuna alınamaz. Geçici teslimat hataları kalıcı hatalardan ayrı değerlendirilir.

9. **Veri ve kuyruk sürekliliği:** Uygulama kapatılıp yeniden açıldığında lead kayıtları, şablonlar, kampanyalar, ayarlar ve gönderim kuyruğunun durumu korunur. Yarım kalan işlemler güvenli şekilde değerlendirilir; tamamlanmış gönderimler yanlışlıkla tekrar edilmez.

10. **API bütçe kontrolü:** Dashboard üzerinde tahmini aylık API harcaması görüntülenir. Kullanıcıya tanımlanan bütçe sınırına ulaşıldığında uygulamanın kontrolündeki yeni ücretli tarama ve zenginleştirme çağrıları durdurulur. Bütçe uyarıları kullanıcıya gösterilir.

11. **Firma profili ve kullanım onayı:** Gönderen firma bilgileri ve ilk kullanım onayı tamamlanmadan ticari e-posta gönderimi başlatılamaz. Kullanıcının onay işlemi tarih ve ilgili kayıt bilgileriyle audit log'a işlenir.

12. **B2B hedefleme kontrolü:** `gmail.com`, `hotmail.com`, `outlook.com` gibi varsayılan olarak hariç tutulan kişisel posta sağlayıcılarına ait adresler otomatik kampanyalara alınmaz. Hariç tutulma gerekçesi ilgili lead üzerinde görüntülenir.

13. **Yerel veri ve bağlantı kontrolü:** Temiz kurulumda uygulamanın ağ trafiği incelenerek geliştiriciye ait tanımlanmamış sunuculara veri gönderilmediği doğrulanır. Yalnızca belgelenmiş ve gerekli harici servis bağlantıları kullanılır. Lead veritabanı yerel cihazda tutulur.

14. **Bağımsız masaüstü kurulumu:** Müşterinin Windows veya macOS bilgisayarında, ayrıca Node.js kurulumu veya terminal kullanımı gerektirmeden, hazırlanan kurulum paketiyle uygulama yüklenebilir. İlk açılış sihirbazına erişilebilir. Kurulum ve uygulamanın temel işlevleri, geliştiricinin bilgisayarı kapalıyken de çalışır.

---

## Ek A — Başlangıç Şablonu Örneği (TR, Kafe)

**Konu:** {{isletme_adi}} için sarf malzemesi tedarik teklifi

Merhaba,

{{sehir}} bölgesinde faaliyet gösteren {{isletme_adi}} ile iletişime geçmek istedik. {{kisisel_giris}}

Biz {{firma}} olarak kafe ve restoranlara peçete, amerikan servis, ıslak mendil ve benzeri günlük sarf malzemelerinin tedarikini sağlıyoruz. İşletmelerin ihtiyaçlarına uygun ürün seçenekleri ve düzenli tedarik çözümleri sunuyoruz.

İlgilenmeniz durumunda ürün kataloğumuzu ve fiyat tekliflerimizi sizinle paylaşmaktan memnuniyet duyarız.

İyi çalışmalar,

{{gonderen_ad}}  
{{firma}}  
{{firma_adres}}  
{{telefon}}

Bu tür e-postalar almak istemiyorsanız: {{cikis_linki}}

*Not: Göndericiye ait gerekli sicil ve vergi bilgileri, ilgili mevzuata göre otomatik alt bilgiye eklenir.*

## Ek B — Başlangıç Şablonu Örneği (EN, Café)

**Subject:** Supply solutions for {{isletme_adi}}

Hello,

We came across {{isletme_adi}} in {{sehir}} and wanted to introduce our company. {{kisisel_giris}}

At {{firma}}, we supply cafés and restaurants with everyday consumables, including napkins, paper placemats, wet wipes, and related products. We offer product options and supply solutions tailored to the needs of each business.

If you're interested, we'd be happy to share our product catalogue and pricing information.

Best regards,

{{gonderen_ad}}  
{{firma}}  
{{firma_adres}}  
{{telefon}}

If you prefer not to receive further emails from us, you can unsubscribe here: {{cikis_linki}}
