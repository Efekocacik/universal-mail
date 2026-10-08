# Universal Mail

Avrupa ve Türkiye'de **yeni açılan / yakında açılacak** işletmeleri (kafe, restoran, otel, hastane, ofis vb.) Google Haritalar verisinden bulan, e-posta adreslerini çıkaran ve düzenlenebilir şablonlarla kontrollü satış e-postası gönderen **yerel, tek kullanıcılı** araç.

Satılan ürünler: tek kullanımlık çatal-bıçak, amerikan servis, ıslak mendil, peçete ve benzeri sarf malzemeleri.

## Belgeler
- [Yazılım Gereksinim Spesifikasyonu (SRS)](docs/01-SRS.md) — ne yapılacak, hangi API'ler, veri modeli, yasal kurallar, kabul kriterleri
- [Yol Haritası](docs/02-YOL-HARITASI.md) — 6 faz, 10–12 hafta, her fazın görev listesi

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
| Uyum | Ülke bazlı politika motoru (DE/AT engelli, ES/IT yalnızca genel adres, UK/TR/FR/NL izinli), çıkış bağlantısı ve suppression zorunlu |

## Durum
Faz 0 (hazırlık). Henüz kod yok; önce `docs/02-YOL-HARITASI.md` içindeki Faz 0 listesi tamamlanmalı.
