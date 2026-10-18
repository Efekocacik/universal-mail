# Faz 1 — Uygulama Notları ve Devam Listesi

**Durum (19 Ekim 2026):** Faz 1 `feat/faz-1` dalında tamamlandı. Demo sağlayıcıyla uçtan uca doğrulandı. Aşağıdaki "Kalan işler" (çoğu gerçek Google anahtarı ve bulut derlemesi gerektirir) dışında bitti.

## 1. Ne yapıldı

| Kalem | Durum | Not |
|---|---|---|
| Proje iskeleti (Next.js 15, TypeScript, Tailwind 4, Drizzle + SQLite) | ✔ | `npm run setup` hazır |
| Veri modeli (11 kalıcı tablo + geçici Google önbelleği, ek migrasyonla genişler) | ✔ | Kalıcı kayıtta Google içeriği yok (bkz. Bölüm 3); kullanıcı alanları `leads` içinde |
| Places API (New) REST istemcisi, DISCOVERY / ENRICH maskeleri | ✔ | Alan→SKU eşlemesi kodda; bilinmeyen alan istenemez |
| Şehir listesi (1.593 şehir, GeoNames CC BY 4.0) | ✔ | `scripts/build-cities.mjs` |
| Izgara bölücü, doygun hücreyi otomatik 4'e bölme | ✔ | En fazla 4 seviye, en küçük hücre 0,25 km |
| Tarama öncesi maliyet tahmini, bütçe sayacı, bütçede durdurma | ✔ | Tahmin aralık verir (düşük/beklenen/yüksek) |
| Yerel işçi + SQLite iş kuyruğu, duraklat/devam, çökme kurtarma | ✔ | Kapanışta tarama duraklar, kendiliğinden devam etmez |
| Yenilik skoru v1 + "yeni tespit" (snapshot farkı) | ✔ | Sinyal grupları, sona eren pencere, FUTURE→OPERATIONAL |
| Keşif ekranı (liste, filtre, harita, ayrıntı, tarama oluşturucu) | ✔ | Google harita bileşeni Google'ın belgelenmiş sözleşmesine sıkı uyan sahte bir Maps ile test edildi (7 senaryo); **gerçek anahtarla görsel test edilmedi** |
| CSV dışa aktarma | ✔ | Google kaynaklı alanlar varsayılan dışarıda ve yalnızca önbellekteyse dolu; formül enjeksiyonu korumalı |
| Kurulum sihirbazı v1 (onay, firma, pazarlar, Google, bütçe) | ✔ | Onay olmadan veri toplama çalışmaz |
| Demo modu (yapay veri) | ✔ | Anahtarsız deneme ve test için |
| Electron kabuğu + paketleme | ✔ (macOS arm64) | Paketli uygulama duman testini ve pencere testini geçti |
| GitHub Actions derleme hattı | ✔ (yazıldı) | `.github/workflows/ci.yml`; **henüz bulutta çalıştırılmadı** (dal itilince ilk kez çalışır) |

**Performans (NFR-03, `npm run bench`):** 100.000 kayıtlık sentetik veritabanında liste, filtre, metin araması, harita kutusu ve harita noktası sorguları 15–98 ms, süzgeç sayıları (facet) 176 ms; hedef < 300 ms karşılandı. Kurulum paketi: macOS `.dmg` yaklaşık 141 MB.

**Testler:** 188 birim/entegrasyon testi geçiyor, kritik modüllerde kapsam %95 (hedef %80). Playwright uçtan uca paketi 17/17 geçiyor (`e2e/app.spec.ts` 10, `e2e/google-map.spec.ts` 7). Paketlenmiş macOS uygulaması duman testini (`npm run smoke`) ve pencere testini geçti (saklama kararından önceki sürümle; son sürümle yeniden çalıştırılacak, bkz. Bölüm 4 madde 1).

## 2. Çözülen hatalar

- **Esc tuşu** ayrıntıyı kapatmıyordu: dinleyici, ayrıntı açılınca ekrandan kalkan liste bileşenindeydi. Sayfa düzeyine (`GlobalKeys`) taşındı. E2E testi kapsar.
- **Tarama güvenlik sınırı çıkmazı:** çağrı sınırına takılıp duraklayan tarama, devam edilince aynı noktada yeniden duruyordu. `effectiveMaxCalls` ile devamda sınır, o ana kadarki çağrılara göre genişler; regresyon testleri var.
- **Harita çizimi ve işaretçi tıklamaları:** Google Maps'te `mousedown` olayı yoktur ve `AdvancedMarkerElement` tıklaması `gmpClickable` + `gmp-click` ister. Çizim kendi katmanımıza taşındı, işaretçiler düzeltildi; 7 senaryolu sahte-Maps testi (kümeleme dahil) eklendi. En büyük çizilen daire 50 km'de bbox 10.000 km² sınırını aşıyordu; 49 km'ye sınırlandı.

## 3. Google verisi saklama kararı (önemli)

Google Maps Platform şartlarına göre **yalnızca Place ID süresiz, enlem/boylam en çok 30 gün** saklanabilir; ad, adres, telefon, web sitesi, tür, değerlendirme sayısı gibi diğer Places içeriği önbelleğe alınıp kalıcı bir lead havuzu yapılamaz. (Bu, şartların bizim okumamızdır; **gerçek kullanım öncesinde Google'ın güncel metni doğrulanmalıdır.**) Bu yüzden Faz 1 veri modeli şöyle ayrıldı:

| Nerede | Ne var | Ömrü |
|---|---|---|
| `google-session.db` (ayrı dosya, `gcache` takma adıyla bağlı) | ad, adres, tür, durum, açılış tarihi, web sitesi, telefon, değerlendirme sayısı | Yalnızca uygulama açıkken; her açılışta ve kapanışta dosya silinir, ayrıca 30 günü aşan satırlar silinir |
| Ana veritabanı `places` | Place ID, enlem/boylam, türetilmiş bayraklar (`was_future`, `is_closed`, `new_detected_at`, `opened_detected_at`) | Koordinat en çok 30 gün (işçi 6 saatte bir temizler, "Google verilerini sil" düğmesi hemen siler) |
| Ana veritabanı `leads` | bizim etiketlerimiz: `category_key`, `country_code`/`city` (GeoNames'ten yaklaşık), `display_name` (kullanıcı girer), yenilik skoru ve gerekçeleri, durum, not, etiket | Kalıcı |

`tests/storage-policy.test.ts`, ham dosya baytlarını okuyarak ana veritabanında Google adı/adresi/telefonu/web sitesi **bulunmadığını**, yalnızca önbellek dosyasında bulunduğunu doğrular.

**Sonuçları (kullanıcıya görünen):**
- Uygulama yeniden açıldığında liste kategori, şehir, yenilik skoru ve notlarla gelir ama işletme **adları boştur** ("Ad yüklenmedi"). Listedeki "Yükle" düğmesi (veya ayrıntıdaki "Google verisini yükle") adları Place Details Pro ile yeniden alır; maliyet önceden gösterilir ve tek seferde en fazla 2.000 işletme yüklenir. Demo modunda ücretsizdir; gerçek anahtarla Pro çağrılarının ücretsiz kotası vardır.
- Konum 30 günden eski veya silinmişse işletme haritada görünmez; "Google verisini yükle" konumu da geri getirir.
- İşletmenin adını kendiniz yazabilirsiniz ("Görünen ad", bizim kaydımız). Metin araması yalnızca yüklü adları ve görünen adı kapsar.
- Yenilik skoru gerekçeleri Google içeriği (tarih, sayı) taşımaz; "az değerlendirme" sinyali, önbellek boşken önceki hesaplamadan korunur.

**E-posta gönderimine etkisi (Faz 2–3):** E-posta adresleri Google'dan değil, işletmenin **kendi web sitesinden** okunur ve bizim verimiz olarak kalıcı saklanır. Akış: keşif → "zenginleştir" (web sitesi önbelleğe gelir) → `place.enriched` olayı → Faz 2 sitesini **anlık** tarar → bulunan e-posta ve kaynak sayfa kalıcı kaydedilir. Gönderim anında hedef ülke kuralı, kalıcı `country_code` ve gerekirse tek bir canlı Place Details çağrısıyla (ya da e-posta alan adı/telefon önekiyle) doğrulanır. Yani Google içeriğini saklamadan e-posta gönderimi **tam çalışır**; tek ek maliyet, yeniden açılışta adları geri yüklemek isteyen kullanıcı için Pro çağrılarıdır.

## 4. Kalan işler (sırayla)

1. **Bulut hattını ilk kez çalıştır:** dal GitHub'a gönderilince `ci.yml` ilk kez çalışır; sonucu (özellikle Windows paketi ve duman testi) kontrol edin. Saklama kararından sonra paketli macOS uygulamasının duman ve pencere testi de yeniden çalıştırılmalıdır.
   Ayrıca: Windows paketi, NSIS kurulumu ve Windows duman testi ilk kez orada denenecek; libsql dosya yolu Windows'ta doğrulanmadı (macOS'ta Türkçe harf, boşluk, `%`, `#`, `?` içeren yollar testle doğrulandı).
2. **Gerçek Google anahtarıyla ilk deneme** (Faz 0 hesapları tamamlanınca): Ayarlar → "Anahtarı test et"; küçük bir tarama; tür adlarının (örn. `tea_house`) ve `openingDate` alanının doğrulanması; Google Haritası'nda işaretçi, kümeleme ve çizimin görsel testi.
3. SRS'ye Bölüm 5'teki sapmaları işle (SRS'yi başka bir kişi güncellediği için ayrı, küçük bir PR olarak).
4. `npm audit` ve güvenlik gözden geçirmesi; içerik güvenlik politikası (CSP) Faz 6'ya bırakıldı çünkü Google Maps ile birlikte gerçek anahtarla denenmeden güvenli yazılamaz.
5. Dalı `main`'e birleştirmek için PR aç (kullanıcı onayıyla).
6. İsteğe bağlı: Intel Mac paketi (x64 koşucu), kod imzalama.

## 5. SRS'den sapmalar ve kararlar

- **DISCOVERY maskesi** `addressComponents` ve `googleMapsUri` İSTEMEZ: ülke/şehir kendi şehir veri setimizden (GeoNames, en yakın şehir ≤ 60 km, yoksa bölgenin ülkesi), Google Haritalar bağlantısı Place ID'den üretilir. Böylece Google adres içeriği hiç kalıcı kayda girmez. Yaklaşık ülke/şehir, e-posta uyumu için gönderim anında canlı doğrulanır.
- **Saklama modeli** SRS Bölüm 8.1'deki "ayrı yönetilen alanlar" ilkesini uygular (yukarıda Bölüm 3). SRS FR-DIS-10 ile uyumludur; SRS metni ayrı PR'da güncellenecek.
- **SQLite sürücüsü:** `better-sqlite3` yerine `@libsql/client` (N-API ikilileri Electron sürümüne bağlı yeniden derleme gerektirmez). Veritabanı yine yerel bir SQLite dosyasıdır. Tek bağlantı, WAL modu.
- **Paketleme:** electron-builder `node_modules` adını dışarıda bıraktığı için sunucunun `node_modules` klasörü ayrıca kopyalanır; Next'in izleyicisi libsql'in platforma özgü yerel paketini yakalamadığı için `scripts/prepare-standalone.mjs` ekler. İkisini de paketli uygulamanın duman testi yakaladı.
- **Zamanlanmış tarama yok** (Faz 4). "Yeniden tara" düğmesi elle çalışır ve önceki taramayla karşılaştırır.
- **Pencere kapanınca uygulama kapanır**; çalışan tarama varsa kullanıcıya sorulur ve tarama duraklatılır. Arka planda onaysız ücretli çağrı sürmez.
- **Şematik harita** yalnızca demo veri içindir. Google verisi, Google dışı bir çizimde gösterilmez (Google şartları).
- **Sürümler:** Next 15.5, TypeScript 5.9 (7 değil), ESLint 9, Vitest 5, Electron 44.
- `src/lib/sources` için bir `LeadSource` arayüzü **henüz yazılmadı**. Faz 5 sicil kaynakları için `leads.source` alanı ve boş bırakılabilir `place_id` hazır; arayüz o fazda tasarlanır.
- İmzasız paketler: macOS "tanımlanamayan geliştirici", Windows SmartScreen uyarısı gösterir. macOS'ta uygulama güncellenince Anahtarlık izni yeniden istenebilir. İmzalama Apple Developer (yaklaşık 99 USD/yıl) ve Windows sertifikası gerektirir.

### Bilinen sınırlamalar

- Metin araması SQLite `LIKE` kullanır; büyük/küçük harf eşitliği yalnızca ASCII için geçerlidir ("Ö" ile "ö" eşleşmez). Faz 2'de arama alanı (normalize edilmiş ad) eklenebilir.
- "Web sitesi var/yok" ve değerlendirme sayısı süzgeçleri yalnızca Google verisi yüklü satırlara uygulanır.
- Çökme veya zorla kapanmada `google-session.db` bir sonraki açılışa kadar diskte kalabilir; açılışta silinir.

## 6. Sonraki fazların eklenme noktaları (mevcut kodu bozmadan)

- **Arka plan işi:** `registerJobHandler("enrich.website", ...)` (Faz 2), `"mail.send"` (Faz 3). İşçi döngüsü değişmez.
- **Olaylar:** `onEvent("place.enriched", ...)` ile Faz 2 e-posta bulma, zenginleştirme bitince tetiklenir.
- **Yenilik sinyalleri:** `computeNovelty({ extraSignals })` ile sicil (Faz 5) ve alan adı yaşı sinyalleri eklenir.
- **Veritabanı:** yeni tablolar yeni migrasyon dosyasıyla eklenir (`npm run db:generate`); uygulama açılışta yedek alıp geçişi uygular.
- **Arayüz:** gezinme öğeleri `src/components/app-shell.tsx` içindeki `NAV_ITEMS` dizisinde; metinler `src/lib/i18n/tr.ts` içinde (İngilizce Faz 4'te `en.ts`).
- **Uyum kapıları:** veri toplama uç noktaları `requireCollectionReady`, hedef ülke denetimi `checkTargetCountry` ile korunur; Faz 3 gönderim uç noktaları aynı kapıları kullanmalıdır.

## 7. Çalıştırma

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

## 8. Yan etki

Paketli uygulamanın duman testi macOS Anahtarlığı'nda **"Universal Mail Safe Storage"** adlı bir kayıt oluşturdu (uygulamanın gizli depo anahtarı için). Zararsızdır; istenirse Anahtarlık Erişimi'nden silinebilir.
