# Faz 1 — Uygulama Notları ve Devam Listesi

**Durum (19 Ekim 2026):** Faz 1 `feat/faz-1` dalında tamamlandı. Demo sağlayıcıyla uçtan uca doğrulandı. Aşağıdaki "Kalan işler" (çoğu gerçek Google anahtarı ve bulut derlemesi gerektirir) dışında bitti.

## 1. Ne yapıldı

| Kalem | Durum | Not |
|---|---|---|
| Proje iskeleti (Next.js 15, TypeScript, Tailwind 4, Drizzle + SQLite) | ✔ | `npm run setup` hazır |
| Veri modeli (11 tablo, ek migrasyonla genişler) | ✔ | Google alanları `places`, kullanıcı alanları `leads` içinde ayrı |
| Places API (New) REST istemcisi, DISCOVERY / ENRICH maskeleri | ✔ | Alan→SKU eşlemesi kodda; bilinmeyen alan istenemez |
| Şehir listesi (1.593 şehir, GeoNames CC BY 4.0) | ✔ | `scripts/build-cities.mjs` |
| Izgara bölücü, doygun hücreyi otomatik 4'e bölme | ✔ | En fazla 4 seviye, en küçük hücre 0,25 km |
| Tarama öncesi maliyet tahmini, bütçe sayacı, bütçede durdurma | ✔ | Tahmin aralık verir (düşük/beklenen/yüksek) |
| Yerel işçi + SQLite iş kuyruğu, duraklat/devam, çökme kurtarma | ✔ | Kapanışta tarama duraklar, kendiliğinden devam etmez |
| Yenilik skoru v1 + "yeni tespit" (snapshot farkı) | ✔ | Sinyal grupları, sona eren pencere, FUTURE→OPERATIONAL |
| Keşif ekranı (liste, filtre, harita, ayrıntı, tarama oluşturucu) | ✔ | Google harita bileşeni yazıldı, **gerçek anahtarla görsel test edilmedi** |
| CSV dışa aktarma | ✔ | Google kaynaklı alanlar varsayılan dışarıda; formül enjeksiyonu korumalı |
| Kurulum sihirbazı v1 (onay, firma, pazarlar, Google, bütçe) | ✔ | Onay olmadan veri toplama çalışmaz |
| Demo modu (yapay veri) | ✔ | Anahtarsız deneme ve test için |
| Electron kabuğu + paketleme | ✔ (macOS arm64) | Paketli uygulama duman testini ve pencere testini geçti |
| GitHub Actions derleme hattı | ✔ (yazıldı) | `.github/workflows/ci.yml`; **henüz bulutta çalıştırılmadı** (dal itilince ilk kez çalışır) |

**Performans (NFR-03, `npm run bench`):** 100.000 kayıtlık sentetik veritabanında liste, filtre, metin araması, harita kutusu ve harita noktası sorguları 15–98 ms, süzgeç sayıları (facet) 176 ms; hedef < 300 ms karşılandı. Kurulum paketi: macOS `.dmg` yaklaşık 141 MB.

**Testler:** 165 birim/entegrasyon testi geçiyor, kritik modüllerde kapsam %95,9 (hedef %80). Playwright uçtan uca paketi (`e2e/app.spec.ts`) 9/9 geçiyor. Paketlenmiş macOS uygulaması duman testini (`npm run smoke`) ve pencere testini geçti.

## 2. Çözülen hata

Esc tuşu ayrıntıyı kapatmıyordu: dinleyici, ayrıntı açılınca ekrandan kalkan liste bileşenindeydi. Dinleyici sayfa düzeyine (`GlobalKeys`) taşındı; Esc artık önce çizim modunu, sonra seçili işletmeyi kapatır. E2E testi bunu kapsar.

## 3. Kalan işler (sırayla)

1. **Dalı GitHub'a gönder ve bulut hattını ilk kez çalıştır** (kullanıcı onayıyla). Windows paketi, NSIS kurulumu ve Windows duman testi ilk kez orada denenecek; libsql dosya yolu Windows'ta doğrulanmadı (macOS'ta Türkçe harf, boşluk, `%`, `#`, `?` içeren yollar testle doğrulandı).
2. **Gerçek Google anahtarıyla ilk deneme** (Faz 0 hesapları tamamlanınca): Ayarlar → "Anahtarı test et"; küçük bir tarama; tür adlarının (örn. `tea_house`) ve `openingDate` alanının doğrulanması; Google Haritası'nda işaretçi, kümeleme ve çizimin görsel testi.
3. SRS'ye aşağıdaki sapmaları işle (SRS'yi başka bir kişi güncellediği için ayrı, küçük bir PR olarak).
4. `npm audit` ve güvenlik gözden geçirmesi; içerik güvenlik politikası (CSP) Faz 6'ya bırakıldı çünkü Google Maps ile birlikte gerçek anahtarla denenmeden güvenli yazılamaz.
5. Dalı `main`'e birleştirmek için PR aç (kullanıcı onayıyla).
6. İsteğe bağlı: Intel Mac paketi (x64 koşucu), kod imzalama.

## 4. SRS'den sapmalar ve kararlar

- **DISCOVERY maskesi** `addressComponents` ve `googleMapsUri` ile genişletildi (aynı "Pro" fiyat sınıfı, ek maliyet yok). Ülke/şehir filtresi için gerekli.
- **SQLite sürücüsü:** `better-sqlite3` yerine `@libsql/client` (N-API ikilileri Electron sürümüne bağlı yeniden derleme gerektirmez). Veritabanı yine yerel bir SQLite dosyasıdır. Tek bağlantı, WAL modu.
- **Paketleme:** electron-builder `node_modules` adını dışarıda bıraktığı için sunucunun `node_modules` klasörü ayrıca kopyalanır; Next'in izleyicisi libsql'in platforma özgü yerel paketini yakalamadığı için `scripts/prepare-standalone.mjs` ekler. İkisini de paketli uygulamanın duman testi yakaladı.
- **Zamanlanmış tarama yok** (Faz 4). "Yeniden tara" düğmesi elle çalışır ve önceki taramayla karşılaştırır.
- **Pencere kapanınca uygulama kapanır**; çalışan tarama varsa kullanıcıya sorulur ve tarama duraklatılır. Arka planda onaysız ücretli çağrı sürmez.
- **Şematik harita** yalnızca demo veri içindir. Google verisi, Google dışı bir çizimde gösterilmez (Google şartları).
- **Sürümler:** Next 15.5, TypeScript 5.9 (7 değil), ESLint 9, Vitest 5, Electron 44.
- `src/lib/sources` için bir `LeadSource` arayüzü **henüz yazılmadı**. Faz 5 sicil kaynakları için `leads.source` alanı ve boş bırakılabilir `place_id` hazır; arayüz o fazda tasarlanır.
- İmzasız paketler: macOS "tanımlanamayan geliştirici", Windows SmartScreen uyarısı gösterir. macOS'ta uygulama güncellenince Anahtarlık izni yeniden istenebilir. İmzalama Apple Developer (yaklaşık 99 USD/yıl) ve Windows sertifikası gerektirir.

## 5. Sonraki fazların eklenme noktaları (mevcut kodu bozmadan)

- **Arka plan işi:** `registerJobHandler("enrich.website", ...)` (Faz 2), `"mail.send"` (Faz 3). İşçi döngüsü değişmez.
- **Olaylar:** `onEvent("place.enriched", ...)` ile Faz 2 e-posta bulma, zenginleştirme bitince tetiklenir.
- **Yenilik sinyalleri:** `computeNovelty({ extraSignals })` ile sicil (Faz 5) ve alan adı yaşı sinyalleri eklenir.
- **Veritabanı:** yeni tablolar yeni migrasyon dosyasıyla eklenir (`npm run db:generate`); uygulama açılışta yedek alıp geçişi uygular.
- **Arayüz:** gezinme öğeleri `src/components/app-shell.tsx` içindeki `NAV_ITEMS` dizisinde; metinler `src/lib/i18n/tr.ts` içinde (İngilizce Faz 4'te `en.ts`).
- **Uyum kapıları:** veri toplama uç noktaları `requireCollectionReady`, hedef ülke denetimi `checkTargetCountry` ile korunur; Faz 3 gönderim uç noktaları aynı kapıları kullanmalıdır.

## 6. Çalıştırma

Tüm geliştirme dosyaları ve önbellekler SanDisk'tedir (Mac'te yer yok).

```bash
. /Volumes/SanDisk/.um-env.sh     # önbellekleri SanDisk'e yönlendirir ve proje klasörüne geçer
npm run setup                     # .env.local + veritabanı (ilk kez)
npm run dev                       # http://127.0.0.1:3000 (web + işçi)
npm test                          # birim ve entegrasyon testleri
npm run build && npm run dist:dir # üretim derlemesi + paketli uygulama (release/)
npm run smoke                     # paketli uygulamanın duman testi
npx playwright test               # uçtan uca (önce npm run build)
```

Demo modunda denemek için kurulum sihirbazında "Demo modu"nu seçin; Ayarlar'daki "Zamanı ilerlet" ile 14 gün sonraki ikinci taramayı simüle edebilirsiniz.

## 7. Yan etki

Paketli uygulamanın duman testi macOS Anahtarlığı'nda **"Universal Mail Safe Storage"** adlı bir kayıt oluşturdu (uygulamanın gizli depo anahtarı için). Zararsızdır; istenirse Anahtarlık Erişimi'nden silinebilir.
