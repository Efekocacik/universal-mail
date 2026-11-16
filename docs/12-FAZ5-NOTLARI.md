# Faz 5 — Sicil Kaynakları, Çok Dil, Yapay Zekâ: Uygulama Notları

**Durum (15 Kasım 2026):** Faz 5 `feat/faz-5` dalında kodlandı; P0 temeli ve dört paket (R, I, A, T) birleştirildi, ardından paketler arası "dikişler" ve son inceleme turunun bulguları (Bölüm 6.1) kapatıldı. Bütün kalite kapıları (typecheck, lint, format:check, test:coverage) ve üretim derlemesi üzerinde Playwright paketi iki kez arka arkaya yeşil (Bölüm 6). **Kabul ölçütü** ("son 30 günde kurulmuş UK kafe şirketleri listelenir; en az %30'u Google kayıtlarıyla eşleşir") **sahte Companies House sunucusu ve demo taramasıyla** kanıtlandı (Bölüm 7); gerçek Companies House / INSEE anahtarıyla çalışma **yapılmadı**. Claude, Hunter ve Snov yalnızca sahte HTTP ile sınandı; hiçbir testte gerçek dış API çağrılmaz. Canlı kapılar (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `LEGAL_APPROVALS`) **Faz 5'te değiştirilmedi**.

> Bu belge yalnızca kod ve testlerle doğrulanmış olanı "yapıldı" diye yazar. Demo modunda, sahte sağlayıcıyla veya fikstürle çalışan; ya da gerçek hesap, anahtar veya hukuki onay isteyen her şey açıkça işaretlidir. Bir çelişki görürseniz **kod belirleyicidir**. Belgedeki işletme adları ve alan adları yapaydır.

## 1. Genel bakış

Simgeler: ✔ yapıldı ve test edildi · ◐ kısmen (demo/sahte sağlayıcı/fikstür kapsamında veya gerçek hesap bekliyor) · ✘ yapılmadı.

| Kalem (yol haritası) | Paket | Durum | Not |
|---|---|---|---|
| UK Companies House Advanced Search (SIC listesi, kayan `incorporated_from` penceresi) | R | ◐ | İstemci yapay fikstürlerle ve demo sağlayıcıyla testli; gerçek anahtarla denenmedi |
| Fransa INSEE Sirene (NAF listesi, NAF 2025 notu) | R | ◐ | Fikstürle testli; `NAF2025` INSEE karşılık tablosu yayımlanana dek reddedilir |
| Sicil ↔ Google bulanık eşleştirme, eşleşmeyenler ayrı liste | R | ✔ | Ad normalizasyonu + şehir/posta kodu; "Sicilde var, haritada eşleşmedi" sekmesi; demo kabulü ≥ %30 |
| Şablon dilleri DE, FR, ES, IT, NL, PT, PL (DE yalnızca bilgi amaçlı) | T | ✔ | Hazır şablonlar tohumla eklenir; DE gönderimde, kampanya adımında ve kendine testte reddedilir |
| Kategori varyantları ve A/B konu satırı | T | ✔ | Varyant artık şablon düzenleyicisinden de seçilir (Bölüm 6.1) |
| İsteğe bağlı Claude ile `{{kisisel_giris}}`, her zaman insan onayı | A | ◐ | Demo üretici ağsız; canlı istemci sahte HTTP ile testli, gerçek anahtarla denenmedi |
| İsteğe bağlı Hunter / Snov (kullanıcı anahtarıyla) | A | ◐ | Sahte HTTP ile testli; Snov belirteç ucunun gerçek davranışı doğrulanmadı |
| CSV/XLSX içe aktarma | I | ✔ | Ayrıştırıcılar (CSV, kendi zip okuyucumuzla XLSX), kopya denetimi, geri al / geri getir |
| Açılma takibi (varsayılan kapalı) | T | ◐ | Bu sürümde **yalnızca demo**: canlı iletiye piksel eklenmez (genel erişilebilir aktarıcı ucu gelene dek) |
| Faz 4 denetiminden kalan hatalar (işlem kuyruğu, N+1, CAS, TB-11(d)…) | P0 öncesi | ✔ | Bölüm 2.0 |

**Paketler:** P0 (ortak temel: migrasyon `0005`, ayar anahtarları, gizli adlar, hata kodu kataloğu, i18n parçaları, paket sözleşmeleri) · R (resmî sicil) · I (içe aktarma) · A (Claude kişisel giriş, Hunter/Snov) · T (şablon dilleri, varyantlar, A/B, açılma izleme). Paketler ayrı dallarda geliştirildi, bağımsız inceleme turundan geçti ve `--no-ff` birleştirmelerle tek dala alındı; paketler arası dikişler (içe aktarılan/sicil lead'lerinin Keşif'te listelenmesi, içe aktarılan sitenin e-posta aramasında kullanılması, onay bekleyen girişin kampanyada ertelenmesi, ayar kartı yardım balonları) ayrı commitlerle bağlandı.

## 2. Özellikler: kullanıcı ne görür, nasıl çalışır

### 2.0 Faz 4 denetiminden kalan hataların kapanışı (Faz 5'in ilk işi)

Faz 4 sonundaki denetimde ertelenen işler Faz 5 paketlerinden **önce** kapatıldı (ayrıntı docs/11 Bölüm 9):

- **Veritabanı bağlantı kuyruğu (süreç içi işlem kapısı):** `src/lib/db/client.ts` tek bağlantıyı paylaşan sorgu ve işlemleri sıraya koyar; bir işlem sürerken gelen istek `TRANSACTION_ACTIVE` ile reddedilmek yerine sırasını bekler (15 sn; aşılırsa 503 `DB_BUSY`). İşlem geri çağrısının içinden işlem dışı bağlantı kullanılırsa kilitlenme yerine hemen hata verir. Test: `db-tx-queue`, `db-busy-recovery`.
- **N+1 ve O(N²) kaldırıldı:** kampanyaya ekleme, yeniden denetim ve başlatma uygunluğu toplu ön yüklemeyle (`prepareEnrollmentBatch`); e-posta araması kuyruğa alınırken lead'ler tek işlemde toplu işaretlenir ve durdurma tek `UPDATE`'tir; engel listesi CSV içe aktarması toplu okuma/yazmayla; Gmail gelen kutusu iletileri sınırlı eşzamanlılıkla okunur (sıra korunur). Test: `eligibility-batch`, `email-enqueue-batch`, `suppression-csv-batch`, `gmail-inbox`.
- **Durum yazılarında karşılaştır-değiştir (CAS):** tarama çalıştırıcısının durum yazıları kullanıcının duraklatma/iptalini ezmez; elle sürdürme tek işlemde yapılır; 2 dakikadan uzun süre işsiz `queued` kalan taramalar yeniden kuyruğa alınır.
- **Sağlayıcı değişimi:** `places.provider` değişince eski sağlayıcının bitmemiş taramaları `PROVIDER_CHANGED` ile duraklar; demo onayıyla Google'da sürmez.
- **TB-11(d) `in_flight`:** gönderim ortasındaki aynı işletme dizisi, şikâyetten sonra sonuç kaydedilince durur.
- **Kopuk zamanlama zinciri** Taramalar sayfasında uyarı olarak görünür; "Yeniden başlat" `POST /api/schedules/rearm` ile kurar.
- Küçük işler: "Şimdi çalıştır" `NEEDS_ACK` yanıtı tutarları taşır; duraklatma nedeni koddan yerelleşir; masaüstü bildirimleri açılınca biriken eski bildirimler patlamaz; dar ekranda "/" kısayolu; e2e sunucusu geçici klasör bırakmaz.

### 2.1 Resmî sicil taraması (paket R)

**Kullanıcı ne görür:** Taramalar → "Sicil kayıtları" (`/scans/registry`). Form: kaynak (Companies House / INSEE), isteğe bağlı yer, faaliyet kodları (SIC 2007 / NAF; kafe, restoran, bar… etiketli), gün sayısı (kuruluş penceresi). Çalışma listesi: kaynak, yer, "Kuruluş: 16 Eki 2026 – 15 Kas 2026" penceresi (yerelleştirilmiş), bulunan/yeni sayıları, bitince eşleşme oranı rozeti, hata metni. Sonuç kartı: büyük **eşleşme oranı**, "Toplam X kayıttan Y tanesi eşleşti" özeti, "Yeniden eşleştir", arama kutusu ve iki sekme: "Haritada eşleşti" (haritadaki işletmeyi aç) ve "Sicilde var, haritada eşleşmedi" (Lead olarak ekle / Lead'i aç). Demo kipinde bant ve kayıtlarda "Demo" etiketi. Lead ayrıntısında sicil rozeti. Ayarlar'da iki sicil kartı (açık/kapalı, kodlar, pencere, anahtar ve "Anahtarı dene").

**Nasıl çalışır:**

- Çalışma `registry.fetch` işi olarak işçide yürür; kaynak başına tek etkin çalışma (kısmi tekil indeks). Kayıtlar `(source, external_id)` üzerinden 200'lük partilerle eklenir/güncellenir; eşleşme kararı (elle/ret) yeniden görülmede korunur.
- Eşleştirme (`registry.match`) aday dizinlerini **tek seferde** yükler (ad normalizasyonu, şehir/posta kodu), kayıt başına sorgu yapmaz. Eşleşen kayıt yalnızca `place_id` saklar; Google içeriği sicil tablolarına yazılmaz.
- Eşleşmeyen kayıttan "Lead olarak ekle" `source='registry'` lead oluşturur; ikinci çağrı aynı lead'i döner (409 `REGISTRY_ALREADY_LEAD`), haritada eşleşmiş kayıtta 409 `REGISTRY_MATCHED`.
- HTTP katmanı: hedef ana makineler kodda sabittir, `redirect: "error"`, gövde bayt sınırıyla okunur, 429'da `Retry-After` (en çok 60 sn).
- **Arama üst sayaçları değiştirmez** (Bölüm 6.1): eşleşme oranı, özet ve "Yeniden eşleştir" kapsamın tamamına bakar; aramada ayrıca "Bu aramada: n kayıt" gösterilir; sekme sayaçları ve liste aramaya uyar. Arama 300 ms gecikmeyle gider ve önceki liste yeni yanıt gelene dek kalır.
- **Boş durumlar doğru:** hiç kayıt yokken "Henüz sicil kaydı yok", sonuçsuz aramada "Bu aramada sonuç yok", yalnızca kayıt varken ve arama yokken sekmenin kendi metni ("hepsi eşleşti"). API hatası boş durum gibi görünmez; "Yeniden dene" düğmeli hata kartı çıkar.

**Demo / anahtar:** Demo kipinde (`places.provider = mock`) anahtarsız, ağsız demo sağlayıcı (aynı Londra kafe taramasıyla eşleşecek yapay kayıtlar). Canlıda ilgili ayar açık + anahtar (gizli depo, `getSecret`) gerekir; yoksa 400 `REGISTRY_DISABLED` / `REGISTRY_KEY_MISSING`.

Ana dosyalar: `src/lib/registry/{service,match,companies-house,insee,demo,http,jobs,codes}.ts`, `src/features/registry/registry-page.tsx`, `src/lib/client/registry.ts`.

### 2.2 CSV/XLSX içe aktarma (paket I)

**Kullanıcı ne görür:** İşletmeler → "İçe aktar". Dosya seçimi (`.csv` veya `.xlsx`, en çok 5 MB ve 5.000 satır), ilk 20 satırın önizlemesi, sütun eşleme (önerilen eşleme hazır gelir), varsayılan ülke ve kategori, kaynak notu ve kullanım onayı kutusu, "Kuru deneme" sayıları (oluşacak, kopya, geçersiz; satır numaralarıyla nedenler). Geçmiş içe aktarmalar listesi: "Geri al" (partinin lead'lerini arşivler) ve "Geri getir".

**Nasıl çalışır:**

- Ayrıştırma bellekte ve sınırlıdır: uzantı **ve** dosya imzası denetlenir; XLSX kendi küçük zip okuyucumuzla (`node:zlib`) okunur, sıkıştırma bombasına karşı açılmış boyut sınırı vardır.
- Kopya denetimi (`loadExistingKeys`) dosyadaki adaylarla sınırlı sabit sayıda sorgudur: ad+şehir+ülke, alan adı (tarama `site_domain`'i ve kullanıcı siteleri) ve e-posta. Paylaşımlı platform siteleri (sosyal ağ sayfaları) işletmeyi tanımlamadığı için yalnızca sunucu + yol anahtarıyla karşılaştırılır. Kullanıcı sitelerinin denetimi **doğrusaldır** (Bölüm 6.1, hunt-n-plus-one).
- İçe aktarılan lead `source='import'`, `leads.website` alanını taşır; e-posta araması bu siteyi kullanır. Parti ↔ lead bağı ayrı tablodadır (`import_batch_leads`); geri alma yalnızca bu partinin "Geri al" ile arşivlenmiş lead'lerini geri getirir ve etkin kampanyadakileri arşivlemez.

### 2.3 Claude ile kişisel giriş (paket A)

**Kullanıcı ne görür:** Ayarlar → "Yapay zekâ ile kişisel giriş": aç/kapa (açarken maliyet notu penceresi), model (Opus 5.5 önerilen, Haiku 5.5 çok daha ucuz) ve giriş başına tahmini maliyet, gizlilik notu, Claude anahtarı + "Anahtarı dene", bu ayki kullanım (istek, "kullanılan metin birimi (gönderilen / üretilen)", tahmini maliyet). Lead ayrıntısında "Kişisel giriş" paneli: dil, "Oluştur" / "Yeniden oluştur", yerinde düzenlenebilir metin, "Onayla", "Değişikliği kaydet", "Reddet", durum rozeti (Onay bekliyor / Onaylandı / Reddedildi), model adı ve tahmini maliyet. "Onaylamadığınız hiçbir metin gönderilmez."

**Nasıl çalışır:**

- `{{kisisel_giris}}` **yalnızca onaylanmış** metinle dolar; lead ve dil başına tek onaylı giriş (kısmi tekil indeks); yeni bir taslak onaylanınca eskisi reddedilene iner. Yalnızca taslak varken ön izleme "[onay bekliyor: kisisel_giris]" der; kampanyada o işletmeye ileti ertelenir (`intro_pending`), yedek metin varsa yedek kullanılır.
- **Onaydan sonra "Yeniden oluştur"** (Bölüm 6.1): panel en yeni taslağı gösterir ve üstünde "E-postalarda şu an onaylı metin kullanılıyor: “…”" notu durur; taslak onaylanınca eskisinin yerine geçer.
- İstem yalnızca bizim verimizi (görünen ad, şehir, kategori etiketi, dil) ve işletmenin **kendi** ana sayfasından en çok 3.000 karakter görünür metni içerir (güvenli istemci + robots.txt; e-posta/telefon benzeri dizgiler silinir; satır içi stille gizlenmiş öğeler atılır). Google önbellek alanları istemde yoktur (gözcü dizgiyle testli).
- Çıktı doğrulayıcısı üretimde ve elle düzenlemede aynıdır: 1–2 cümle, 20–300 karakter; bağlantı, e-posta, telefon, `{{ }}`, HTML, dört basamaklı sayı veya yüzde yok. Görünmez biçim ve denetim karakterleri (sıfır genişlikli boşluk, yön işaretleri) kurallardan **önce** silinir.
- Claude istemcisi ham `fetch` (yeni bağımlılık yok): `anthropic-version: 2026-10-21`, `output_config.effort: "low"`, Opus 5.5'te sunucu tarafı yedek (`fallbacks`), önce `stop_reason` denetimi. `redirect: "error"` ve gövde sınırı (256 KB). Faturalanmış başarısız yanıtlar da kullanıma ve hız sınırına sayılır (lead başına saatte 5, canlıda toplam saatte 60).
- **Maliyet onayı modele bağlıdır ve sunucuda damgalanır** (Bölüm 6.1): onay zamanı sunucu saatiyle ve kaydedilen modelle yazılır; daha pahalı modele geçiş veya onay modeli bilinmeyen eski kayıt canlı üretimde 409 `AI_COST_ACK_REQUIRED` verir. Kart bu durumda "Yeniden onayla" bandı gösterir.

**Demo / anahtar:** Demo kipinde ağsız, ücretsiz, belirlenimci kalıp cümleler (`model = demo`); anahtar gerekmez, "Anahtarı dene" ağa çıkmaz. Canlıda anahtar yoksa 400 `AI_KEY_MISSING`.

### 2.4 Harici e-posta bulma: Hunter veya Snov (paket A)

**Kullanıcı ne görür:** Ayarlar → harici e-posta kartında servis seçimi (Hunter.io / Snov.io), anahtar(lar), "Anahtarı dene ve kotayı göster". "E-posta bul" penceresinde "Bulunamayanlar için harici servisi (**seçili servis**) de kullan" seçeneği (Bölüm 6.1: önceden hep "Hunter" yazıyordu).

**Nasıl çalışır:** Yalnızca yerel taramada adres bulunamayan işletmeler için ve yalnızca alan adı gönderilir. Bulunan adresler yerel adreslerle aynı doğrulamadan (sözdizimi + MX) ve engel listesinden geçer. Snov: OAuth istemci kimliği akışı (belirteç bellekte önbelleklenir), arama başlat → yokla. İki istemci de `redirect: "error"` ve 512 KB gövde sınırıyla çalışır (özel `X-API-KEY` başlığı yönlendirmede başka ana makineye taşınmaz). Demo kipinde ağsız demo sağlayıcı.

### 2.5 Şablon dilleri, kategori varyantları, A/B konu (paket T)

**Kullanıcı ne görür:** Şablonlar listesinde DE, FR, ES, IT, NL, PT, PL hazır şablonları; DE şablonları "yalnızca bilgi amaçlı" rozetli. Şablon düzenleyicisinde **"Kategori (varyant)"** seçimi (ilk e-posta şablonunda; "Genel (tüm kategoriler)" = varyant yok), "Konu B (A/B denemesi, isteğe bağlı)" alanı ve ön izlemede A/B seçici. Kampanya sihirbazında adım başına "kategoriye özel şablon" önerileri; kampanya ayrıntısında A/B tablosu (gönderilen, yanıt).

**Nasıl çalışır:**

- Hazır şablonlar tohum sürümüyle yalnızca eksikse eklenir. DE (`info_only`) gönderimde, kampanya adımında ve kendine testte reddedilir (bayrak ve dil, ikisi birden denetlenir).
- Varyant: `campaign_step_templates (campaign, step, language, category_key)`; gönderimde lead'in dili ve kategorisi için varyant varsa o, yoksa adımın genel şablonu kullanılır. Varyant artık kullanıcı tarafından **her dil × kategori** için oluşturulabilir (Bölüm 6.1).
- A/B ataması belirlenimci ve dengelidir (kampanya alıcısı numarası çift → A, tek → B); yeniden deneme aynı varyantı verir. Takipte konu devamı ("Re:") varyanttan bağımsızdır.
- Ön izleme işaretleri ("[eksik: x]", "[onay bekliyor: x]") **arayüz dilindedir** ("[missing: x]", "[awaiting approval: x]"); gönderimde işaret üretilmez.

### 2.6 Açılma izleme (paket T)

**Kullanıcı ne görür:** Ayarlar → "Açılma izleme" (varsayılan kapalı; açmak "açılma verisi kesin değildir" notunun onayını ister). Kampanya ayrıntısında açılma sütunu ve "n / m ileti açıldı" özeti.

**Nasıl çalışır:** Bu sürümde **yalnızca demo**: piksel yalnızca demo iletisine eklenir; canlı iletiye eklenmez (genel erişilebilir aktarıcı ucu ve çekme işi gelene dek). Belirteç `o1.<alıcı>.<adım>.<HMAC>`; içinde adres yok. Yerel `GET /api/t/o/{token}` her durumda aynı 43 baytlık GIF'i döner (geçerlilik dışarıdan anlaşılmaz); açılma yalnızca ayar açık ve HMAC geçerliyse yazılır, ileti başına sayaç 10.000'de durur.

## 3. API uçları (Faz 5)

Bütün değiştiren uçlar ara katmanda aynı-köken denetiminden geçer, gövdeyi zod `.strict()` ile doğrular (400 `VALIDATION` / `BAD_JSON` / `INVALID_ID`) ve denetim kaydı yazar. Her hata yanıtı `{error, code, …}` biçimindedir; her kodun TR ve EN `apiError` metni vardır (`tests/api-error-text.test.ts`).

### 3.1 Yeni uçlar

| Yöntem ve yol | Gövde / sorgu | Başarılı yanıt | Hata kodları |
|---|---|---|---|
| `GET /api/registry/runs` | `?limit=1..50` | 200 `{runs, matchActive}` | — |
| `POST /api/registry/runs` | `{source: companies_house\|insee, locality?, codes?, windowDays?}` | 202 `{run, jobId}` | 403 `SETUP_REQUIRED`; 400 `REGISTRY_DISABLED`, `REGISTRY_KEY_MISSING`, `REGISTRY_SCHEME_UNAVAILABLE`, `VALIDATION`; 409 `REGISTRY_RUN_ACTIVE` |
| `GET /api/registry/runs/{id}` | — | 200 `{run}` | 404 `NOT_FOUND` |
| `GET /api/registry/companies` | `?match=matched\|unmatched,pending&runId=&leadId=&q=&cursor=&limit=1..100` | 200 `{items, nextCursor, stats, searchStats}` (anahtar kümesi sayfalama; `stats` aramadan bağımsız, `searchStats` yalnızca `q` varken) | 400 `VALIDATION` (geçersiz imleç) |
| `POST /api/registry/companies/{id}/lead` | `{}` | 201 `{leadId}` | 404; 409 `REGISTRY_ALREADY_LEAD`, `REGISTRY_MATCHED` |
| `POST /api/registry/match` | `{runId?}` | 202 `{jobId}` | 409 `REGISTRY_MATCH_ACTIVE` |
| `POST /api/registry/test` | `{source}` | 200 `{ok: true, demo}` | 400 `REGISTRY_KEY_MISSING`, `REGISTRY_AUTH`; 429 `REGISTRY_RATE`; 502 `REGISTRY_UPSTREAM` |
| `POST /api/imports/preview` | `multipart/form-data` `file` | 200 `{format, headers, sampleRows, totalRows, suggestedMapping, warnings}` (hiçbir şey yazılmaz) | 413 `IMPORT_TOO_LARGE`; 415 `IMPORT_UNSUPPORTED`; 422 `IMPORT_PARSE`, `IMPORT_EMPTY`, `IMPORT_TOO_MANY_ROWS` |
| `GET /api/imports` | `?limit=1..50` | 200 `{batches}` | — |
| `POST /api/imports` | `file` + `meta` JSON `{mapping, defaultCountry?, categoryKey?, sourceNote, usageAck: true, dryRun?}` | `dryRun` 200, gerçek 201 `{batch, created, duplicates[], invalid[], duplicateCount, invalidCount, truncated}` | 403 `SETUP_REQUIRED`; 400 `IMPORT_ACK_REQUIRED`, `IMPORT_MAPPING`, `VALIDATION`; önizlemenin dosya hataları |
| `POST /api/imports/{id}/archive` | — | 200 `{batch, changed, skippedActive, skippedDuplicate: 0}` (idempotent) | 404 |
| `POST /api/imports/{id}/restore` | — | 200 `{batch, changed, skippedActive: 0, skippedDuplicate}` (idempotent) | 404 |
| `GET /api/leads/{id}/intro` | — | 200 `{intros}` (son 20, yeniden eskiye) | 404 |
| `POST /api/leads/{id}/intro` | `{language?: tr\|en\|de\|fr\|es\|it\|nl\|pt\|pl}` | 201 `{intro}` (taslak) | 403 `SETUP_REQUIRED`; 400 `AI_DISABLED`, `AI_KEY_MISSING`, `AI_AUTH`; 409 `AI_COST_ACK_REQUIRED`; 422 `AI_NO_CONTEXT`, `AI_REFUSED`, `AI_OUTPUT_INVALID`; 429 `RATE_LIMITED`, `AI_RATE_LIMITED`; 502 `AI_UPSTREAM`, `AI_TRUNCATED` |
| `PATCH /api/leads/{id}/intro/{introId}` | `{action: approve\|reject\|save, text? ≤ 300}` | 200 `{intro}` | 400 `INTRO_TEXT_INVALID`; 404; 409 `CONFLICT` |
| `POST /api/ai/test` | `{}` | 200 `{ok, model, demo}` (demo ağa çıkmaz; canlı `GET /v1/models/{model}`, belirteç harcamaz) | 400 `AI_KEY_MISSING`, `AI_AUTH`; 429; 502 |
| `GET /api/ai/usage` | — | 200 `{month, requests, inputTokens, outputTokens, estUsd}` (UTC ayı) | — |
| `GET /api/campaigns/{id}/stats` | — | 200 A/B ve açılma özeti `{ab, opens}` (kişisel veri yok) | 404 |
| `GET /api/t/o/{token}` | — | Her durumda 200, 43 baytlık GIF, `no-store` | — (bilinçli olarak yok) |
| `POST /api/schedules/rearm` | — | 200 `{armed: true}` (idempotent) | — |

### 3.2 Değişen uçlar (geriye uyumlu eklemeler)

| Uç | Değişiklik |
|---|---|
| `GET /api/settings` | yeni ayarlar `registry.companiesHouse`, `registry.insee`, `ai.intro`, `tracking.opens`; maskeli gizli durumlar `companiesHouseKey`, `inseeKey`, `anthropicKey`, `snovClientId`, `snovClientSecret` |
| `PUT /api/settings` | `ai.intro` maliyet onayı **sunucuda damgalanır** (`costAckAt` sunucu saati, `costAckModel` kaydedilen model; istemci değeri yalnızca "yeni onay" işareti). Onaysız açma 400; `tracking.opens` onay anı (`ackAt`) da **sunucuda damgalanır** (Faz 6: kapalı → açık geçişte sunucu saati; açıkken/kapatırken saklanan değer korunur; istemci `{ enabled }` gönderir, açıkça `ackAt: null` ile açma 400) |
| `POST /api/enrichment/external/test` | `{provider?: hunter\|snov}`; hatalar `EXTERNAL_AUTH` 400, `EXTERNAL_QUOTA`/`EXTERNAL_RATE` 429, `EXTERNAL_NETWORK`/`UPSTREAM` 502 |
| `GET /api/enrichment`, `POST /api/leads/find-emails` | `external.provider` (seçili servis); arama içe aktarılan lead'in `website` alanını da kullanır |
| `POST /api/templates/preview`, şablon oluştur/güncelle | `subjectB`, `categoryKey`, `variant: a\|b`; yanıtta `introPending`; ön izleme işaretleri arayüz dilinde |
| `GET /api/scans`, `POST /api/scans/{id}/control`, `run-now` | Bölüm 2.0'daki duraklatma kodları ve `NEEDS_ACK` tutarları |
| `GET /api/status` | `schedules.tickArmed`, `schedules.stalled` |

## 4. Veri modeli: migrasyon `0005_faz5` ve geri alma

**`drizzle/0005_faz5.sql`** tek, elle düzenlenmiş ve **yalnızca ekleyen** bir migrasyondur (0003/0004 emsali): `drizzle-kit`'in ürettiği tablo yeniden kurmaları kullanılmaz; mevcut tablolar yalnızca `ALTER TABLE … ADD` ile sütun alır (CHECK satır içi), yeni tablo ve indeksler `IF NOT EXISTS` ile kurulur. Hiçbir satır yeniden yazılmaz, silinmez veya taşınmaz.

- **Yeni tablolar:** `registry_runs` (kaynak başına tek etkin çalışma: kısmi tekil `registry_runs_active_uq`; pencere tarihleri `date()` ile denetlenir; `failed` ⇒ hata kodu), `registry_companies` (`(source, external_id)` tekil; eşleşme durumu CHECK; `matched_place_id` yalnızca `matched/manual` iken; yer silinince `SET NULL`), `import_batches` ve `import_batch_leads` (geri alma `leads`'i yeniden kurmaz), `lead_intros` (lead × dil başına tek onaylı: kısmi tekil `lead_intros_approved_uq`), `campaign_step_templates` (bileşik FK, adımla birlikte silinir), `message_opens`.
- **Yeni sütunlar:** `leads.website` (4–300), `templates.subject_b`, `templates.info_only`, `messages.subject_variant`.
- **Yeni ayar anahtarları** (tablo değişikliği yok): `registry.companiesHouse`, `registry.insee`, `ai.intro`, `tracking.opens`. **Yeni gizli adlar:** `registry.companiesHouseKey`, `registry.inseeKey`, `anthropic.apiKey`, `snov.clientId`, `snov.clientSecret` (yalnızca gizli depoda; API maskeli durum döner).
- Google içeriği (ad, adres, site, telefon) bu tablolara yazılmaz; sicil eşleşmesi yalnızca `place_id` saklar.

**Geri alma: `scripts/rollback-0005.ts`** (kütüphane `src/lib/db/rollback-0005.ts`; uygulamanın normal yolu bu modülü içe aktarmaz). 0003/0004 ile aynı iki aşamalı güvenlik:

1. Plan (varsayılan, hiçbir şey değiştirmez): `npx tsx scripts/rollback-0005.ts --db <dosya>` — hedef yalnızca `--db` (ortam değişkenleri ve varsayılan veri yolu kullanılmaz); silinecek Faz 5 verisinin sayıları ve tek kullanımlık doğrulama kodu yazılır.
2. Uygulama (uygulamanın **bütün** süreçleri kapalıyken): `--confirm <KOD>`; Faz 5 verisi varsa `--accept-data-loss`; hedef geçici dizinde değilse ayrıca `--allow-live-data --type-db-name <dosya-adı>`.

Geri alma **kayıplıdır**: sicil kayıtları, içe aktarma partileri, yapay zekâ girişleri, kategori şablon bağları, açılmalar ve yeni sütunlar (lead web siteleri, Konu B…) silinir; içe aktarma/sicil **lead'leri kalır**. Yeni sütunların yalnızca kendi CHECK'leri olduğu için `DROP COLUMN` yeterlidir, tablo yeniden kurulmaz. Önce `backups/pre-rollback-0005-<zaman>.db` yedeği alınır ve doğrulanır; bekçilerden biri düşerse işlemin tamamı geri alınır. Testler: `tests/migration-0005.test.ts`.

## 5. Kararlar ve yol haritasından sapmalar

- **SDK yok:** Claude, Hunter, Snov, Companies House ve INSEE istemcileri ham `fetch` ile yazıldı (yeni npm bağımlılığı eklenmedi). XLSX kendi zip okuyucumuzla okunur.
- **Açılma izleme yalnızca demo:** canlı iletiye piksel eklemek genel erişilebilir bir uç ister (Faz 3'teki çıkış aktarıcısı gibi); bu sürümde yapılmadı.
- **NAF 2025** şeması ayarda seçilebilir ama INSEE karşılık tablosu yayımlanana dek API tarafında reddedilir (`REGISTRY_SCHEME_UNAVAILABLE`).
- **Kategori varyantı** başlangıçta yalnızca hazır şablonlarla geliyordu; son inceleme turunda düzenleyiciye eklendi (yol haritası maddesi kullanıcıya açık hâle geldi).

## 6. Testler

Strateji (engineering:testing-strategy): saf kurallar birim testinde, uçlar geçici SQLite veritabanıyla rota işleyicisi üzerinden, dış servisler **sahte `fetch`** ve yapay fikstürle, kullanıcı akışları üretim derlemesi üzerinde Playwright ile. Kabul ölçütü ayrı bir uçtan uca birim testiyle (Bölüm 7).

| Katman | Ne sınanır | Örnek dosyalar |
|---|---|---|
| Birim (saf) | Doğrulayıcılar, eşleştirme puanı, ayrıştırıcılar, A/B ataması, maliyet tahmini, ön izleme işaretleri, istemci seçicileri (`currentIntro`, `emptyListKind`, `savePatch`) | `ai-intro`, `registry-match`, `import-parsers`, `import-rules`, `ab-variants`, `pricing`, `registry-ui-model`, `faz5-review-fixes` |
| İstemci sözleşmesi (sahte HTTP) | Claude, Hunter, Snov, Companies House, INSEE: başlıklar, gövde, hata eşlemesi, `redirect: "error"`, gövde sınırı | `ai-claude`, `external-snov`, `registry-clients`, `email-api`, `faz5-review-fixes` |
| Servis + veritabanı | Rotalar, işlemler, kısıtlar, idempotentlik, hız sınırı, damgalanan onay, migrasyon ve geri alma | `ai-intro-api`, `registry-api`, `import-api`, `templates-faz5`, `category-variants`, `open-tracking`, `migration-0005`, `faz5-p0` |
| Kabul | Paketler arası dikişler ve sicil eşleşme oranı | `faz5-acceptance`, `registry-acceptance` |
| Uçtan uca (Playwright) | Ayarlar → üret → düzenle → onayla → **yeniden oluştur → yeni taslağı onayla**; sicil çalışması, arama ve boş durum; içe aktarma; Konu B, **kategori varyantı seçimi**, sihirbaz, demo gönderim | `e2e/faz5-ai`, `e2e/registry`, `e2e/faz5-import`, `e2e/faz5-templates` |

**Son sayılar (15 Kasım 2026, üretim derlemesi):** Vitest **152 dosya, 2641 geçti, 1 atlandı**; kapsam **deyim 95,73 / dal 88,8 / fonksiyon 96,8 / satır 97,38** (eşikler 80/80/80/70). Playwright **105 geçti**, 0 başarısız / 0 kararsız (tümleştirmede iki tam çalıştırma, son düzeltmelerden sonra bir tam çalıştırma).

### 6.1 Son inceleme turu

| Önem | Bulgu | Sonuç |
|---|---|---|
| P1 | Onaydan sonra "Yeniden oluştur" yeni taslağı üretiyor ama panel hep eski onaylı metni gösteriyordu; yeni taslak okunamıyor/onaylanamıyor, canlıda her tıklama yine ücretleniyordu | **Düzeltildi:** panel onaylı ve taslaklardan en yenisini (kimliğe göre) gösterir; hâlâ kullanılan onaylı metin ayrı notta. Test: `faz5-review-fixes`, `ai-intro-api` (API üzerinden), `e2e/faz5-ai` (onayla → yeniden oluştur → onayla) |
| P2 | Maliyet onayı istemciden geliyordu; `costAckModel` boşken sunucu model denetimini atlıyordu | **Düzeltildi:** sunucu `costAckAt`'i kendi saatiyle ve `costAckModel`'i kaydedilen modelle damgalar; aynı işaret önceki onayı korur; onay modeli yoksa canlı üretim yeniden onay ister, kartta "Yeniden onayla" bandı. Şemada alan zorunlu yapılmadı (eski kayıt okunamaz hâle gelip yapay zekâ sessizce kapanmasın diye; kapı aynı sonucu verir). Test: `faz5-review-fixes`, `faz5-p0`, `ai-intro` |
| P2 | Claude/Hunter/Snov yönlendirme izliyor ve gövdeyi sınırsız okuyordu | **Düzeltildi:** üçü de `redirect: "error"`; gövde ortak `readJsonCapped` ile (Claude 256 KB, Hunter/Snov 512 KB); sicil `readCapped` aynı katmana taşındı. Test: `faz5-review-fixes` |
| P2 | Giriş doğrulayıcısı sıfır genişlikli/yön karakterleriyle atlatılabiliyordu | **Düzeltildi:** `\p{Cf}` ve `\p{Cc}` kurallardan önce silinir. Test: `faz5-review-fixes` |
| P2 | Satır içi stille gizlenmiş site metni istemde yer alıyordu | **Düzeltildi:** `display:none`, `visibility:hidden`, `font-size:0`, `opacity:0`, ekran dışı konum ve `clip:rect(0…)` öğeleri atılır (stil sayfasıyla gizleme kapsam dışı; sistem talimatı, doğrulayıcı ve insan onayı ayrıca korur). Test: `faz5-review-fixes` |
| P2 | Sicil: API hatası boş durum gibi görünüyordu; "hepsi eşleşti" ilk ziyarette ve sonuçsuz aramada da yazıyordu; giriş paneli yükleme hatasında kayboluyordu | **Düzeltildi:** hata kartı ("Yeniden dene"); boş metin `emptyListKind` ile seçilir. Test: `faz5-review-fixes`, `e2e/registry` |
| P2 | Sicil arama kutusu her tuşta iki sorgu başlatıyor, eşleşme oranı ve "Yeniden eşleştir" aramayı izliyordu | **Düzeltildi:** 300 ms gecikme + önceki veri korunur; üst sayaçlar kapsamdan, ayrı `searchStats` aramadan. Test: `faz5-review-fixes`, `e2e/registry` |
| P2 | Kategori varyantı arayüzden oluşturulamıyordu | **Düzeltildi:** düzenleyicide "Kategori (varyant)" seçimi (ilk e-posta), oluşturma/güncelleme/ön izlemede gönderilir; takibe geçişte kaldırılır. Test: `faz5-review-fixes`, `e2e/faz5-templates` |
| P2 | "E-posta bul" penceresi Snov seçiliyken de "Hunter" diyordu | **Düzeltildi:** seçili servis adı yazılır (yeni anahtar `findEmails.useExternalProvider`; `tr/base.ts` dondurulmuş olduğu için eski anahtar değiştirilmedi) |
| P2 | Teknik/karışık metinler: "Belirteç (giriş / çıkış)", ham model kimliği, `kisisel_giris` yardımı | **Düzeltildi:** "Kullanılan metin birimi (gönderilen / üretilen)", "Claude Opus 5.5 · tahmini $…", "Şablondaki {{kisisel_giris}} alanına girecek cümle…" (TR + EN) |
| P2 | Sicil tarihleri ham `YYYY-AA-GG` | **Düzeltildi:** `fmtIsoDay` (UTC'de biçimlenir; saat dilimi günü kaydırmaz). Test: `faz5-review-fixes`, `registry-ui-model` |
| P2 | Ön izleme işareti İngilizce arayüzde de Türkçeydi | **Düzeltildi:** işaret `ui.language` ayarına göre ("[missing: x]", "[awaiting approval: x]"). Test: `ai-intro-api`, `faz5-review-fixes` |
| P2 | İçe aktarma kopya denetimi her içe aktarma lead'ini dosyadaki her alan adıyla `instr` ile karşılaştırıyordu (O(lead × dosya), yazma işlemi içinde) | **Düzeltildi (doğrusal):** siteler tek okumayla gelir, anahtar bellekte bir kez hesaplanıp `Set`'te aranır: O(lead + dosya). Saklanan `website_key` sütunu + indeks yeni migrasyon gerektirdiği için ertelendi (Bölüm 9). Test: `faz5-review-fixes`, `import-api` |

## 7. Kabul ölçütü ve kanıtı

> "Son 30 günde kurulmuş UK kafe şirketleri listelenir; en az %30'u Google kayıtlarıyla eşleşir."

- **`tests/registry-acceptance.test.ts` (1):** sahte Companies House sunucusu 20 yapay kafe şirketi döner. Test, istemcinin pencereyi **bugün − 30 … bugün** olarak sorduğunu, 20 kaydın listelendiğini, 8'inin (%40) haritadaki yerlerle eşleştiğini ve tuzak kayıtların (benzer ad, başka şehir) **eşleşmediğini** (sıfır yanlış pozitif) doğrular.
- **`tests/registry-acceptance.test.ts` (2):** gerçek tarama yolu: demo Londra kafe taraması önbelleği doldurur, demo sicil çalışması aynı yolla eşleştirilir; oran ≥ %30.
- **`tests/faz5-acceptance.test.ts`:** paketler arası dikişler: içe aktarılan ve sicilden eklenen lead'ler Keşif'te görünür; içe aktarılan siteden e-posta bulunur (harici servis açıkken de); kişisel giriş yalnızca onaydan sonra `{{kisisel_giris}}` olur (taslakta ön izleme "onay bekliyor", gönderim ertelenir); dil şablonlu kafe varyantı ve A/B konusuyla demo gönderim yapılır.
- **`e2e/registry.spec.ts`:** arayüzde BK demo çalışması, oran ≥ %30, eşleşmeyen kaydın lead olması ve Keşif'te kaynakla süzülmesi.

Gerçek Companies House verisinde oran demodan düşük olabilir (Bölüm 10: kayıtlı ofis adresi çoğu zaman muhasebecinin adresidir).

## 8. Uygulanan beceriler (Skills applied)

| Beceri | Nerede, nasıl |
|---|---|
| **backend-design** (think-before-coding, error-handling-as-design, security-discipline, idempotency) | Maliyet onayı istemci beyanı yerine sunucu olgusu oldu (`stampAiIntroAck`, `src/app/api/settings/route.ts`); kapı "bilinmeyen onay modeli"ni güvenli tarafta reddeder. Dış istemcilerde hata yolu tasarımın parçası: yönlendirme → ağ hatası kodu, büyük gövde → `AI_UPSTREAM` / `bad_response`, anahtar hiçbir iletide yok (`src/lib/http/capped.ts`). Güvenilmeyen girdi (model çıktısı, site metni) kurallardan önce sadeleştirilir. Yeniden oluştur/onayla akışı idempotent ve tek onaylı satır kısıtına dayanır. |
| **hunt-n-plus-one** (query-discipline) | İçe aktarmadaki ilişkili `EXISTS (json_each … instr)` alt sorgusu N+1 değil ama **karesel**di (20 bin lead × 5 bin satır ≈ 100 milyon `instr`, yazma kilidi içinde); doğrusal okuma + `Set` araması oldu. Sicil sayaçları tek gruplu sorgu (`companyStats`), arama varken yalnızca ikinci bir gruplu sorgu; liste `LEFT JOIN` ile satır başına sorgusuz. Faz 5'in diğer yeni yolları (sicil ekleme, eşleştirme, kampanya ekleme/ön denetim, istatistik, içe aktarma geçmişi) toplu/gruplu olarak doğrulandı. |
| **design** (ux-copy, design-system, accessibility) | Teknik jargon sade dile çevrildi; boş durumlar gerçeği söyler (ilk ziyaret / sonuçsuz arama / hepsi eşleşti ayrı); hata durumları ortak `LoadError` kartıyla; yeni bant ve notlar tema belirteçleriyle (`bg-warning/10`, `bg-muted`), sabit renk yok; yeni seçim `Label`/`aria-describedby` bağlı; durum notları `role="status"`. |
| **engineering:testing-strategy** | Her bulgu için en ucuz yeterli katman: saf kurallar birimde (`faz5-review-fixes`), damgalanan onay ve aramadan bağımsız sayaçlar gerçek rota + geçici veritabanıyla, kullanıcıya görünen akışlar (yeniden oluştur → onayla, arama boş durumu, varyant seçimi) Playwright'ta. Dış servisler yalnızca sahte `fetch`; regresyon testleri bulgu senaryosunu birebir kurar. |

## 9. Bilinen sınırlar ve açık kalanlar (kod)

- **İçe aktarma kopya denetimi** doğrusal ama her içe aktarmada bütün içe aktarma/sicil lead sitelerini okur. Çok büyük listelerde (yüz binler) saklanan `website_key` sütunu + indeks (yeni migrasyon `0006`) ve `IN (…)` parça sorgusu önerilir.
- **Gizli site metni:** yalnızca satır içi stille gizlenenler atılır; stil sayfası sınıfıyla gizlenen metin istemde kalabilir (güvenilmeyen veri talimatı, çıktı doğrulayıcı ve insan onayı korur).
- **Maliyet onayı modeli** eski (Faz 5 öncesi P0) kayıtta yoksa canlı üretim bir kez yeniden onay ister; demo etkilenmez.
- **Sicil:** çalışma sayaçları anlık görüntüdür; lead'e dönüştürülen kayıt sonradan eşleştirilmez; sert kapanış yarım çekmenin deneme hakkını harcar (docs/11 Bölüm 9).
- Açılma izleme canlıda yok (Bölüm 5). Kategori varyantı yalnızca ilk e-posta şablonunda.
- Keşif'te "Yenilik" ve "Yenilikler" süzgeç adları yan yana (Faz 4'ten açık).

## 10. Entegrasyon bekleyenler

Bu liste **ihtiyacı ve nedenini** söyler; hangi hizmet veya ücretli seçeneğin kullanılacağı müşteri kararıdır. Anahtarlar Ayarlar'dan girilir ve yalnızca gizli depoda saklanır ([`10-CANLIYA-GECIS.md`](10-CANLIYA-GECIS.md)).

| Bekleyen | Neden gerekli | Ne doğrulanacak | Sahibi |
|---|---|---|---|
| Companies House API anahtarı | Sicil istemcisi yalnızca yapay fikstür ve demo sağlayıcıyla sınandı. Arama sonucu **kayıtlı ofis** adresini verir; küçük işletmelerde bu çoğu zaman muhasebecinin adresidir | Gerçek alan adları (`registered_office_address`, `sic_codes`, `hits` üst sınırı), `location` süzgeci, gerçek eşleşme oranı | Geliştirici + müşteri anahtarı |
| INSEE Sirene API anahtarı | Fikstürle sınandı; Paris/Lyon/Marseille belediye bölgesi etiketi ("PARIS 8") eşleştirmede şehre indirilir, ama yer süzgecinin bölgeli kayıtları bulup bulmadığı doğrulanmadı | Gerçek alan adları, belediye etiketi, yer süzgecinin sonuç sayısı; NAF 2025 tablosu yayımlanınca şema | Geliştirici + müşteri anahtarı |
| Anthropic (Claude) API anahtarı | Canlı istemci sahte HTTP ile sınandı (başlıklar, `effort`, yedek model, `stop_reason`, faturalanmış hatalar) | Gerçek yanıt biçimi, red/yedek davranışı, giriş başına gerçek maliyet ve kalite; dillerde doğrulayıcı uyumu | Müşteri anahtarı |
| Hunter API anahtarı | Sahte HTTP ile sınandı | Kota alanları, 403/429 ayrımı, gerçek güven puanları | Müşteri anahtarı |
| Snov istemci kimliği + sırrı | Belirteç ucunun form gövdesini kabul ettiği varsayıldı (yayımlanmış örneklerle uyumlu); sahte HTTP ile sınandı | Belirteç ucu, arama başlat/yokla süreleri, bakiye → kota eşlemesi | Müşteri anahtarı |
| Açılma izleme için genel erişilebilir uç | Canlı iletiye piksel eklenmesi aktarıcı ucu + çekme işi ister | Uç, gizlilik notu metni, hukuki değerlendirme | Müşteri (barındırma) + hukuk |
| **Faz 4'ten açık:** Müşterinin Gmail hesabına erişim | Canlı gönderim ve aynı konuşmada takip yalnızca sahte Gmail sunucusuyla sınandı | `threadId`, `In-Reply-To`/`References`, "Re:" konusu; gönderim/okuma izinleri | Müşteri |
| **Faz 4'ten açık:** Çıkış aktarıcısının dağıtımı — **önerilen** Cloudflare Worker + D1 (`*.workers.dev`, sunucu/DNS gerekmez; `deploy/cloudflare-worker/README.md`), isteğe bağlı VPS | HTTPS tek tıklamalı çıkış ucu olmadan canlı gönderim yapılmaz | Worker dağıtımı (D1 şeması, `RELAY_KEYS`), `/healthz`, uçtan uca doğrulama, düzenli çekme | Müşteri (Cloudflare hesabı) |
| **Faz 4'ten açık:** Google Cloud anahtarı, faturalandırma ve koyu vektör Map ID | Gerçek Places çağrıları, açılış izlemesi, yer kimliği yenilemesi ve koyu harita yalnızca demo ile sınandı | Maliyet tahmini ve ön onay, `NOT_FOUND`, kimlik değişimi, harita stilleri | Müşteri |
| **Faz 4'ten açık:** Canlı RDAP denemesi | Yalnızca sahte sunucu ve demo | Önyükleme, geri çekilme, birikimin erimesi | Geliştirici |
| **Faz 4'ten açık:** Türetilmiş bayrak saklama süresi için hukuki görüş | `google.derivedFlagsDays` varsayılanı süresiz | Süre kararı | Hukuk / müşteri |
| **Faz 4'ten açık:** TB-11 (a) ve (b) sahip kararları, Microsoft 365 kararı | Davranış/kapsam kararları | Karar verilirse kural ve test | Sahip / müşteri |
| **Faz 4'ten açık:** Paketlenmiş, imzalı uygulamada OS bildirimleri; ekran okuyucu testi | Yalnızca geliştirme yapısında ve otomatik testlerle sınandı | macOS/Windows bildirimleri; VoiceOver/NVDA ile yeni Faz 5 ekranları (sicil, içe aktarma, giriş paneli) dahil | Geliştirici + müşteri bilgisayarı |
| **Faz 4'ten açık:** Süreçler arası `SQLITE_BUSY` izlemesi | Süreç içi kuyruk çözüldü; Next sunucusu ↔ işçi çakışması `busy_timeout` ile beklenir | Uzun süre açık uygulamada `DB_BUSY` / `retry step=` günlük satırları | Geliştirici |
