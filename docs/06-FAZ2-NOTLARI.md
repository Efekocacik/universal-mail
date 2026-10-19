# Faz 2 — E-posta Bulma: Uygulama Notları

**Durum (20 Ekim 2026):** Faz 2 `feat/faz-2` dalında kodlandı ve demo sağlayıcıyla uçtan uca doğrulandı. **Gerçek web siteleriyle bulma oranı (kabul ölçütü: 100 kafenin ≥ %40'ı) ve gerçek Hunter anahtarı henüz denenmedi**; bunlar Faz 0 hesapları ve gerçek Google anahtarı gerektirir (Bölüm 6).

## 1. Ne yapıldı

| Kalem | Durum | Not |
|---|---|---|
| Nazik web tarayıcı (`src/lib/email/crawler.ts`) | ✔ | robots.txt, site başına ≤ 6 istek (robots.txt ve yönlendirmeler dahil), istekler arası ≥ 1 sn, `Crawl-delay` (≤ 10 sn), 10 sn zaman aşımı, 1 MB yanıt sınırı, kimlikli User-Agent |
| Aday sayfalar (çok dilli) | ✔ | Ana sayfadaki iletişim/kurumsal bağlantılar puanlanır; yedek yollar sayfa diline göre: `/impressum`, `/kontakt`, `/mentions-legales`, `/contacto`, `/contatti`, `/over-ons`, `/iletisim`… |
| Çıkarma (`extract.ts`) | ✔ | `mailto:`, düz metin, JSON-LD (`email`, `contactPoint`, `sameAs`), Cloudflare e-posta koruması, `[at]`/`(at)`/`AT` yazımı, IDN alan adları; yer tutucu, görsel adı, izleme ve platform adresleri elenir |
| Sosyal bağlantılar ve iletişim formu | ✔ | Instagram, Facebook, LinkedIn, X, TikTok, YouTube profilleri (paylaşım/gönderi bağlantıları atılır) ve mesaj alanlı form sayfası |
| Doğrulama (`verify.ts`) | ✔ | sözdizimi → tek kullanımlık alan adı → bireysel sağlayıcı → MX (örtük A/AAAA ve null-MX dahil). Geçici DNS hatası adresi "doğrulanmadı" bırakır, geçersiz saymaz |
| Sınıflandırma | ✔ | `generic` (info@…), `personal` (kişiye ait), `consumer` (gmail vb.); `email_status`: `found_verified`, `generic`, `found_unverified`, `invalid`, `not_found` |
| Kuyruk, eşzamanlılık, yeniden deneme | ✔ | İş türü `enrich.email` (20 lead/iş); aynı anda ≤ 4 site (ayar: 1–4), aynı sunucuya ardışık; zincir işletmeler tek taramayla; geçici hata 24 saat sonra **en fazla bir kez**; engel (robots/403) ve kalıcı hata (404…) asla otomatik tekrar edilmez |
| Harici servis (Hunter.io, isteğe bağlı) | ✔ | Varsayılan **kapalı**; ayardan açılır + kendi API anahtarı + her aramada onay kutusu. Yalnızca yerelde kullanılabilir adres bulunamayan işletmelerin **alan adı** gönderilir. Kota gösterilir |
| Yinelenen kayıt tespiti | ✔ | Aynı e-posta veya aynı işletme alan adı; lead ayrıntısında listelenir |
| Arayüz | ✔ | Lead ayrıntısında "E-postalar" (kaynak sayfa bağlantısı, tür/doğrulama rozeti, birincil yap, yeniden doğrula, elle ekle/sil), sosyal bağlantılar, yinelenenler, zaman çizelgesi; listede e-posta rozeti, "E-posta" süzgeci, toplu "E-posta bul" (maliyet/onay penceresi), ilerleme; Ayarlar'da "E-posta bulma" |
| Demo modu | ✔ | `.example` siteleri için çevrimdışı sahte web ve DNS (gerçek ağa çıkılmaz); robots engeli, 403, geçici hata, çeşitli adres biçimleri içerir |
| CSV | ✔ | `eposta`, `eposta_durumu`, `eposta_turu`, `eposta_kaynagi`, `tum_epostalar`, `instagram`, `facebook`, `linkedin`, `iletisim_formu` sütunları (bizim veri; Google alanları kapalıyken de gelir) |

**Testler:** 349 birim/entegrasyon testi geçiyor (Faz 1: 188; Faz 2: +161). E2E: demo akışı uçtan uca (ayrıntıdan başlat → Google verisi → site taraması → elle ekle/sil → toplu arama → süzgeç → CSV).

## 2. API uçları (Faz 2)

| Uç | Açıklama |
|---|---|
| `POST /api/leads/find-emails` | `{leadIds \| filtersQuery, loadGoogle?, useExternal?, force?, dryRun?}`. `dryRun` ön izleme: kaç lead taranacak, kaçının Google verisi gerekli, tahmini Google maliyeti, harici servis uygunluğu. En fazla 2.000 lead |
| `GET /api/leads/{id}` | Yanıta `emails`, `contacts`, `enrichment`, `duplicates` eklendi |
| `POST /api/leads/{id}/emails` | Elle ekle (sözdizimi + MX doğrulanır; kaynak `manual`) |
| `PATCH /api/leads/{id}/emails/{emailId}` | `{primary}` sabitle, `{reverify}`, `{verifyStatus: verified\|invalid}` |
| `DELETE /api/leads/{id}/emails/{emailId}` | Sil |
| `GET /api/enrichment` | Sürmekte olan/sıradaki/zamanlanmış işler, durum sayıları, harici servis ayarı |
| `POST /api/enrichment/external/test` | Hunter anahtarını dener, kalan arama hakkını döndürür |
| `GET /api/leads`, `/api/leads/facets`, `/api/leads/points`, `/api/export/leads` | `emailStatus` süzgeci; satırda `emailState`, `primaryEmail`; facet'te `emailStatus` sayıları |
| Ayarlar / gizli bilgiler | `enrichment.external`, `enrichment.concurrency`; gizli bilgi `hunter.apiKey` (AES-256-GCM, Faz 1'deki depo) |

Arka plan: iş türü `enrich.email` (`registerEmailHandlers`), `place.enriched` olayı `findEmails` işaretliyse lead'leri bu işe yönlendirir (`bindEmailEvents`), tamamlanınca `lead.emailsFound` olayı yayılır (Faz 3 kampanya adayları için).

## 3. Veri modeli (yeni migrasyon `0001_faz2_email`, yalnızca yeni tablolar)

- `lead_emails`: `email` (küçük harf, punycode), `domain`, `kind`, `source_url`, `source_type` (mailto/jsonld/cfemail/text/obfuscated/manual/external), `site_match`, `verify_status`/`verify_reason`, `is_primary` (lead başına en fazla bir; kısmi benzersiz dizin), `primary_pinned`.
- `lead_contacts`: `type`, `url`.
- `lead_enrichment` (lead başına tek satır): `status` (queued, running, done, no_website, needs_google, blocked, failed), `email_status`, `attempts`, `next_retry_at`, `last_error`, `pages_fetched`, `external_used`.

## 4. Google verisi saklama kuralıyla ilişki

Web sitesi adresi (`websiteUri`) Google içeriğidir ve **kalıcı saklanmaz** (Faz 1 kararı); tarama bunu yalnızca oturum önbelleğinden okur.

- Önbellekte yoksa (uygulama yeniden açıldı veya hiç zenginleştirilmedi) lead `needs_google` olur ve **ağa çıkılmaz**; "E-posta bul" penceresindeki "Google verisini de yükle" seçeneği önce Place Details (Enterprise) ile adresi alır, sonra taramayı başlatır. Maliyet önceden gösterilir.
- Kalıcı kaydedilenler **bizim verimizdir**: işletmenin kendi sitesinde bulduğumuz e-posta adresleri, sosyal bağlantılar, doğrulama sonuçları ve **bulundukları sayfanın adresi** (`source_url`; "kaynağına tıklayınca sayfa açılsın" kabul ölçütü için gerekli). `source_url` ana sayfa olduğunda bu, web sitesi adresiyle örtüşür; bunu Google'ın içeriğini saklamak değil, kendi taramamızın bulgusunu kaydetmek olarak yorumladık. **Daha katı bir yorum benimserseniz** `source_url` yalnızca sayfa yolu olarak (alan adı olmadan) saklanabilir; bu durumda "kaynağı aç" için Google verisinin yeniden yüklenmesi gerekir. Karar, Google'ın güncel şartları doğrulanırken birlikte verilmeli.
- Harici servise yalnızca **alan adı** gider; Google'ın başka alanı (ad, adres, telefon) gönderilmez.
- 24 saatlik yeniden denemede Google verisi silinmişse (uygulama kapanıp açıldıysa) lead `needs_google` olur; otomatik Google çağrısı (ücret) yapılmaz.

## 5. Kararlar ve SRS'den sapmalar

- **`kind` değerleri:** SRS `personal|generic` der; bireysel sağlayıcı adreslerini (gmail vb.) ayırmak için `consumer` eklendi. Bu adresler kaydedilir ama "bulundu" sayılmaz, harici servis yedeği tetikler ve Faz 3'te B2B gönderimden hariç tutulacaktır.
- **Birincil adres seçimi:** siteyle aynı alan adı > doğrulanmış > **genel rol adresi** > kişiye ait > kaynak güvenilirliği. Genel adres, kişisel veri taşımadığı ve ülke politikalarında (ES/IT yalnızca genel) daha güvenli olduğu için tercih edilir. Kullanıcı başka adresi sabitleyebilir.
- **SMTP denemesi yapılmaz** (roadmap'te "opsiyonel"): IP itibarını bozabilir, birçok sunucu reddeder/geciktirir. Doğrulama sonucu teslimat garantisi değildir; arayüzde "Doğrulandı" yerine nedeni (MX kaydı var…) gösterilir. ZeroBounce/NeverBounce entegrasyonu (SRS "isteğe bağlı") yapılmadı; `verify.ts` bir zincire açıktır.
- **JavaScript ile oluşan siteler** taranmaz (Electron tarayıcısı Faz 2'de eklenmedi); neredeyse boş ana sayfa `js_required` notuyla işaretlenir, böylece "e-posta yok" ile karıştırılmaz.
- **Hunter:** SRS Hunter/Snov/Prospeo der; yalnızca Hunter yazıldı (Domain Search v2: `X-API-KEY` başlığı, güven puanı ≥ 30, en çok 5 adres, kota `/v2/account`). Yanıt biçimi Hunter'ın belgelerinden doğrulandı; **gerçek anahtarla denenmedi**.
- **Tarayıcı güvenliği:** web siteleri güvenilmez girdidir. İç ağ/geri döngü/bağlantı-yerel adreslere bağlanma BAĞLANTI ANINDA engellenir (DNS yeniden bağlama dahil), yalnızca 80/443/8080/8443 portları, kullanıcı bilgili adresler ve başka siteye yönlendirmeler reddedilir; gzip/brotli bombasına karşı açılmış boyut sınırı; metin taraması ve robots.txt eşleştirmesi doğrusal sürelidir (saldırgan sayfa/robots.txt ile CPU tüketilemez; testli).
- **Birden çok iş sırası:** işçi bir seferde tek iş yürütür; uzun bir tarama sürerken e-posta işleri sırada bekler.
- **Tek seferde en fazla 2.000 lead** (Faz 1'deki Google yükleme sınırıyla aynı).

## 6. Kalan işler ve doğrulanmayanlar

1. **Gerçek bulma oranı:** kabul ölçütü (100 Londra kafesinin ≥ %40'ında e-posta, her adresin kaynağı açılır) gerçek Google anahtarı ve gerçek ağ gerektirir. Testlerdeki 25 site örneği **sentetik**dir (yaygın kalıpları taklit eder); gerçek sitelerde kapsam bundan düşük olabilir. Demo modundaki yaklaşık %50'lik oran yalnızca demo verisinin dağılımıdır, gerçek başarı tahmini değildir.
2. **Hunter** gerçek anahtarla denenmeli (kota, hata kodları).
3. İsteğe bağlı: JavaScript siteleri için Electron tarayıcısı, ZeroBounce/NeverBounce, Snov/Prospeo, tek kullanımlık alan adı listesinin genişletilmesi (`src/lib/email/lists.ts`, şu an ~100 alan adı; kapsam tam değildir, sonuç yalnızca bir ipucudur).
4. SRS'ye bu sapmaların işlenmesi (ayrı küçük belge PR'ı).
5. Faz 3 hazırlığı: `lead.emailsFound` olayı, `lead_emails.kind/verify_status/is_primary`, `lead_enrichment.email_status` gönderim kapısı için hazırdır; hedef ülke politikası ve suppression Faz 3'te eklenecek.

## 7. Gerçek anahtarla deneme (Faz 0 sonrası)

1. Ayarlar → Google: Places anahtarını girin, küçük bir tarama yapın.
2. Listeden 10–20 işletme seçilecek biçimde süzgeç uygulayın → **E-posta bul** → "Google verisini de yükle" seçeneğini işaretleyin (maliyet pencerede görünür) → başlatın.
3. Sonuçlar: ayrıntıda kaynak sayfayı açıp adresin gerçekten orada olduğunu doğrulayın; `engelli`/`hata` durumlarının nedenini ayrıntıda okuyun.
4. 100 işletmelik örnekte "E-posta" süzgeciyle bulma oranını sayın (facet sayıları) ve bu belgeye yazın.
