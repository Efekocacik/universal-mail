# Universal Mail — Yol Haritası

Toplam süre tahmini: **10–12 hafta** (tek geliştirici, haftada ~20 saat). Her faz sonunda çalışan, kullanılabilir bir sürüm olur. Fazlar sırayla; bir faz bitmeden sonrakine geçilmez.

```text
Hafta:  1    2    3    4    5    6    7    8    9    10   11   12
        ├─F0─┤
             ├────F1────┤
                        ├──F2──┤
                               ├────F3────┤
                                          ├──F4──┤
                                                 ├────F5────┤
                                                            ├─F6─┤
```

---

## Faz 0 — Hazırlık ve hesaplar (1 hafta)

Kod yazılmadan önce yapılması gerekenler. Hesap adımları **müşteri şirket adına** açılır (Google Cloud, alan adı, Workspace); geliştirici yalnızca rehberlik eder.

**Anlaşma (kod yazmadan önce, yarım sayfa)**

- [ ] `docs/03-ANLASMA-NOTU.md` doldurulur ve iki taraf onaylar (bedel, fatura şirketi, kodun kimde kalacağı, destek süresi). Resmi sözleşme gerekmez.
- [ ] Arkadaşının bilgisayarının işletim sistemini (macOS mu Windows mu) ve ona uzaktan/yan yana kurulum yapılıp yapılamayacağını öğren.
- [ ] Müşteri şirketin ihracat hedef ülkelerini ve ürün gruplarını yazılı al (pilot bölgeleri buna göre seçilecek).
- [ ] Fatura/vergi konularını müşterinin ve kendi muhasebecinle netleştir.

**Hesaplar ve anahtarlar (müşteri adına)**

- [ ] Google Cloud projesi aç, faturalandırmayı etkinleştir (kart gerekir; ücretsiz kota için bile zorunlu).
- [ ] Şu API'leri etkinleştir: **Places API (New)**, **Maps JavaScript API**. (Eski "Places API"yi değil.)
- [ ] Places API (New) ve Maps JavaScript API için ayrı anahtarlar oluştur; Electron/yerel uygulama ortamında uygulanabilir anahtar ve API kısıtlarını doğrula. Yerel istemciye gömülü anahtarların tamamen gizli tutulamayacağını hesaba kat.
- [ ] Faturalandırma bütçe uyarısı kur (örn. 30 USD).
- [ ] Gönderim için alan adı al (ana marka alan adından **farklı** olması önerilir: `firmaadi-iletisim.com` gibi) ve Google Workspace Starter hesabı aç.
- [ ] SPF, DKIM, DMARC kayıtlarını ekle (Faz 3'te uygulama bunu kontrol edecek).
- [ ] Google Cloud'da OAuth istemcisi oluştur (Gmail API, "Desktop app" tipi).
- [ ] Türkiye'ye de gönderim istenirse İYS'ye hizmet sağlayıcı kaydı başlat (süreç uzun sürebilir). İhracat odağında genelde gerekmez.
- [ ] (Faz 5 için) Companies House geliştirici hesabı ve INSEE API hesabı aç.

**Karar ve belge**

- [ ] SRS'yi oku, Bölüm 3 kategori listesini ve Bölüm 8 ülke listesini kendi önceliklerine göre işaretle. Google Maps Platform'un güncel veri saklama, önbellekleme ve dışa aktarma koşullarını doğrula; Google kaynaklı alanları bağımsız ve hukuka uygun kaynaklardan ayrıştıran veri modelini onayla.
- [ ] İlk pilot bölgeleri müşterinin ihracat hedeflerine göre seç (öneri: Londra, Manchester, Amsterdam, Brüksel — hepsi `allowed` ülkeler; Türkiye varsayılan kapalı).
- [ ] Meşru menfaat değerlendirmesi (LIA) şablonunu doldur (`docs/LIA.md`, Faz 3'te eklenecek).

**Çıktı:** `.env.example` doldurulmuş, anahtarlar hazır, pilot bölge listesi.

---

## Faz 1 — Tarama çekirdeği ve liste (MVP-1, 2 hafta)

**Hedef:** Bir şehir + kategori seti seç, tara, sonuçları listede ve haritada gör, CSV'ye aktar.

**Teknik işler**

- [ ] Proje iskeleti: Next.js 15 + TypeScript + Tailwind + shadcn/ui + Drizzle/SQLite. `npm run setup` betiği.
- [ ] Veri modeli: `regions`, `category_sets`, `scans`, `places`, `place_snapshots`, `leads`, `api_usage`, `settings`. Google kaynaklı alanları diğer kaynaklardan ayır; saklama ve dışa aktarma kurallarını veri kaynağına göre uygula.
- [ ] Places (New) REST istemcisi; `DISCOVERY` ve `ENRICH` field mask'leri sabit olarak kodda.
- [ ] Şehir → sınır kutusu listesi (Avrupa + Türkiye, ~500 şehir; açık veri setinden türetilir).
- [ ] Izgara bölücü: sınır kutusu → uyarlanabilir hücreler → Text Search/Nearby çağrıları; `includeFutureOpeningBusinesses: true`.
- [ ] Tarama öncesi çağrı/maliyet tahmini; bütçe sayacı; tavan aşımında durdurma.
- [ ] Uygulamanın yönettiği yerel worker süreci (`worker.ts`) + SQLite kuyruk tablosu; harici Redis kullanılmadan kaldığı yerden devam.
- [ ] Yenilik skoru v1 (FUTURE_OPENING, yorum sayısı, snapshot diff). Kullanıcının manuel başlattığı ikinci taramada önceki sonuçlarla karşılaştırma yap; zamanlanmış tekrar taramayı Faz 4'e bırak.
- [ ] Keşif ekranı: sol sanal liste + sağ Google Haritası, kümeleme, renkli işaretçiler, temel filtreler (ülke, şehir, kategori, yenilik, businessStatus). Harita üzerinde dikdörtgen/daire çizerek tarama bölgesi belirleme (FR-DIS-01, FR-UI-03).
- [ ] CSV dışa aktarma.
- [ ] **Electron kabuğu + GitHub Actions derleme hattı** (macOS `.dmg`, Windows `.exe`): daha ilk fazda kurulabilir bir sürüm üretilir; arkadaşın bilgisayarında erken test edilir. Derleme bulutta olduğu için geliştirici makinesi yük almaz.
- [ ] Kurulum sihirbazı v1 (Google anahtarları, bütçe, gönderen firma profili, hedef ihracat ülkeleri, ilk açılış kullanım onayı).

**Kabul:** Londra "kafe + fırın" taraması ≤ 5 dk, harita ve liste dolu, mor işaretçiler (yakında açılacak) görünüyor, maliyet sayacı artıyor.

---

## Faz 2 — E-posta bulma ve doğrulama (1,5 hafta)

**Hedef:** Seçilen lead'lerin web sitelerinden e-posta çıkar, doğrula, lead kartında göster.

- [ ] Web tarayıcı modülü: aday sayfa listesi (çok dilli), `mailto:`, regex, JSON-LD; statik sayfalarda `cheerio`, gerektiğinde Electron'un mevcut tarayıcı altyapısı. Erişim engelleri aşılmaz.
- [ ] Nezaket kuralları: robots.txt, site başına ≤ 6 istek, 1 sn aralık, kimliği belli User-Agent, 10 sn zaman aşımı.
- [ ] Doğrulama: sözdizimi → MX → disposable listesi → (opsiyonel) SMTP denemesi.
- [ ] Sosyal medya / iletişim formu yakalama.
- [ ] `lead_emails`, `lead_contacts` tabloları; kaynak URL ile birlikte.
- [ ] Toplu zenginleştirme (≤ 4 eşzamanlı), ilerleme, 24 saat sonra tek tekrar.
- [ ] Lead detay paneli: zaman çizelgesi, e-postalar, düzenleme, not, etiket.
- [ ] Yinelenen kayıt tespiti.
- [ ] Birim testleri: e-posta çıkarma (20+ gerçek site örneği fikstürü), doğrulama.

**Kabul:** 100 Londra kafesinin ≥ %40'ında e-posta bulunur; her e-postanın kaynağına tıklanınca ilgili sayfa açılır.

---

## Faz 3 — Şablonlar, kampanya, gönderim, uyum (2 hafta)

**Hedef:** İlk gerçek e-postalar güvenli şekilde gider; yanıt ve bounce takip edilir.

- [ ] Şablon editörü (konu + HTML/düz metin), SRS FR-TPL-01'deki tüm değişkenler (`{{firma_adres}}`, `{{telefon}}` dahil), eksik veri uyarıları, dil bazlı şablonlar, canlı önizleme, hazır TR/EN şablonlar.
- [ ] Zorunlu footer motoru (unvan, adres, çıkış bağlantısı, TR için MERSİS).
- [ ] Ülke politikası tablosu (`country_policies`) ve uyum kontrolü; hariç tutma sebepleri ekranı.
- [ ] Suppression listesi (elle, CSV, otomatik).
- [ ] Gmail OAuth bağlantısı + SMTP alternatifi; zorunlu MVP işlevi olarak "kendime test gönder" (FR-TPL-07).
- [ ] Kişisel posta alan adlarını (gmail.com vb.) hariç tutma, gönderen profili olmadan gönderimi kilitleme.
- [ ] Temas sıklığı sınırları (SRS 5.6.1): işletme/alan adı başına en fazla 3 e-posta, 5 gün aralık, 180 gün dinlenme, otomatik durdurma eşikleri, birim testleri.
- [ ] Gönderim kuyruğu: günlük tavan, ısınma eğrisi, rastgele aralık, alıcı yerel saat penceresi, duraklat/devam/iptal.
- [ ] Kampanya sihirbazı (4 adım) ve "Başlat" öncesi özet + ilk 5 önizleme.
- [ ] Gelen kutusu okuyucu: bounce (DSN) → suppression; yanıt → lead "yanıtladı", takip iptal.
- [ ] Erişilebilir iletişimden çıkma yöntemi ve suppression işleme; uygun altyapıda `List-Unsubscribe` / `List-Unsubscribe-Post` başlıkları. Gerçek tek tıklamalı çıkış gerekiyorsa HTTPS uç noktası veya eşdeğer güvenilir hizmet sağla; yalnızca `mailto:` yöntemini tek tıklamalı çıkış olarak sunma (FR-CMP-08).
- [ ] SPF/DKIM/DMARC kontrol ekranı.
- [ ] Gönderim günlüğü ve dışa aktarım; audit log.
- [ ] `docs/LIA.md` (meşru menfaat değerlendirmesi) ve `docs/UYUM.md` (kullanıcı için sade kurallar).

**Kabul:** SRS Bölüm 13 maddeleri 5–8 geçer. İlk hafta günde ≤ 20 e-posta ile pilot başlar.

---

## Faz 4 — Zamanlayıcı, yenilik motoru, arayüz cilası (1,5 hafta)

**Hedef:** Uygulama kendi kendine yeni açılanları bulmaya devam eder; arayüz "satış aracı" hissi verir.

- [ ] Bölge başına tekrarlayan tarama (7/14/30 gün), kaçan çalışmaların telafisi.
- [ ] Google Maps Platform'un güncel saklama/önbellekleme kurallarına göre veri tazeleme, yeniden sorgulama ve gerektiğinde silme; tüm alanlar için sabit bir 30 günlük kural varsayma.
- [ ] `FUTURE_OPENING → OPERATIONAL` geçiş tespiti ("açıldı!" bildirimi).
- [ ] RDAP alan adı yaşı sinyali.
- [ ] Dashboard: sayaçlar, bugünkü kuyruk, aylık harcama, "bu hafta yeni açılanlar" listesi.
- [ ] Harita görünümünde kullanım kolaylığı iyileştirmeleri; isteğe bağlı olarak "görünümdekileri seç" özelliğini değerlendir. Bölge çizerek tarama Faz 1'de tamamlanmış olmalı.
- [ ] Kaydedilmiş filtreler, toplu işlemler, klavye kısayolları.
- [ ] Koyu tema, boş durumlar, "Bu nedir?" balonları, TR/EN arayüz.
- [ ] Takip (follow-up) adımları (en fazla 2 takip, toplam 3 e-posta).
- [ ] Yerel bildirimler (macOS/Windows) — "12 yeni işletme bulundu".

**Kabul:** Uygulama bir hafta açık kaldığında zamanlanmış taramalar çalışır; yeni açılanlar dashboard'da birikir.

---

## Faz 5 — Sicil kaynakları, çok dil, yapay zekâ (2 hafta)

**Hedef:** Google'dan önce yakala; daha fazla ülke ve dil.

- [ ] UK Companies House Advanced Search entegrasyonu (SIC listesi yapılandırılabilir, `incorporated_from` kayan pencere).
- [ ] Fransa INSEE Sirene entegrasyonu (NAF listesi; 2027 NAF 2025 geçişi notu).
- [ ] Sicil ↔ Google bulanık eşleştirme (ad normalizasyonu + şehir/posta kodu); eşleşmeyenler için ayrı liste.
- [ ] Şablon dilleri: DE, FR, ES, IT, NL, PT, PL hazır şablonlar (DE yalnızca bilgi amaçlı; gönderim `blocked`).
- [ ] Kategori bazlı varyantlar ve A/B konu satırı.
- [ ] Opsiyonel Claude API ile `{{kisisel_giris}}` üretimi; her zaman insan onayı.
- [ ] Opsiyonel Hunter/Snov entegrasyonu (kullanıcı anahtarı ile).
- [ ] CSV/XLSX içe aktarma (harici listeler).
- [ ] Açılma takibi (varsayılan kapalı).

**Kabul:** Son 30 günde kurulmuş UK kafe şirketleri listelenir; en az %30'u Google kayıtlarıyla eşleşir.

---

## Faz 6 — Paketleme, yedekleme, dokümantasyon (1 hafta)

- [ ] Kurulum dosyalarının cilası: simge, ilk açılış rehberi, "imzasız uygulama" uyarısı için ekran görüntülü kurulum rehberi (macOS sağ tık → Aç, Windows SmartScreen).
- [ ] Otomatik veri klasörü, açılışta otomatik yedek ve göç; "verilerimi de sil" ile kaldırma.
- [ ] Opsiyonel: kod imzalama (Apple Developer, Windows sertifikası), uyarısız kurulum istenirse.
- [ ] Şifreli yedekleme/geri yükleme; otomatik haftalık yedek.
- [ ] Güncelleme akışı: yeni kurulum dosyası mevcut kurulumun üstüne kurulur, veri korunur; göç testleri.
- [ ] Veri saklama süresi (12 ay) ve "veriyi sil" akışı.
- [ ] Kullanıcı rehberi (`docs/KULLANIM.md`, ekran görüntülü, Türkçe), sorun giderme bölümü.
- [ ] Güvenlik gözden geçirmesi: anahtar saklama, `127.0.0.1` bağlama, `npm audit`.
- [ ] Performans testi: 100k lead ile filtreleme < 300 ms.
- [ ] Gizlilik doğrulaması: temiz kurulumda ağ trafiği izlenir; yalnızca kullanıcı tarafından etkinleştirilen Google, işletme siteleri, sicil API'leri, posta ve gerekli çıkış hizmetlerine bağlantılar doğrulanır (geliştiriciye giden trafik yok).
- [ ] Teslim paketi (kurulum dosyası + rehber): kurulum, müşteri hesabında ilk tarama ve ilk test e-postası birlikte yapılır; kısa eğitim; kaynak kodun kimde kalacağı anlaşma notuna göre; bakım dönemi başlangıç tarihi yazılı.

**Kabul:** Temiz bir bilgisayarda (Node/terminal olmadan) kurulum dosyasıyla 30 dakikada kurulup ilk tarama yapılır (NFR-06); geliştiricinin bilgisayarı kapalıyken de çalışır.

---

## Faz sonrası (v2 fikirleri, önceliklendirilmemiş)

- Çoklu posta kutusu rotasyonu ve ısınma otomasyonu (veya Instantly/Smartlead dışa aktarımı).
- WhatsApp Business API ile ikinci kanal (Türkiye için güçlü).
- Telefon arama listesi ve arama notları (Almanya gibi `blocked` ülkeler için).
- Fiyat listesi PDF üretimi ve e-postaya ekleme.
- Basit teklif/sipariş takibi (müşteri oldu → sipariş geçmişi).
- Instagram'da yeni açılan işletme sinyali (manuel liste içe aktarma ile).

---

## Önerilen depo yapısı

```text
universal-mail/
├── docs/
│   ├── 01-SRS.md
│   ├── 02-YOL-HARITASI.md
│   ├── LIA.md                (Faz 3)
│   ├── UYUM.md               (Faz 3)
│   └── KULLANIM.md           (Faz 6)
├── src/
│   ├── app/                  Next.js sayfaları ve API rotaları
│   ├── components/           arayüz bileşenleri (harita, liste, editör)
│   ├── db/                   Drizzle şeması ve göçler
│   ├── lib/
│   │   ├── places/           Places (New) istemcisi, field mask'ler, ızgara
│   │   ├── novelty/          yenilik skoru
│   │   ├── enrich/           web tarayıcı, e-posta çıkarma, doğrulama
│   │   ├── registry/         Companies House, Sirene
│   │   ├── mail/             Gmail, SMTP, gelen kutusu, footer, politika
│   │   ├── compliance/       ülke politikası, suppression
│   │   └── budget/           API kullanım ve maliyet sayacı
│   └── worker/               arka plan işçisi ve zamanlayıcı
├── data/
│   ├── cities.eu-tr.json     şehir sınır kutuları
│   ├── place-types.json      kategori → Google tip eşlemesi
│   ├── country-policies.json
│   └── templates/            hazır şablonlar (tr, en, ...)
├── tests/
├── scripts/                  setup, start, backup
├── .env.example
├── package.json
└── README.md
```