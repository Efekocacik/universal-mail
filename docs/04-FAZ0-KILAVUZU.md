# Faz 0 Kılavuzu — Hesaplar ve Hazırlık

Bu kılavuz, kod yazılmadan önce **arkadaşınızın şirketi adına** açılacak hesapları adım adım anlatır. Menü adları Google tarafında zaman zaman değişir; ekranda tam aynısını görmezseniz anlamı yakın olan seçeneği izleyin.

> **Altın kural:** Şifreleri ve API anahtarlarını WhatsApp'a, sohbete, e-postaya veya GitHub'a **yazmayın**. Anahtarlar yalnızca bir şifre yöneticisine (örn. Apple Parolalar, 1Password, Bitwarden) kaydedilir ve uygulamanın kurulum sihirbazına arkadaşınızın kendi bilgisayarında yapıştırılır.

---

## 0. Özet: sıra, süre, maliyet

Sıra önemlidir. Özellikle **Workspace, Google Cloud'dan önce** açılmalıdır (neden: Adım 5'te).

| # | Adım | Kim yapar | Elle süre | Maliyet |
|---|---|---|---|---|
| 1 | Alan adı satın al | Arkadaş (şirket kartı) | 20 dk | yaklaşık 10–15 USD/yıl (.com) |
| 2 | Google Workspace aç | Arkadaş, siz yanında | 30 dk | yaklaşık 7–8,4 USD/ay (1 kullanıcı) |
| 3 | SPF, DKIM, DMARC kayıtları | Siz yönlendirin, arkadaş girer | 45 dk + 1–2 gün bekleme | 0 |
| 4 | Alan adına vitrin ve gizlilik sayfası | Siz | 1 saat | 0 |
| 5 | Google Cloud projesi (Workspace hesabıyla) | Arkadaş, siz yanında | 20 dk | 0 |
| 6 | Faturalandırma, **günlük kota**, bütçe uyarısı | Arkadaş, siz yanında | 30 dk | 0 (kartı kaydetmek şart) |
| 7 | API'leri aç, anahtarları oluştur | Siz yönlendirin | 30 dk | 0 (ücretsiz kota içinde) |
| 8 | Gmail bağlantısı (OAuth, Internal) | Siz yönlendirin | 30 dk | 0 |
| 9 | Ücretsiz sicil API hesapları (Faz 5 için, ertelenebilir) | Siz | 30 dk | 0 |
| 10 | Sizin geliştirme test projeniz | Siz | 30 dk | 0 |
| 11 | Anahtarları saklama ve teslim kuralları | İkiniz | 10 dk | 0 |

Toplam: yaklaşık **4–5 saat** elle iş ve DNS yayılma beklemesi. Takvimde yaklaşık **bir hafta**.

---

## Başlamadan önce toplanacak bilgiler

Arkadaşınızdan bu bilgileri bir kağıda alın. Gönderen kimliği (footer) ve hesap kayıtları için gerekir.

- [ ] Şirketin tam ticari unvanı
- [ ] Şirketin açık adresi (e-postaların altında görünecek)
- [ ] Vergi numarası ve varsa MERSİS numarası
- [ ] Şirketin mevcut web sitesi adresi
- [ ] E-postaları kim imzalayacak? (gerçek bir kişinin adı ve unvanı, örn. "Ahmet Yılmaz, İhracat Sorumlusu")
- [ ] Hangi ülkelere ihracat yapılmak isteniyor? (ilk pilot için 2–3 ülke yeter)
- [ ] Hangi bilgisayar kullanılacak: macOS mu, Windows mu?
- [ ] Ödeme için şirket kartı (Google hesap faturaları için; **yurt dışı ve internet alışverişine açık** olmalı)

---

## Adım 1 — Alan adı

**Neden ayrı bir alan adı?** Soğuk e-posta gönderen adres zamanla spam şikâyeti alabilir. Şirketin asıl alan adı (`sirket.com`) zarar görmesin diye gönderim için **ayrı ama benzer** bir alan adı kullanılır (örn. `sirket-export.com`). Başkasının markasına benzeyen ya da yanıltıcı bir ad seçmeyin.

- [ ] Bir alan adı kayıt şirketinde şirket adına hesap açın (örn. Cloudflare Registrar, Namecheap, GoDaddy, Squarespace Domains).
- [ ] `.com` tercih edin. Spam ile anılan uzantılardan (`.xyz`, `.top`, `.click` vb.) kaçının.
- [ ] Alan adı sahibi olarak **şirket** yazılsın (arkadaşın kişisel adı değil), iletişim e-postası şirketin e-postası olsun.
- [ ] Kayıt şirketinde "WHOIS gizliliği" varsayılan açık kalsın.
- [ ] Kayıt şirketi hesabında **iki adımlı doğrulamayı** açın.

**Not alın:** alan adı, kayıt şirketi, hesap e-postası.

---

## Adım 2 — Google Workspace

Alan adına bağlı kurumsal Gmail kutusu. Kişisel `@gmail.com` adresinden soğuk e-posta göndermeyin: hesap kapanma ve spam riski yüksektir.

- [ ] Google Workspace sitesinden **Business Starter** planını seçin. Alan adı olarak az önce aldığınız adı girin ("Alan adım var").
- [ ] İlk hesabın adı gerçek kişinin adı olsun (örn. `ahmet@sirket-export.com`). Bu hesap aynı zamanda **yönetici (süper admin)** olur.
- [ ] Alan adı sahipliğini doğrulayın (Workspace size bir TXT kaydı verir, kayıt şirketinin DNS ekranına eklenir).
- [ ] Workspace'in verdiği **MX kayıtlarını** DNS'e ekleyin, eski MX kayıtlarını silin.
- [ ] Yönetici hesabında **iki adımlı doğrulamayı** açın.
- [ ] Faturalama: ilk aylar **aylık ödeme** seçin (taahhütsüz). Yıllık plan daha ucuzdur ama kullanıcı sayısını yıl içinde azaltamazsınız. Güncel fiyatı Google'ın sayfasından doğrulayın.
- [ ] Deneme süresinde göndermeyin: deneme hesaplarında günlük gönderim sınırı çok düşüktür. Gerçek gönderime ücretli plana geçtikten sonra başlayın.

**Not alın:** yönetici e-postası, gönderen kutusunun adresi (aynı hesap olabilir), plan ve fatura tipi.

---

## Adım 3 — E-posta kimlik doğrulaması (SPF, DKIM, DMARC)

Bu üç kayıt, e-postalarınızın "gerçekten bu alan adından geldiğini" kanıtlar. Olmazsa e-postalar spam'e düşer ya da reddedilir. Kayıtlar kayıt şirketinin **DNS** ekranında eklenir.

- [ ] **SPF:** Alan adı için tek bir TXT kaydı. Workspace kullanıyorsanız içeriği şu olur:
  ```
  v=spf1 include:_spf.google.com ~all
  ```
  Alan adında **yalnızca bir** SPF kaydı olabilir.
- [ ] **DKIM:** Google Yönetici konsolunda *Uygulamalar → Google Workspace → Gmail → E-posta kimlik doğrulaması* bölümünden yeni anahtar üretin. **2048 bit** seçin. Verilen TXT kaydını (`google._domainkey`) DNS'e ekleyip konsolda "Kimlik doğrulamayı başlat"a basın.
- [ ] **DMARC:** `_dmarc` adıyla TXT kaydı. Başlangıç:
  ```
  v=DMARC1; p=none; rua=mailto:dmarc@sirket-export.com
  ```
  `p=none` ile başlayıp 3–4 hafta sorunsuz giderse `p=quarantine` olarak sıkılaştırın.
- [ ] DNS değişikliklerinin yayılması birkaç saatten 1–2 güne kadar sürebilir. Bekleyin.
- [ ] **Kontrol:** Workspace kutusundan **kendi başka bir kişisel adresinize** e-posta atın. Gelen e-postada *Üç nokta → Orijinali göster* deyin; `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS` yazmalı.
- [ ] Alan adını **Google Postmaster Tools**'a ekleyip (DNS TXT ile doğrulama) şikâyet ve itibar takibini açın. Hedef: spam şikâyet oranı sürekli **%0,1'in altında**; %0,3 ve üstü Gmail tarafından reddedilme sebebidir.

**Not alın:** SPF/DKIM/DMARC kaydedildi mi, test sonucu, tarih.

---

## Adım 4 — Alan adına vitrin ve gizlilik sayfası

Alıcılar adresi görüp "bu kim?" diye bakacaktır. Boş bir alan adı güven vermez ve yasal olarak göndereni tanımlama yükümlülüğüyle de uyuşmaz.

- [ ] `sirket-export.com` adresine girilince tek sayfalık bir site açılsın (şirketin asıl sitesine yönlendirme de olur ama tek sayfa daha iyi).
- [ ] Sayfada: şirket unvanı, adres, iletişim e-postası, kısa tanıtım, ürün görselleri.
- [ ] **Gizlilik bildirimi** bölümü: "Kimiz, iş e-posta adreslerini kamuya açık web sitelerinden hangi amaçla (ürün tanıtımı) kullanıyoruz, nasıl çıkabilirsiniz (çıkış bağlantısı veya `optout@...`), verileriniz silinsin isterseniz kime yazmalısınız."
- [ ] Çıkış için **ek kanal** olarak `optout@sirket-export.com` adresi (Workspace'te takma ad/alias olarak tanımlayın, ücretsizdir). Gerçek **tek tıklamalı çıkış** için bu yeterli değildir: yalnızca `mailto:` bağlantısı tek tıkla çıkış sayılmaz. Bunun için alan adınızda çalışan bir **HTTPS çıkış bağlantısı** gerekir (küçük, ücretsiz bir bulut işlevi ya da statik sayfa + form servisi). Teknik tasarımı Faz 3'te yapacağız (SRS FR-CMP-08); Faz 0'da yalnızca vitrin sayfasını barındıracağınız yeri seçin (ör. Cloudflare Pages), çünkü ileride aynı yerde çıkış uç noktası da çalışacak.

Barındırma için ücretsiz seçenekler yeterlidir (GitHub Pages, Cloudflare Pages vb.). Bu sayfayı Faz 3'te birlikte yazarız.

---

## Adım 5 — Google Cloud projesi

**Neden Workspace önce?** Gmail'e bağlanan uygulamamız Google'ın "hassas izin" (gönderme/okuma) kategorisini kullanır. Normalde bu tür uygulamalar Google'ın uzun bir doğrulama sürecinden geçmek zorundadır. Ancak proje **Workspace kuruluşuna ait** ve uygulama türü **"Internal"** ise doğrulama gerekmez. Proje kişisel `@gmail.com` hesabıyla açılırsa "Internal" seçeneği hiç çıkmaz.

- [ ] Tarayıcıda **Workspace yönetici hesabıyla** giriş yapıp console.cloud.google.com adresini açın. İlk girişte kuruluşunuz (organizasyon) genellikle otomatik oluşur.
- [ ] Yeni proje açın: ad `universal-mail`, konum olarak şirketin organizasyonunu seçin.
- [ ] **Proje kimliği (Project ID)** yazılıdır, not alın. Sonradan değiştirilemez.

---

## Adım 6 — Faturalandırma ve güvenlik ağı

Google Maps ürünleri kullanım başına ücretlendirilir. Ücretsiz aylık kota vardır ama **kart bağlamak yine de zorunludur**.

> **Önemli:** Google'daki **bütçe uyarısı harcamayı durdurmaz**, yalnızca e-posta atar. Gerçek bir sigorta için **günlük kota sınırı** koymak gerekir. İkisini de kuruyoruz.

- [ ] *Faturalandırma* bölümünde şirket adına fatura hesabı açın, şirketin kartını girin.
- [ ] **Bütçe uyarısı:** Aylık **20 USD**, eşikler %50, %90, %100. Uyarı e-postaları hem arkadaşa hem size gitsin.
- [ ] **Günlük kota sınırı (asıl güvenlik ağı):** *Google Maps Platform → Kotalar* sayfasında **Places API (New)** için yöntem başına günlük istek sınırını düşürün. Pilot için önerilen başlangıç:

  | Kota satırı (adı konsolda biraz değişebilir) | Günlük sınır |
  |---|---|
  | Text Search istekleri | 200 |
  | Nearby Search istekleri | 200 |
  | Place Details istekleri | 100 |

  Bu sınırlarla bir ay en kötü ihtimalle birkaç yüz çağrı aşım yapar; Google tarafı fatura **0 ile birkaç on dolar** arasında kalır. Sınırlar kota sayfasında istenen zamanda yükseltilir.
- [ ] Kota satırlarını "istek sayısı"na göre sınırladığınızı, SKU'ya (Pro/Enterprise) göre değil, unutmayın. Uygulamamızın kendi bütçe sayacı bunun üstüne ikinci katmandır (SRS FR-SET-05).

**Not alın:** fatura hesabı sahibi, bütçe tutarı, koyduğunuz kota değerleri.

---

## Adım 7 — API'leri açma ve anahtarlar

- [ ] *API'ler ve Hizmetler → Kitaplık* içinde şunları **etkinleştirin**:
  - **Places API (New)** ← yeni olan; adında "(New)" geçer. Eski "Places API"yi **açmayın**.
  - **Maps JavaScript API**
  - **Gmail API** (Adım 8 için)
- [ ] **İki ayrı API anahtarı** oluşturun (*API'ler ve Hizmetler → Kimlik Bilgileri → Anahtar oluştur*):

  | Anahtar | Kısıtlama (API) | Uygulama kısıtlaması |
  |---|---|---|
  | **Sunucu anahtarı** (tarama için) | Yalnızca **Places API (New)** | Yok. Ev internetinin IP'si değiştiği için IP kısıtlaması işe yaramaz. Koruma: API kısıtı + günlük kota. |
  | **Tarayıcı anahtarı** (harita için) | Yalnızca **Maps JavaScript API** | HTTP referrer kısıtı; uygulamanın iç adresi netleşince Faz 1'de ayarlanır. Şimdilik yalnızca API kısıtı yeterli. |

- [ ] *Google Maps Platform → Harita Yönetimi* bölümünden bir **Harita Kimliği (Map ID)** oluşturun: tür "JavaScript", vektör. Not alın.
- [ ] Anahtarları şifre yöneticisine kaydedin; ekran görüntüsü almayın.

**Not alın:** Map ID (gizli değildir), anahtarların adları (değerleri değil), hangi API'lere kısıtlı olduğu.

---

## Adım 8 — Gmail bağlantısı (OAuth, "Internal")

Uygulama, arkadaşın kutusundan e-posta gönderecek ve yanıt/bounce okuyacak.

- [ ] Yönetici hesabıyla *Google Auth Platform* (eski adıyla "OAuth izin ekranı") bölümüne gidin.
- [ ] **Marka:** Uygulama adı `Universal Mail`, destek e-postası şirket adresi.
- [ ] **Kitle (Audience):** **Internal** seçin. (Seçenek görünmüyorsa proje Workspace organizasyonuna bağlı değildir: Adım 5'e dönün.)
- [ ] **Veri erişimi (Scopes):** `gmail.send` (gönderme) ve `gmail.readonly` (yanıt ve bounce okuma) ekleyin.
- [ ] **İstemciler → İstemci oluştur:** Uygulama türü **Masaüstü uygulaması**. Oluşan **JSON dosyasını** indirmeyin ya da indirirseniz hemen şifre yöneticisine koyup dosyayı silin. (İçinde gizli anahtar vardır.)
- [ ] Uygulama ilk kez bağlanırken arkadaş kendi Workspace hesabıyla giriş yapıp izin verecek (Faz 3).

> Alternatif (önerilmez): Workspace olmadan "External / Test" modu. İzin süresi genellikle 7 gün sonunda dolar ve uygulama kendini her hafta yeniden bağlamak ister. "Internal" bu sorunu önler.

---

## Adım 9 — Ücretsiz sicil API hesapları (Faz 5, ertelenebilir)

Şimdi açmak zorunda değilsiniz. Yeni kurulan şirketleri erken yakalamak için:

- [ ] **Birleşik Krallık — Companies House:** developer.company-information.service.gov.uk adresinde hesap açın, bir "uygulama" oluşturup **REST API anahtarı** alın. Ücretsizdir, sınır 5 dakikada 600 istek.
- [ ] **Fransa — INSEE Sirene:** api.insee.fr kataloğunda hesap açıp Sirene API'sine abone olun. Ücretsizdir. Not: 2026 Eylül sonundan itibaren katalog parolası 90 günde bir yenilenmelidir.

---

## Adım 10 — Sizin geliştirme test projeniz

Geliştirme sırasında arkadaşın kotasını ve kartını kullanmamak için **sizin kendi, ayrı küçük proje**:

- [ ] Kişisel hesabınızla ayrı bir Google Cloud projesi (`um-dev`), aynı API'ler, aynı iki anahtar.
- [ ] Kotayı çok düşük tutun (örn. günlük **50** istek). Bütçe uyarısı **5 USD**.
- [ ] Anahtarlar yalnızca SanDisk'teki `.env` dosyasında durur (`.gitignore` sayesinde GitHub'a gitmez). Arkadaşın kuruluma **asla** sizin anahtarınız konmaz.

---

## Adım 11 — Anahtarları saklama ve teslim kuralları

- Anahtarlar şifre yöneticisinde durur. Arkadaş uygulamayı kurunca kurulum sihirbazına **kendi bilgisayarında** yapıştırır; uygulama bunları işletim sisteminin anahtarlığında saklar.
- Bir anahtar yanlışlıkla paylaşılırsa: Google Cloud'da o anahtarı **silin** ve yenisini oluşturun (5 dakikalık iş).
- Hesap yöneticiliği (Workspace süper admin, Google Cloud sahibi) **arkadaşın şirketinde** kalır. Sizin ona kalıcı erişiminiz olmaz. Gerekirse geçici "izleyici" yetkisi verilebilir.

---

## Faz 0 bitti mi? Kontrol listesi

- [ ] Alan adı satın alındı, iki adımlı doğrulama açık
- [ ] Workspace çalışıyor, gönderen kutusu hazır, aylık fatura planı seçili
- [ ] SPF, DKIM, DMARC kayıtlı ve test e-postasında üçü de `PASS`
- [ ] Postmaster Tools'a alan adı eklendi
- [ ] Alan adında vitrin ve gizlilik sayfası yayında, `optout@` adresi çalışıyor, çıkış uç noktası için barındırma yeri seçildi
- [ ] Google Cloud projesi Workspace organizasyonu altında
- [ ] Fatura hesabı bağlı, bütçe uyarısı (20 USD) kuruldu, **günlük kotalar düşürüldü**
- [ ] Places API (New), Maps JavaScript API, Gmail API açık
- [ ] Sunucu ve tarayıcı anahtarları oluşturulup API'ye göre kısıtlandı, Map ID alındı
- [ ] OAuth: Internal, Masaüstü istemci, iki izin eklendi
- [ ] Sizin `um-dev` test projeniz hazır, kota düşük
- [ ] Gönderen bilgileri (unvan, adres, vergi/MERSİS, imzalayan kişi) yazılı
- [ ] `docs/03-ANLASMA-NOTU.md` iki tarafça onaylandı
- [ ] Pilot ülke ve şehirler (2–3 ülke) belirlendi

---

## Sık karşılaşılan sorunlar

| Sorun | Neden / çözüm |
|---|---|
| "Internal" seçeneği yok | Proje kişisel hesapla açılmış. Workspace yönetici hesabıyla yeni proje açın. |
| DKIM "doğrulanmadı" | DNS henüz yayılmamış, birkaç saat bekleyin; kaydı kayıt şirketinde **tam** kopyaladığınızdan emin olun (bazı ekranlar alan adını otomatik ekler, kaydı iki kez yazmayın). |
| SPF hatası | Alan adında birden fazla SPF TXT kaydı var. Tek kayıtta birleştirin. |
| Harita "Bu sayfa Google Haritalar'ı doğru yüklemedi" | Faturalandırma bağlı değil ya da API açık değil ya da tarayıcı anahtarı yanlış API'ye kısıtlı. |
| Places çağrısı `REQUEST_DENIED` | Eski "Places API" yerine "(New)" açılmamış ya da anahtar yanlış API'ye kısıtlı. |
| Çağrı `429` / kota doldu | Günlük kota sınırına gelindi. Bu istenen bir koruma: ertesi gün devam eder ya da kotayı bilerek yükseltin. |
| Kart reddedildi | Kartın yurt dışı/internet alışverişi kapalı olabilir; bankadan açtırın. |

---

## Kaynaklar (güncel hâlini doğrulayın)
- [Google Maps Platform fiyatları](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Maps Platform maliyet yönetimi ve kotalar](https://developers.google.com/maps/billing-and-pricing/manage-costs)
- [Maps API anahtarı güvenliği](https://developers.google.com/maps/api-key-best-practices)
- [Gmail API izinleri](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [OAuth uygulama hazırlığı (Internal, doğrulama)](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Gmail gönderim sınırları](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)
