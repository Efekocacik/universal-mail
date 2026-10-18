# Universal Mail

Müşteri şirketin **yurt dışı dağıtım ağını büyütmek** için, Avrupa'da **yeni açılan / yakında açılacak** işletmeleri (kafe, restoran, otel, hastane, ofis vb.) Google Haritalar verisinden bulan, e-posta adreslerini çıkaran ve düzenlenebilir şablonlarla kontrollü B2B e-postası gönderen **yerel, tek kullanıcılı** araç. Yazılım müşteri şirkete fatura ile teslim edilir; hesaplar ve veriler müşteriye aittir, geliştiriciye hiçbir veri gitmez.

Satılan ürünler: tek kullanımlık çatal-bıçak, amerikan servis, ıslak mendil, peçete ve benzeri sarf malzemeleri.

## Belgeler
- [Yazılım Gereksinim Spesifikasyonu (SRS)](docs/01-SRS.md) — ne yapılacak, hangi API'ler, veri modeli, yasal kurallar, kabul kriterleri
- [Yol Haritası](docs/02-YOL-HARITASI.md) — 6 faz, 10–12 hafta, her fazın görev listesi
- [Faz 0 Kılavuzu](docs/04-FAZ0-KILAVUZU.md) — alan adı, Workspace, Google Cloud, kota, anahtarlar ve Gmail bağlantısı için adım adım hesap kurulumu
- [Anlaşma Notu](docs/03-ANLASMA-NOTU.md) — müşteri şirketle yarım sayfalık, resmi olmayan mutabakat notu

## Kurulum modeli
Uygulama **müşterinin bilgisayarına** kurulan bir masaüstü programıdır (macOS `.dmg` / Windows `.exe`). Geliştiricinin bilgisayarında hiçbir şey çalışmaz ve yer kaplamaz: kurulum dosyaları GitHub Actions ile bulutta derlenir, müşteriye link olarak verilir. Veri müşterinin bilgisayarında kalır.

## Özet kararlar
| Konu | Karar |
|---|---|
| İşletme verisi | Google **Places API (New)** — Text/Nearby Search, `includeFutureOpeningBusinesses` ile yakında açılacaklar |
| "Yeni açıldı" tespiti | Tekrarlayan tarama + snapshot karşılaştırması + yorum sayısı + sicil eşleşmesi → yenilik skoru |
| Erken sinyal (Faz 5) | UK Companies House, Fransa INSEE Sirene (ücretsiz şirket sicilleri) |
| E-posta bulma | İşletmenin kendi web sitesini tarama (ücretsiz); opsiyonel Hunter/Snov |
| Gönderim | Kendi alan adı + Google Workspace (Gmail API) veya SMTP; ısınma ve günlük tavan |
| Harita | Google Maps JavaScript API (ToS gereği zorunlu) |
| Teknoloji | TypeScript, Next.js 15, SQLite + Drizzle, Tailwind + shadcn/ui |
| Ticari model | Müşteri şirkete faturalı teslim; hesaplar/anahtarlar müşteri adına; yalnızca B2B; kişisel posta adresleri (gmail vb.) hariç; temas başına en fazla 3 e-posta |
| Uyum | Ülke bazlı politika motoru (DE/AT engelli, ES/IT yalnızca genel adres, UK/TR/FR/NL izinli), çıkış bağlantısı ve suppression zorunlu |

## Durum
**Faz 1 tamamlandı** (`feat/faz-1` dalı): şehir/harita seçimi, tarama, liste + harita, yeni işletme tespiti, CSV, kurulum sihirbazı ve masaüstü paketi. Demo sağlayıcıyla uçtan uca doğrulandı; gerçek Google anahtarıyla ilk deneme Faz 0 hesapları açılınca yapılacak. Ayrıntılar: [Faz 1 Notları](docs/05-FAZ1-NOTLARI.md).

## Geliştirme
```bash
npm run setup      # .env.local + veritabanı (ilk kez)
npm run dev        # http://127.0.0.1:3000 (web + arka plan işçisi)
npm test           # birim ve entegrasyon testleri
npm run build && npx playwright test   # uçtan uca testler
npm run dist       # macOS/Windows kurulum paketi (bulutta: GitHub Actions)
```
İlk denemede kurulum sihirbazında **Demo modu**'nu seçin: Google anahtarı olmadan yapay verilerle tüm akışı görebilirsiniz.
