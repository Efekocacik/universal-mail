# Universal Mail

Müşteri şirketin **yurt dışı dağıtım ağını büyütmek** için, Avrupa'da **yeni açılan / yakında açılacak** işletmeleri (kafe, restoran, otel, hastane, ofis vb.) Google Haritalar verisinden bulan, e-posta adreslerini çıkaran ve düzenlenebilir şablonlarla kontrollü B2B e-postası gönderen **yerel, tek kullanıcılı** araç. Yazılım müşteri şirkete fatura ile teslim edilir; hesaplar ve veriler müşteriye aittir, geliştiriciye hiçbir veri gitmez.

Satılan ürünler: tek kullanımlık çatal-bıçak, amerikan servis, ıslak mendil, peçete ve benzeri sarf malzemeleri.

## Belgeler

**Kullanıcı için (müşteri şirket):**
- [Kurulum Rehberi](docs/KURULUM.md) — macOS ve Windows'a temiz kurulum, imzasız uygulama uyarısını geçme, güncelleme (eskisinin üzerine kurulur, veriler korunur), kaldırma, 30 dakikalık kurulum listesi
- [Kullanım Kılavuzu](docs/KULLANIM.md) — ekran görüntüleriyle günlük iş akışı (tarama → liste → e-posta bulma → şablon → kampanya → yanıtlar), ayarlar, yedek ve geri yükleme, veri silme, yasal hatırlatmalar, sorun giderme
- [Teslim Listesi](docs/TESLIM.md) — teslim paketi, kurulum günü adımları (ilk tarama ve ilk test e-postası), kısa eğitim akışı, kaynak kod ve bakım dönemi kayıtları, imza listesi
- [Uyum Kuralları](docs/UYUM.md) — uygulamanın uyguladığı gönderim kurallarının sade özeti

**Proje ve geliştirme:**
- [Yazılım Gereksinim Spesifikasyonu (SRS)](docs/01-SRS.md) — ne yapılacak, hangi API'ler, veri modeli, yasal kurallar, kabul kriterleri
- [Yol Haritası](docs/02-YOL-HARITASI.md) — 6 faz, 10–12 hafta, her fazın görev listesi
- [Faz 0 Kılavuzu](docs/04-FAZ0-KILAVUZU.md) — alan adı, Workspace, Google Cloud, kota, anahtarlar ve Gmail bağlantısı için adım adım hesap kurulumu
- [Anlaşma Notu](docs/03-ANLASMA-NOTU.md) — müşteri şirketle yarım sayfalık, resmi olmayan mutabakat notu
- [Faz 1 Notları](docs/05-FAZ1-NOTLARI.md) — keşif motoru, Google verisi saklama kararı, kalan işler
- [Arayüz Rehberi](docs/07-UI-REHBERI.md) — renk dili (yeşil kaydet/onayla, kırmızı sil), düğme ve onay kalıpları, kullanılabilirlik kuralları
- [Faz 2 Notları](docs/06-FAZ2-NOTLARI.md) — e-posta bulma: API uçları, veri modeli, kararlar, doğrulanmayanlar
- [Faz 3 Notları](docs/08-FAZ3-NOTLARI.md) — şablonlar, kampanya, gönderim, uyum; açık teknik borç ve şirketten beklenenler
- [Faz 3 Canlı Doğrulama](docs/09-FAZ3-CANLI-DOGRULAMA.md) — yalnızca gerçek hesapla kanıtlanabilecek maddeler, kilitlerin açılma sırası, kanıt biçimi
- [Canlıya Geçiş](docs/10-CANLIYA-GECIS.md) — şirket girdileri (nereye, ne zaman, gizli mi), paylaşım kuralları, aşamalı canlı test sırası
- [Faz 4 Notları](docs/11-FAZ4-NOTLARI.md) — tarama motoru, keşif ekranı, arayüz cilası, takip iletileri, gösterge paneli
- [Faz 5 Notları](docs/12-FAZ5-NOTLARI.md) — sicil kaynakları, içe aktarma, yapay zekâ girişi, şablon dilleri; entegrasyon bekleyenler
- [Faz 6 Notları](docs/13-FAZ6-NOTLARI.md) — paketleme, şifreli yedek, saklama ve veri silme, güvenlik/performans/gizlilik; kullanıcıdan beklenenler
- [Çıkış aktarıcısı: Cloudflare Worker kurulumu (önerilen)](deploy/cloudflare-worker/README.md) — HTTPS tek tıklamalı abonelikten çıkış aktarıcısının ücretsiz Cloudflare Worker + D1 üzerinde, sunucusuz kurulumu
- [Çıkış aktarıcısı: VPS kurulumu (isteğe bağlı)](deploy/relay/README.md) — aynı aktarıcının Linux sunucusuna (systemd + Caddy) kurulumu

## Kurulum modeli
Uygulama **müşterinin bilgisayarına** kurulan bir masaüstü programıdır (macOS `.dmg` / Windows `.exe`); adımlar: [Kurulum Rehberi](docs/KURULUM.md). Geliştiricinin bilgisayarında hiçbir şey çalışmaz ve yer kaplamaz: kurulum dosyaları GitHub Actions ile bulutta derlenir, müşteriye link olarak verilir. Veri müşterinin bilgisayarında kalır.

## Özet kararlar
| Konu | Karar |
|---|---|
| İşletme verisi | Google **Places API (New)** — Text/Nearby Search, `includeFutureOpeningBusinesses` ile yakında açılacaklar |
| "Yeni açıldı" tespiti | Tekrarlayan tarama + snapshot karşılaştırması + yorum sayısı + sicil eşleşmesi → yenilik skoru |
| Erken sinyal (Faz 5) | UK Companies House, Fransa INSEE Sirene (ücretsiz şirket sicilleri) |
| E-posta bulma | İşletmenin kendi web sitesini tarama (ücretsiz); opsiyonel Hunter/Snov |
| Gönderim | Kendi alan adı + Google Workspace (Gmail API) veya SMTP; ısınma ve günlük tavan |
| Harita | Google Maps JavaScript API (ToS gereği zorunlu) |
| Teknoloji | TypeScript, Next.js 15, SQLite + Drizzle, Tailwind 4, Electron (masaüstü paketi) |
| Ticari model | Müşteri şirkete faturalı teslim; hesaplar/anahtarlar müşteri adına; yalnızca B2B; kişisel posta adresleri (gmail vb.) hariç; temas başına en fazla 3 e-posta |
| Uyum | Ülke bazlı politika motoru (DE/AT engelli, ES/IT yalnızca genel adres, UK/TR/FR/NL izinli), çıkış bağlantısı ve suppression zorunlu |

## Durum
**Faz 1 tamamlandı** (`feat/faz-1` dalı): şehir/harita seçimi, tarama, liste + harita, yeni işletme tespiti, CSV, kurulum sihirbazı ve masaüstü paketi. Demo sağlayıcıyla uçtan uca doğrulandı; gerçek Google anahtarıyla ilk deneme Faz 0 hesapları açılınca yapılacak. Ayrıntılar: [Faz 1 Notları](docs/05-FAZ1-NOTLARI.md).

**Faz 2 (e-posta bulma) kodlandı** (`feat/faz-2` dalı): işletmenin kendi web sitesinden nazik tarama (robots.txt, site başına ≤ 6 istek), e-posta/sosyal bağlantı çıkarma, doğrulama, isteğe bağlı Hunter.io yedeği, lead ayrıntısında düzenleme. Demo ile doğrulandı; gerçek sitelerde bulma oranı gerçek anahtarla ölçülecek. Ayrıntılar: [Faz 2 Notları](docs/06-FAZ2-NOTLARI.md).

**Faz 3 (şablonlar, kampanya, gönderim, uyum) demo olarak kodlandı; canlı entegrasyonun yazılım hazırlığı sürüyor, Faz 3 kapanmadı.** Şablonlar, kampanya sihirbazı, zamanlayıcı, ülke politikası, engel listesi, çıkış ve silme talepleri demo posta kutusuyla uçtan uca çalışır. Canlı hazırlık (Aşama 15.1–15.8: Gmail OAuth ve gönderim bağdaştırıcısı, gelen kutusu okuyucusu, Ed25519 imzalı RFC 8058 çıkış altyapısı, DNS denetimi, birleşik gönderim kapısı, ARF şikâyetleri) ve 15.10-1 migrasyonu yapıldı. **Gerçek e-posta gönderimi ve gerçek gelen kutusu okuma kodda kapalıdır**; açılmaları gerçek hesapla doğrulamaya, çıkış aktarıcısının dağıtımına, yazılı hukuki onaylara ve kayıtlı bir sürüme bağlıdır, ardından pilot (ilk hafta günde ≤ 20) gelir. Ayrıntılar: [Faz 3 Notları](docs/08-FAZ3-NOTLARI.md), [Canlı Doğrulama](docs/09-FAZ3-CANLI-DOGRULAMA.md), [Canlıya Geçiş](docs/10-CANLIYA-GECIS.md).

**Faz 4–6 kodlandı ve test edildi; yol haritasındaki altı fazın tamamı kodda tamamlandı.** Açık kalanlar müşterinin hesabını, makinesini veya kararını gerektirir (kod imzalama, temiz makinede kurulum denemesi, teslim günü, bakım ve kaynak kod kararları, çıkış sunucusunun dağıtımı, Gmail erişimi): [Faz 6 Notları → Kullanıcıdan beklenenler](docs/13-FAZ6-NOTLARI.md#10-kullanıcıdan-beklenenler).

## Geliştirme
```bash
npm run setup      # .env.local + veritabanı (ilk kez)
npm run dev        # http://127.0.0.1:3000 (web + arka plan işçisi)
npm run dev:demo   # aynısı, ayrı veri klasörü (.data-demo) + demo kampanya gönderimi ve demo gelen kutusu açık
npm test           # birim ve entegrasyon testleri
npm run build && npx playwright test   # uçtan uca testler
npm run dist       # macOS/Windows kurulum paketi (bulutta: GitHub Actions)
npm run docs:shots # docs/img/kullanim/ kılavuz ekran görüntüleri (önce npm run build; demo, geçici veri klasörü)
npm run build:worker # dist/cloudflare-worker/worker.js — Cloudflare Worker çıkış aktarıcısı (bkz. deploy/cloudflare-worker/README.md)
npm run build:relay  # dist/relay/relay.cjs — VPS çıkış aktarıcısı (bkz. deploy/relay/README.md)
```
İlk denemede kurulum sihirbazında **Demo modu**'nu seçin: Google anahtarı olmadan yapay verilerle tüm akışı görebilirsiniz.
