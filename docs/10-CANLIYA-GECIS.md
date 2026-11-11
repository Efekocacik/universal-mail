# Canlıya Geçiş — Şirket Girdileri, Paylaşım Kuralları ve Canlı Test Sırası

**Durum (11 Kasım 2026): Bu belge bir yol haritasıdır; içindeki canlı testlerin HİÇBİRİ henüz yapılmadı.** Gerçek gönderim, gerçek gelen kutusu okuma ve Gmail başlık güveni kodda **kapalıdır** (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `GMAIL_HEADER_TRUST_VERIFIED`; `LEGAL_APPROVALS` maddelerinin hepsi `false`; canlı ülke politikalarının hepsi engelli ve kilitli). Bu belge o kapıları açmaz. Bugünkü sürümle yapılabilen her test gerçek bir alıcıya ileti gönderemez.

> Bu belge şirketten **hangi bilginin, nereye, ne zaman** girileceğini, neyin geliştiriciyle paylaşılabileceğini ve canlı testlerin hangi sırayla yapılacağını tek yerde toplar. Hesap kurulumunun ayrıntısı: [`04-FAZ0-KILAVUZU.md`](04-FAZ0-KILAVUZU.md). Durum, kararlar ve açık teknik borç: [`08-FAZ3-NOTLARI.md`](08-FAZ3-NOTLARI.md). Doğrulama maddeleri ve kanıt biçimi: [`09-FAZ3-CANLI-DOGRULAMA.md`](09-FAZ3-CANLI-DOGRULAMA.md). Bir çelişki görürseniz **kod belirleyicidir**.

## 0. İşaretler ve bağımlı paketler

**Zaman:** **ŞİMDİ** = bugünkü sürümle girilebilir ve denenebilir · **AKTARICI** = HTTPS tek tıklamalı çıkış aktarıcısı için gerekir · **PİLOT** = gerçek gönderimden önce gerekir.

Bazı adımlar, henüz birleştirilmemiş yazılım paketlerine bağlıdır. Bu adımlar aşağıda köşeli parantezli işaretle gösterilir; **ilgili paket ana dala birleştirilmeden o adım yapılamaz** ve "yapıldı" sayılmaz.

| İşaret | Eksik olan | Paket |
|---|---|---|
| **[AKTARICI]** | Dağıtılabilir çıkış aktarıcısı sunucusu (Node süreci, dayanıklı kuyruk, anahtar dosyası, Caddy/systemd örnekleri) ve RFC 8058 `multipart/form-data` düzeltmesi. Bugün aktarıcı yalnızca kütüphane işlevidir; depoda onu başlatan bir sunucu yoktur | C2 |
| **[TB-3]** | Çıkış altyapısı için API ve arayüz: imza ve kanal anahtarı, çıkış adresi, anahtar dosyasının indirilmesi, uçtan uca doğrulama, sağlık denetimi, sürekli çekme (drain) ayarı, ARF rapor sağlayıcı listesi. Bugün bunlar yalnızca servis işlevidir (`08` TB-3) | C3 + C4 |
| **[GÖNDERİM]** | Canlı gönderim bağlantısı: zamanlayıcının, dağıtıcının ve kampanyaların gerçek (Gmail) kutuyu kabul etmesi. Bugün kampanya, zamanlayıcı ve dağıtıcı yalnızca demo kutuyla çalışır; kapılar açılsa bile gerçek kampanya gönderilmez | C1 |
| **[ANAHTAR]** | Ana anahtar dayanıklılığı: anahtar çözülemezse sessizce yenisinin üretilmemesi, kaybolan çıkış taleplerinin önlenmesi, imzalı macOS sürümü (Bölüm 5) | C5 |
| **[SÜRÜM]** | Kapıları açan bilinçli sürüm ve canlı ülke politikasını onay kaydıyla açan betik (`scripts/approve-live-country.ts`, planlandı). Uygulama içinden canlı ülke politikası açılamaz | C10 |
| **[GELEN]** | Gerçek Gmail gelen kutusu işinin bağlanması. Yalnızca bounce ve yanıtların **otomatik** işlenmesi isteniyorsa gerekir; yoksa gelen iletiler elle incelenir | C6 |
| **[BELİRSİZ]** | "Belirsiz" (`unknown`) sonuçlu gönderimi elle çözme akışı. Yoksa böyle bir dizi kalıcı olarak `in_flight` kalır ve kampanya bitmez | C7 |

## 1. Şirket girdileri (26 madde)

"Gizli" sütunu **EVET** olan hiçbir değer geliştiriciye, sohbete, e-postaya, ekran görüntüsüne veya depoya gitmez (Bölüm 2). Arkadaş bu değerleri **kendi bilgisayarında, doğrudan uygulamaya** yazar.

| # | Girdi | Nereye girilir | Kodun denetimi | Gizli | Ne zaman |
|---|---|---|---|---|---|
| 1 | Kullanım onayı: onaylayan kişinin adı soyadı, unvanı, kabul | Kurulum sihirbazı → **Onay** | Ad 2–120, unvan ≤ 120 karakter, kabul şart; tüm posta kutusu işlemleri bu onayı ister | Hayır | ŞİMDİ |
| 2 | Gönderen firma profili: ticari unvan, adres, vergi/sicil no, telefon, ihracat sorumlusu (+ unvan, web sitesi) | Sihirbaz → **Firma**; sonra Ayarlar → Firma | En kısa 2/5/2/5/2 karakter; alt bilgi unvan, adres, vergi no ve telefonu ister; `From` görünen adı "iletişim kişisi – ticari unvan" | Hayır | ŞİMDİ |
| 3 | MERSİS numarası, ticaret sicil numarası | Sihirbaz → **Firma** veya Ayarlar → Firma | İsteğe bağlı; ≤ 40 karakter; yalnızca harf, rakam, boşluk ve `. - /`; yalnızca TR alıcılarının alt bilgisine eklenir, hiçbir gönderimi engellemez | Hayır | Hukuki karara bağlı (`trSenderIdentifierRules`) |
| 4 | Hedef ve pilot ülkeler | Sihirbaz → **Pazarlar**; Ayarlar | En az 1 ülke, en çok 60; bilinen iki harfli kodlar | Hayır | ŞİMDİ |
| 5 | Veri kaynağı: Google | Sihirbaz → **Google** | `google` / `mock` (demo) | Hayır | ŞİMDİ |
| 6 | **Places API (New)** sunucu anahtarı | Sihirbaz → Google → "İşletme arama anahtarı"; Ayarlar. "Anahtarı test et" ücretsiz, yalnızca kimlik döndüren tek bir arama yapar | 8–300 karakter, boşluksuz | **EVET** | ŞİMDİ |
| 7 | **Maps JavaScript API** tarayıcı anahtarı (+ isteğe bağlı Harita Kimliği, ≤ 80) | Aynı ekran → "Harita anahtarı" | Anahtar için aynı kural; Harita Kimliği boşsa varsayılan stil | **EVET** (anahtar) | ŞİMDİ, isteğe bağlı |
| 8 | Aylık bütçe (USD) | Sihirbaz → **Bütçe**; Ayarlar | 0–100.000; varsayılan 30 | Hayır | ŞİMDİ |
| 9 | Hunter API anahtarı | Ayarlar → E-posta bulma (harici bulma açılırsa) | 8–300 karakter | **EVET** | İsteğe bağlı |
| 10 | Gönderen posta kutusu: etiket ve adres | Ayarlar → **Gönderim hesabı** → "Kutu ekle" | Etiket 2–60; geçerli adres, ayrılmış uzantı yok; en çok 5 kutu. **Adres, Workspace hesabının birincil adresi olmalı; takma ad (alias) olursa bağlantı `account_mismatch` ile reddedilir** | Hayır | ŞİMDİ |
| 11 | OAuth istemci kimliği | Aynı ekran → "Google OAuth istemcisi" | `<rakamlar>-<harf/rakam>.apps.googleusercontent.com` biçimi | Hayır | ŞİMDİ |
| 12 | OAuth istemci sırrı | Aynı form; yalnızca yazılır, uygulama bir daha göstermez | 8–200 karakter, boşluksuz (API şeması 300'e izin verir, servis 200'de keser) | **EVET** | ŞİMDİ |
| 13 | Gmail izni (arkadaş Google'ın kendi sayfasında giriş yapar) | "Gmail'e bağlan (yalnızca gönderim)"; okuma için "Gelen kutusu okumayı etkinleştir" | PKCE + `nonce`; kimlik belirtecindeki e-posta kutu adresiyle aynı olmalı; kalıcı yetki (yenileme belirteci) şart; **10 dakika içinde ve uygulama açıkken** bitirilmeli | Parola uygulamaya hiç gelmez | ŞİMDİ (gönderim); okuma yalnızca otomatik gelen kutusu isteniyorsa |
| 14 | DKIM seçici adı (Workspace'te genellikle `google`) | Kampanyalar → Günlük → **Gönderim sağlığı** → "Kontrol et" | Seçici biçim denetimi | Hayır | PİLOT (bilgi amaçlı) |
| 15 | Gönderim alan adı + Google Workspace (ücretli plan, iki adımlı doğrulama) + DNS kayıtları: SPF (tek kayıt, `~all`/`-all`, ≤ 10 arama), DKIM 2048 bit, DMARC, Postmaster TXT | Dış konsollar (`04` Adım 1–3) | DMARC `p=quarantine` veya `p=reject` → "tamam"; `p=none` → **uyarı**. Sonuç 30 gün sonra bayatlar | Kayıt şirketi ve Workspace parolaları **EVET** | Workspace ŞİMDİ (OAuth için); DNS PİLOT |
| 16 | Google Cloud projesi (Workspace kuruluşu altında): faturalandırma, bütçe uyarısı, Places günlük kotaları; Places API (New), Maps JavaScript API, Gmail API açık; API'ye göre kısıtlı iki anahtar | Google Cloud konsolu (`04` Adım 5–7; sihirbazın Google adımında kısa kılavuz) | Kod denetlemez | Kart bilgisi yalnızca arkadaşta | ŞİMDİ |
| 17 | Google Auth Platform: marka; kitle **Internal**; kapsamlar `openid`, `email`, `gmail.send` (+ istenirse `gmail.readonly`); istemci türü **Masaüstü uygulaması**; yönlendirme adresi kaydı gerekmez | Google Cloud konsolu (`04` Adım 8) | Google başka bir kapsam döndürürse bağlantı reddedilir (`scope_excess`) | İstemci JSON dosyası **EVET** (saklamayın) | ŞİMDİ |
| 18 | Harita anahtarı için HTTP referrer kısıtı | Google Cloud konsolu | Uygulama sayfası `http://127.0.0.1:<rastgele port>` adresinden açılır; konsolun her portu kabul edip etmediği denenmeli, olmuyorsa API kısıtı + kota ile yetinilir | — | ŞİMDİ |
| 19 | Aktarıcı alt alan adı (örn. `cikis.sirket-export.com`) ve DNS A/AAAA kaydı | Kayıt şirketinin DNS ekranı | HTTPS; **port yazılmaz** (443); IP değil; ayrılmış uzantı değil; yol `/` | Hayır | AKTARICI |
| 20 | Linux sunucu (VPS): kalıcı ext4/xfs disk, 80/443 açık, SSH, NTP; yaklaşık 1 vCPU / 512 MB. **Ücretli olabilir; sağlayıcı şirket kararı** | Sağlayıcı paneli | Kanal en çok ±5 dk saat farkını kabul eder (NTP şart) | SSH bilgileri **EVET** | AKTARICI |
| 21 | İsteğe bağlı TLS sertifikası (ACME) iletişim e-postası; sürekli çekmenin (drain) açılması kararı | Sunucu yapılandırması / uygulama [TB-3] | — | Hayır | AKTARICI |
| 22 | Geri bildirim döngüsü (FBL/ARF) rapor sağlayıcı alan adları | **Henüz arayüz yok** [TB-3] | ≤ 50 alan adı, biçim denetimi, genel sonek (ör. `co.uk`) olamaz | Hayır | İsteğe bağlı |
| 23 | Şirket dışı, tek kullanımlık test Gmail hesabı (başlık güveni, `09` Bölüm 1.3) | — | — | Parolası **EVET** (yalnızca arkadaşta) | Yalnızca otomatik gelen kutusu işleme isteniyorsa |
| 24 | Yazılı hukuki onaylar: 7 `LEGAL_APPROVALS` maddesi (**`trSenderIdentifierRules` Türkiye hedeflenmese bile gerekir**, çünkü birleşik kapı yedisini birden ister); ülke bazında canlı onay kaydı (`approval_ref`, `approved_by`, `approved_at`); `docs/03` onayı; 180 günlük çıkış belirteci süresinin gözden geçirilmesi | Yalnızca sürümle [SÜRÜM] (kod sabitleri ve ülke onay betiği) | Veritabanı kısıtı, kilit açılırken üç onay alanını da ister | Hayır | PİLOT |
| 25 | Yetkilendirilmiş pilot test alıcıları (ilk hafta günde ≤ 20) | — | Hazırlık ekranında `pilot` maddesi kodda sabit "bilinmiyor"dur; elle kayıt tutulur | Hayır | PİLOT |
| 26 | Donanım: **Apple Silicon Mac** (macOS paketi yalnızca arm64 ve imzasızdır; ilk açılışta Sistem Ayarları → Gizlilik ve Güvenlik → "Yine de Aç" gerekir). Intel Mac desteklenmez; Windows x64 kurulum paketi ayrıca üretilir | — | — | — | ŞİMDİ |

## 2. Paylaşım kuralları

### 2.1 Geliştiriciyle paylaşılabilir (gizli değildir)

- Firma profili alanları (madde 2–3), hedef ülkeler, gönderen kutu adresi, gönderim alan adı, DKIM seçici adı.
- Google Cloud **Proje kimliği**, OAuth **istemci kimliği** (sırrı DEĞİL), Harita Kimliği.
- Aktarıcı alt alan adı, sunucunun IP adresi, ARF rapor sağlayıcı alan adları.
- Uygulamanın gösterdiği **sonuçlar**: DNS denetimi, hazırlık ekranı, doğrulama kodu (`verified`, `bad_status` vb.). Ekran görüntüsünde anahtar alanı veya tam alıcı adresi görünmemelidir.

### 2.2 Asla paylaşılmaz

- Places, Maps ve Hunter anahtarları (madde 6, 7, 9), OAuth istemci sırrı (madde 12) ve istemci JSON dosyası.
- Her türlü parola: kayıt şirketi, Workspace, Google, test Gmail hesabı; kart bilgileri; SSH anahtarları ve sunucu parolaları.
- Uygulama veri klasöründeki dosyalar: `master.key.enc`, `secrets.json` ve veritabanı (macOS: `~/Library/Application Support/Universal Mail/`).

Pratik kural: geliştirici ekran paylaşımıyla yönlendirebilir, ama **gizli bir alan doldurulurken ekran paylaşımı durdurulur**. Bir anahtar yanlışlıkla paylaşılırsa Google Cloud'da silinip yenisi oluşturulur (`04` Adım 11).

### 2.3 Aktarıcı anahtar dosyası (özel durum)

Aktarıcıya giden anahtar dosyası (`relay-keys.json`, [TB-3] ile indirilir) yalnızca **genel** anahtarları içerir; gizli değildir ama **bütünlüğü kritiktir**: kanal anahtarlarını değiştirebilen biri kuyruktaki olayları çekip onaylayabilir, yani çıkış taleplerini silebilir. Bu yüzden dosya yalnızca SSH (`scp`) ile kopyalanır; sunucuda sahibi `root:umrelay`, izni `0640` olur. E-posta veya mesajlaşma ile taşınmaz.

## 3. Canlı test sırası

Her adımın kanıtı `09` Bölüm 9 biçiminde kaydedilir (tarih, yapan, ortam, yöntem, sonuç; gizli bilgi ve alıcı verisi içermez). Bir adım beklenen sonucu vermezse sonraki aşamaya geçilmez.

### 3.1 Aşama 1 — Bugün (kod değişikliği gerekmez; gerçek gönderim imkânsız)

Önkoşul: madde 1–8, 10–13, 16–17 ve 26. Uygulama `.dmg` paketinden kurulu.

1. [ ] **Kurulum sihirbazı:** veri kaynağı Google; Places anahtarı → "Anahtarı test et" → "Anahtar çalışıyor." (ücretsiz çağrı).
2. [ ] **Tek şehir taraması ve harita:** küçük bir alanda tarama; tahmini maliyet onay ekranında görünür; sonuçlar liste ve haritada çıkar. Harita açılmıyorsa `04` "Sık karşılaşılan sorunlar".
3. [ ] **E-posta bulma:** birkaç işletmede web sitesinden bulma; isteğe bağlı Hunter yedeği (madde 9).
4. [ ] **Posta kutusu ve OAuth istemcisi:** Ayarlar → Gönderim hesabı; kutu (birincil adres) + istemci kimliği + istemci sırrı.
5. [ ] **"Gmail'e bağlan (yalnızca gönderim)":** bağlantı **sistem tarayıcısında** açılır; Google oradan `http://127.0.0.1:<port>/api/oauth/gmail/callback` adresine döner ve sonuç (başarı ya da `account_mismatch`, `scope_excess`, `no_refresh_token` gibi hata nedeni) **o tarayıcı sekmesinde** görünür. Uygulama penceresi 10 dakika boyunca 3 saniyede bir kontrol eder ve yalnızca "bağlı" rozetini gösterir; hata nedenini göstermez. Bu sırada uygulama **kapatılmamalıdır**: yeniden başlatma portu değiştirir ve bekleyen yetkilendirme kaybolur, akış baştan başlar.
6. [ ] **`09` Bölüm 2 maddelerinden gönderim gerektirmeyenler:** gerçek yanıttaki kapsam dizgileri; `127.0.0.1` döngü adresi yönlendirmesinin "Masaüstü uygulaması" istemcisiyle kabul edilmesi; Google hesabından izin iptali sonrası kutunun `reauthorization_required` durumuna geçmesi; kademeli yetki (önce yalnızca gönderim, sonra okuma).
7. [ ] **DNS "Kontrol et":** Kampanyalar → Günlük → Gönderim sağlığı. SPF ve DKIM `pass`; DMARC `p=none` iken **uyarı** beklenir, `p=quarantine`/`p=reject` iken `pass`.
8. [ ] **Hazırlık kartı ("Canlı gönderime hazırlık"):** kapılar, hukuki onaylar, çıkış uç noktası ve pilot maddeleri beklendiği gibi açık değil; bağlı kutu ve DNS maddeleri gerçek sonuca göre değişir. **Not:** hazırlık kartı yalnızca gösterimdir; gönderim yolu DNS, gelen kutusu veya pilot maddesini ayrıca denetlemez.
9. [ ] **Güncelleme denemesi (gizli depo):** sürüm N kurulu ve Gmail bağlıyken sürüm N+1'i kurun. Anahtarlar ve Gmail bağlantısı korunmalı. Anahtarlık izin sorarsa "Her Zaman İzin Ver" seçilir. Anahtarlar kaybolursa bulguyu kaydedin: imzasız paket ana anahtarı çözemiyor demektir ve canlı gönderimden önce [ANAHTAR] şarttır (Bölüm 5).

İsteğe bağlı: "Gelen kutusu okumayı etkinleştir" ile okuma izni verilebilir; ancak gerçek gelen kutusu işi demo dışında çalışmaz [GELEN], bu yüzden bugün yalnızca iznin alındığı doğrulanır.

### 3.2 Aşama 2 — Aktarıcı ile [AKTARICI] [TB-3]

Önkoşul: madde 19–21; aktarıcı paketi (C2) ve çıkış altyapısı arayüzü (C3 + C4) ana dalda. Komutlardaki `<alan>` aktarıcı alt alan adıdır. Aktarıcı ortam değişkenlerinin ve dosya yollarının kesin adları paketin `deploy/relay/README.md` belgesinde verilecektir; aşağıdakiler planlanan adlardır.

1. [ ] **Kurulum:** sunucuda aktarıcı servisi (systemd, tek örnek) ve önünde Caddy (80/443, Let's Encrypt). Caddy yalnızca `/u/*`, `/spool/*` ve `/healthz` yollarını `127.0.0.1:8787`'ye iletir; **yol veya sorgu yeniden yazılmaz, önbellek yoktur** (kanal imzası tam yolu kapsar). `/u/*` ve `/spool/*` aynı kökende (origin) ve 443'te olmalıdır.
2. [ ] **Anahtarsız sağlık:** `curl -sI https://<alan>/healthz` → `503` (henüz anahtar yok).
3. [ ] **RFC 8058 içerik türü:** `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: multipart/form-data; boundary=x' https://<alan>/u/u2.a.b` → `400` (geçersiz belirteç), **`415` değil**.
4. [ ] **Uygulamada anahtarlar ve adres:** imza anahtarını oluştur → kanal anahtarını oluştur → çıkış adresini `https://<alan>/` olarak gir → anahtar dosyasını indir → `scp` ile sunucuya kopyala (Bölüm 2.3).
5. [ ] **Anahtarlı sağlık:** `/healthz` → `200`.
6. [ ] **Uçtan uca doğrulama:** uygulamada "Doğrula" → `verified`. Sınama belirteci `p` kapsamındadır; hiçbir alıcıya veya engel listesine dokunmaz. Kanıt 30 gün geçerlidir ve imza anahtarına bağlıdır.
7. [ ] **Kuyruk sağlığı:** sağlık denetimi → `ok`, derinlik 0.
8. [ ] **Dayanıklılık (K2):** 200 almış bir olay kuyruğun `pending/` dizinindeyken aktarıcı `kill -9` ile öldürülür, yeniden başlatılır; olay kaybolmamalı ve uygulama çektiğinde onaylanıp silinmelidir. Olayı uygulama çekmeden önce üretmenin yolu aktarıcı paketinin belgesinde verilir (uygulamadaki doğrulama olayı hemen çektiği için bu denemeye uygun değildir).
9. [ ] **Döndürme tatbikatı:** imza anahtarını döndür → doğrulama `bad_status` (aktarıcı eski anahtarı biliyor) → yeni anahtar dosyasını kopyala → doğrulama `verified`.
10. [ ] **Sürekli çekme (drain):** uygulamada açılır [TB-3]. Paket gelene kadar yalnızca deneme amaçlı geçici yol: uygulamayı Terminal'den `UM_UNSUBSCRIBE_DRAIN_ENABLED=1 "/Applications/Universal Mail.app/Contents/MacOS/Universal Mail"` ile başlatmak (`open -a` ortam değişkeni geçirmez). Bu yol kalıcı yapılandırma değildir.
11. [ ] **Aylık yeniden doğrulama:** 30 günlük kanıt süresi dolunca `List-Unsubscribe-Post` ve canlı gönderim durur. Otomatik yeniden doğrulama (C4) gelene kadar ayda bir elle "Doğrula".

Gerçek Gmail ile tek tıklamalı çıkış denemesi bu aşamada **yapılmaz**; gerçek bir ileti gönderilmesini gerektirir (Aşama 3).

### 3.3 Aşama 3 — Son: hukuki onaylar ve pilot [GÖNDERİM] [SÜRÜM] [ANAHTAR] [BELİRSİZ]

Önkoşul: Aşama 1 ve 2 kanıtlı; madde 15 (DNS), 24 ve 25; ilgili paketler ana dalda.

1. [ ] **Yazılı hukuki onaylar** (madde 24; `09` Bölüm 6). Belgeler bu depoda saklanmaz; yalnızca referansları kaydedilir.
2. [ ] **DNS:** DMARC `p=quarantine` veya `p=reject`; üç denetim taze ve `pass` (`09` Bölüm 5).
3. [ ] **Kapı açma sürümü** [SÜRÜM]: `LEGAL_APPROVALS` ve `LIVE_SENDING_ENABLED` değerlerini onay referanslarıyla değiştiren, bunları `false` olarak sabitleyen testleri güncelleyen ve `09` Bölüm 9 kanıt referanslarını yazan **tek, incelenmiş** bir sürüm. Ortam değişkeni veya ayar bunun yerine geçmez.
4. [ ] **Canlı ülke onayı** [SÜRÜM]: yalnızca onaylı ülkeler için, onay betiğiyle (`approval_ref`, `approved_by`, `approved_at`), denetim kaydıyla ve kayıtlı bir sürüm sırasında. Uygulamanın politika ekranı canlı satırları değiştiremez.
5. [ ] **Gönderim bağlantısı** [GÖNDERİM]: Gmail kutusuyla bir kampanyanın oluşturulup başlatılabildiği; kapı kapalıyken davranışın değişmediği.
6. [ ] **Pilot:** ilk hafta günde **≤ 20** ileti, yalnızca yetkilendirilmiş test alıcılarına (madde 25). Bu sırada `09` Bölüm 2'nin gerçek gönderim isteyen maddeleri (`Message-ID` yeniden yazımı, `List-Unsubscribe` başlıklarının korunması, Gmail hata zarfları, kota yanıtları) ve gerçek Gmail tek tıklamalı çıkışı doğrulanır.
7. [ ] **Günlük gözlem:** bounce, yanıt, çıkış talepleri, kuyruk sağlığı. Belirsiz sonuçlu gönderim [BELİRSİZ] veya beklenmeyen davranışta gönderim elle durdurulur ve nedeni kaydedilir (`09` Bölüm 7).

> **Tavuk-yumurta sorunu:** `09` Bölüm 2'deki bazı maddeler gerçek gönderim gerektirir; gerçek gönderim ise bütün hukuki onaylar olmadan açılmaz. Onaylardan önce kontrollü bir "kendime gönder" denemesi ancak ayrı ve dar bir kapıyla (C11, isteğe bağlı) mümkündür; bu kapı **şirketin ve İpek'in yazılı onayı olmadan yazılmaz**.

## 4. Uygulamanın yönettiği anahtarlar ve özetler (kimse bir şey girmez)

| Ne | Nasıl üretilir | Nerede durur | Not |
|---|---|---|---|
| Ana anahtar | 32 bayt rastgele; işletim sistemi anahtarlığıyla şifrelenir | `master.key.enc` (uygulama veri klasörü) | Gizli depoyu (AES-256-GCM) açar. Çözülemezse uygulama bugün yenisini üretir ve eski depoyu yedeğe alır (Bölüm 5) |
| Gizli depo | Ana anahtarla AES-256-GCM | `secrets.json` | Google/Hunter anahtarları, OAuth istemci sırrı, yenileme belirteçleri, imza ve kanal özel anahtarları |
| Çıkış belirteci imza anahtarı | Ed25519; anahtar kimliği (`kid`) = ham genel anahtarın SHA-256 özetinin ilk 16 onaltılık karakteri | Özel anahtar gizli depoda; yalnızca genel anahtar aktarıcıya gider | Belirteç biçimi `u2.<yük>.<imza>`, varsayılan ömür 180 gün |
| Kanal anahtarı | Ed25519 | Aynı | Aktarıcıdan çekme/onay isteklerini imzalar; imza girdisi gövdenin `sha256` özetini içerir; ±5 dk saat farkı |
| Alıcı etiketi (`r`) | Ana anahtardan HKDF ile türetilen anahtarla HMAC-SHA256 | Belirtecin içinde | Ana anahtar değişirse eski etiketler tutmaz (Bölüm 5) |
| Engel ve alıcı özeti | Normalleştirilmiş adresin düz SHA-256 özeti (ek gizli değer yok) | Veritabanı | Engel listesi açık adres tutmaz |
| Silme yer tutucusu | `sha256("um-erased-v1:" + rastgele 128 bit)` | Veritabanı | Başka bir adresle eşleşmez |
| PKCE | S256 | Bellek (10 dk) | OAuth akışı başına |
| OAuth yenileme belirteci | Google verir | Yalnızca gizli depoda | Veritabanında yalnızca adı ve izin özeti |

## 5. Canlı öncesi bilinen riskler

| Risk | Etkisi | Önlem / paket |
|---|---|---|
| Ana anahtar çözülemezse sessizce yenisi üretilir | Bütün anahtarlar ve Gmail bağlantısı yeniden girilmeli. **Daha ağırı:** gönderilmiş iletilerdeki çıkış bağlantılarının alıcı etiketi artık tutmaz; tıklamalar `recipient_mismatch` ile reddedilip kuyruktan silinir, **çıkış talebi kaybolur** (yalnızca denetim kaydı kalır) | [ANAHTAR] (C5). C5 gelene kadar canlı gönderim başladıktan sonra uygulama başka bir bilgisayara taşınmaz ve Aşama 1/9 denemesi geçmeden canlıya geçilmez |
| RFC 8058 `multipart/form-data` isteğine 415 | Bu biçimi kullanan uyumlu istemcilerin tek tıklamalı çıkışı başarısız olabilir | [AKTARICI] (C2); Aşama 2/3 ile doğrulanır |
| Hazırlık kartı yalnızca gösterimdir | DMARC `p=none` kartı "tamam" yapmaz ama gönderimi de durdurmaz | Aşama 3/2'de DNS ayrıca kontrol edilir |
| OAuth sonucu sistem tarayıcısında | Hata nedeni uygulama penceresinde görünmez; uygulama kapanırsa akış kaybolur | Aşama 1/5'teki talimat; arayüz iyileştirmesi C12 |
| Uç nokta kanıtı 30 günde düşer | Fark edilmezse canlı gönderim her ay kendiliğinden durur | Aşama 2/11; otomatik yeniden doğrulama C4; uyarı kanalı C14 |
