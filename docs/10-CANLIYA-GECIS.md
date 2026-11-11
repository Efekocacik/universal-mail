# Canlıya Geçiş — Şirket Girdileri, Paylaşım Kuralları ve Canlı Test Sırası

**Durum (11 Kasım 2026): Bu belge bir yol haritasıdır; içindeki canlı testlerin HİÇBİRİ henüz yapılmadı.** Gerçek gönderim, gerçek gelen kutusu okuma ve Gmail başlık güveni kodda **kapalıdır** (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `GMAIL_HEADER_TRUST_VERIFIED`; `LEGAL_APPROVALS` maddelerinin hepsi `false`; canlı ülke politikalarının hepsi engelli ve kilitli). Bu belge o kapıları açmaz. Bugünkü sürümle yapılabilen her test gerçek bir alıcıya ileti gönderemez.

> Bu belge şirketten **hangi bilginin, nereye, ne zaman** girileceğini, neyin geliştiriciyle paylaşılabileceğini ve canlı testlerin hangi sırayla yapılacağını tek yerde toplar. Hesap kurulumunun ayrıntısı: [`04-FAZ0-KILAVUZU.md`](04-FAZ0-KILAVUZU.md). Durum, kararlar ve açık teknik borç: [`08-FAZ3-NOTLARI.md`](08-FAZ3-NOTLARI.md). Doğrulama maddeleri ve kanıt biçimi: [`09-FAZ3-CANLI-DOGRULAMA.md`](09-FAZ3-CANLI-DOGRULAMA.md). Bir çelişki görürseniz **kod belirleyicidir**.

## 0. İşaretler ve paket durumu

**Zaman:** **ŞİMDİ** = bugünkü sürümle girilebilir ve denenebilir · **AKTARICI** = HTTPS tek tıklamalı çıkış aktarıcısı için gerekir · **PİLOT** = gerçek gönderimden önce gerekir.

Canlıya geçiş hazırlık paketlerinin hepsi `feat/golive-prep` dalında birleştirildi (**ana dala henüz birleştirilmedi**; ana dala alınana kadar aşağıdaki adımlar o daldan derlenen sürümle yapılır). Köşeli parantezli işaretler, bir adımın hangi pakete dayandığını gösterir. Paketler kapıları AÇMAZ: hepsi kodda kapalı kilitlerin arkasındadır.

| İşaret | Ne sağlar | Paket | Durum |
|---|---|---|---|
| **[AKTARICI]** | Dağıtılabilir çıkış aktarıcısı (`src/relay/`, `npm run build:relay` → `dist/relay/relay.cjs`), dayanıklı kuyruk, anahtar dosyası, Caddy/systemd/Docker örnekleri, RFC 8058 `multipart/form-data` | C2 | Kodlandı; **hiçbir sunucuya dağıtılmadı** |
| **[ÇIKIŞ]** | Çıkış altyapısı API'si ve arayüzü: **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** (imza ve kanal anahtarı, çıkış sunucusu adresi, anahtar dosyası, uçtan uca doğrulama, kuyruk sağlığı, "Talepleri düzenli çek", ARF sağlayıcıları); 25 günde kendiliğinden yeniden doğrulama; kampanya ve uyum sayfalarında uyarı bandı | C3 + C4 + C14 | Kodlandı |
| **[GÖNDERİM]** | Canlı gönderim yolu: zamanlayıcı, dağıtıcı ve kampanyalar gerçek (Gmail) kutuyu yalnızca canlı gönderim kapısı açıkken kabul eder | C1 | Kodlandı; kapı kapalı |
| **[ANAHTAR]** | Ana anahtar dayanıklılığı: çözülemezse sessizce yenisi üretilmez (engelleyici pencere, iki onaylı sıfırlama, `.bak` yedekleri); anahtar değişince çıkış talepleri kaybolmaz | C5 | Kodlandı; **imzalı/kararlı kimlikli macOS sürümü (C5c) açık** |
| **[SÜRÜM]** | Kapıları açan bilinçli sürüm (C10b) ve canlı ülke politikasını onay kaydıyla açan betik `scripts/approve-live-country.ts` (C10a). Uygulama içinden canlı ülke politikası açılamaz | C10 | Betik var; **kapı açma sürümü yapılmadı** |
| **[GELEN]** | Gerçek Gmail gelen kutusu işi (`inbox.sync`), yalnızca `LIVE_INBOX_READING_ENABLED` açıkken. Yalnızca bounce ve yanıtların **otomatik** işlenmesi isteniyorsa gerekir | C6 | Kodlandı; kilit kapalı |
| **[BELİRSİZ]** | "Belirsiz" (`unknown`) sonuçlu gönderimi elle çözme: **Kampanyalar → İnceleme bekleyenler** | C7 | Kodlandı |

Hâlâ açık olanlar: imzalı macOS sürümü (C5c), kapı açma sürümü (C10b), işletim sistemi/e-posta uyarı bildirimi (uyarılar yalnızca uygulama içinde görünür; `08` TB-4), aktarıcının gerçek dağıtımı ve **bu belgedeki canlı testlerin tamamı**.

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
| 12 | OAuth istemci sırrı | Aynı form; yalnızca yazılır, uygulama bir daha göstermez | 8–200 karakter, boşluksuz (API ve servis aynı sınır) | **EVET** | ŞİMDİ |
| 13 | Gmail izni (arkadaş Google'ın kendi sayfasında giriş yapar) | "Gmail'e bağlan (yalnızca gönderim)"; okuma için "Gelen kutusu okumayı etkinleştir" | PKCE + `nonce`; kimlik belirtecindeki e-posta kutu adresiyle aynı olmalı; kalıcı yetki (yenileme belirteci) şart; **10 dakika içinde ve uygulama açıkken** bitirilmeli | Parola uygulamaya hiç gelmez | ŞİMDİ (gönderim); okuma yalnızca otomatik gelen kutusu isteniyorsa |
| 14 | DKIM seçici adı (Workspace'te genellikle `google`) | Kampanyalar → Günlük → **Gönderim sağlığı** → "Kontrol et" | Seçici biçim denetimi | Hayır | PİLOT (bilgi amaçlı) |
| 15 | Gönderim alan adı + Google Workspace (ücretli plan, iki adımlı doğrulama) + DNS kayıtları: SPF (tek kayıt, `~all`/`-all`, ≤ 10 arama), DKIM 2048 bit, DMARC, Postmaster TXT | Dış konsollar (`04` Adım 1–3) | DMARC `p=quarantine` veya `p=reject` → "tamam"; `p=none` → **uyarı**. Sonuç 30 gün sonra bayatlar | Kayıt şirketi ve Workspace parolaları **EVET** | Workspace ŞİMDİ (OAuth için); DNS PİLOT |
| 16 | Google Cloud projesi (Workspace kuruluşu altında): faturalandırma, bütçe uyarısı, Places günlük kotaları; Places API (New), Maps JavaScript API, Gmail API açık; API'ye göre kısıtlı iki anahtar | Google Cloud konsolu (`04` Adım 5–7; sihirbazın Google adımında kısa kılavuz) | Kod denetlemez | Kart bilgisi yalnızca arkadaşta | ŞİMDİ |
| 17 | Google Auth Platform: marka; kitle **Internal**; kapsamlar `openid`, `email`, `gmail.send` (+ istenirse `gmail.readonly`); istemci türü **Masaüstü uygulaması**; yönlendirme adresi kaydı gerekmez | Google Cloud konsolu (`04` Adım 8) | Google başka bir kapsam döndürürse bağlantı reddedilir (`scope_excess`) | İstemci JSON dosyası **EVET** (saklamayın) | ŞİMDİ |
| 18 | Harita anahtarı için HTTP referrer kısıtı | Google Cloud konsolu | Uygulama sayfası `http://127.0.0.1:<rastgele port>` adresinden açılır; konsolun her portu kabul edip etmediği denenmeli, olmuyorsa API kısıtı + kota ile yetinilir | — | ŞİMDİ |
| 19 | Aktarıcı alt alan adı (örn. `cikis.sirket-export.com`) ve DNS A/AAAA kaydı | Kayıt şirketinin DNS ekranı | HTTPS; **port yazılmaz** (443); IP değil; ayrılmış uzantı değil; yol `/` | Hayır | AKTARICI |
| 20 | Linux sunucu (VPS): kalıcı ext4/xfs disk, 80/443 açık, SSH, NTP; yaklaşık 1 vCPU / 512 MB. **Ücretli olabilir; sağlayıcı şirket kararı** | Sağlayıcı paneli | Kanal en çok ±5 dk saat farkını kabul eder (NTP şart) | SSH bilgileri **EVET** | AKTARICI |
| 21 | İsteğe bağlı TLS sertifikası (ACME) iletişim e-postası; düzenli çekmenin (drain) açılması kararı | Sunucu yapılandırması / Ayarlar → Abonelikten çıkış altyapısı (HTTPS) → **"Talepleri düzenli çek"** [ÇIKIŞ] | Çekme yalnızca çıkış sunucusu adresi tanımlıyken çalışır | Hayır | AKTARICI |
| 22 | Geri bildirim döngüsü (FBL/ARF) rapor sağlayıcı alan adları | Aynı ekran → **"Şikâyet raporu sağlayıcıları (ARF)"** → "Listeyi kaydet" [ÇIKIŞ] | ≤ 50 alan adı, biçim denetimi, genel sonek (ör. `co.uk`) olamaz | Hayır | İsteğe bağlı |
| 23 | Şirket dışı, tek kullanımlık test Gmail hesabı (başlık güveni, `09` Bölüm 1.3) | — | — | Parolası **EVET** (yalnızca arkadaşta) | Yalnızca otomatik gelen kutusu işleme isteniyorsa |
| 24 | Yazılı hukuki onaylar: 7 `LEGAL_APPROVALS` maddesi (**`trSenderIdentifierRules` Türkiye hedeflenmese bile gerekir**, çünkü birleşik kapı yedisini birden ister); ülke bazında canlı onay kaydı (`approval_ref`, `approved_by`, `approved_at`); `docs/03` onayı; 180 günlük çıkış belirteci süresinin gözden geçirilmesi | Yalnızca sürümle [SÜRÜM] (kod sabitleri ve `scripts/approve-live-country.ts`) | Veritabanı kısıtı, kilit açılırken üç onay alanını da ister; betik `LEGAL_APPROVALS.liveCountryPolicies` `true` değilse reddeder | Hayır | PİLOT |
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

Aktarıcıya giden anahtar dosyası (`relay-keys.json`; Ayarlar → Abonelikten çıkış altyapısı (HTTPS) → "Anahtar dosyasını indir") yalnızca **genel** anahtarları içerir; gizli değildir ama **bütünlüğü kritiktir**: kanal anahtarlarını değiştirebilen biri kuyruktaki olayları çekip onaylayabilir, yani çıkış taleplerini silebilir. Bu yüzden dosya yalnızca SSH (`scp`) ile kopyalanır; sunucuda `sudo install -o root -g umrelay -m 0640` ile yerleştirilir (`deploy/relay/README.md` §9; aynı komut uygulama ekranında da gösterilir). E-posta veya mesajlaşma ile taşınmaz.

## 3. Canlı test sırası

Her adımın kanıtı `09` Bölüm 9 biçiminde kaydedilir (tarih, yapan, ortam, yöntem, sonuç; gizli bilgi ve alıcı verisi içermez). Bir adım beklenen sonucu vermezse sonraki aşamaya geçilmez.

### 3.1 Aşama 1 — Bugün (kod değişikliği gerekmez; gerçek gönderim imkânsız)

Önkoşul: madde 1–8, 10–13, 16–17 ve 26. Uygulama `.dmg` paketinden kurulu.

1. [ ] **Kurulum sihirbazı:** veri kaynağı Google; Places anahtarı → "Anahtarı test et" → "Anahtar çalışıyor." (ücretsiz çağrı).
2. [ ] **Tek şehir taraması ve harita:** küçük bir alanda tarama; tahmini maliyet onay ekranında görünür; sonuçlar liste ve haritada çıkar. Harita açılmıyorsa `04` "Sık karşılaşılan sorunlar".
3. [ ] **E-posta bulma:** birkaç işletmede web sitesinden bulma; isteğe bağlı Hunter yedeği (madde 9).
4. [ ] **Posta kutusu ve OAuth istemcisi:** Ayarlar → Gönderim hesabı; kutu (birincil adres) + istemci kimliği + istemci sırrı.
5. [ ] **"Gmail'e bağlan (yalnızca gönderim)":** bağlantı **sistem tarayıcısında** açılır; Google oradan `http://127.0.0.1:<port>/api/oauth/gmail/callback` adresine döner. Sonuç **hem** tarayıcı sekmesindeki bağımsız sayfada ("Bağlantı tamamlandı" / "Bağlantı kurulamadı" + nedene özgü ipucu: `account_mismatch`, `scope_excess`, `no_refresh_token` vb.) **hem de** uygulamada kutunun altında (neden ve ipucuyla) görünür; uygulama 10 dakika boyunca 3 saniyede bir sorar, süre dolarsa zaman aşımı notu gösterir. Tarayıcı sekmesi yenilenirse ilk sonuç yeniden gösterilir. Bu sırada uygulama **kapatılmamalıdır**: yeniden başlatma portu değiştirir ve bekleyen yetkilendirme kaybolur, akış baştan başlar.
6. [ ] **`09` Bölüm 2 maddelerinden gönderim gerektirmeyenler:** gerçek yanıttaki kapsam dizgileri; `127.0.0.1` döngü adresi yönlendirmesinin "Masaüstü uygulaması" istemcisiyle kabul edilmesi; Google hesabından izin iptali sonrası kutunun `reauthorization_required` durumuna geçmesi; kademeli yetki (önce yalnızca gönderim, sonra okuma).
7. [ ] **DNS "Kontrol et":** Kampanyalar → Günlük → Gönderim sağlığı. SPF ve DKIM `pass`; DMARC `p=none` iken **uyarı** beklenir, `p=quarantine`/`p=reject` iken `pass`.
8. [ ] **Hazırlık kartı ("Canlı gönderime hazırlık"):** kapılar, hukuki onaylar, çıkış uç noktası ve pilot maddeleri beklendiği gibi açık değil; bağlı kutu ve DNS maddeleri gerçek sonuca göre değişir. **Not:** hazırlık kartı yalnızca gösterimdir; gönderim yolu DNS, gelen kutusu veya pilot maddesini ayrıca denetlemez.
9. [ ] **Güncelleme denemesi (gizli depo):** sürüm N kurulu ve Gmail bağlıyken sürüm N+1'i kurun. Anahtarlar ve Gmail bağlantısı korunmalı. Anahtarlık izin sorarsa "Her Zaman İzin Ver" seçilir. **"Ana anahtar açılamadı" penceresi çıkarsa** bulguyu kaydedin ve yalnızca **"Tekrar dene"** (anahtarlık iznini verdikten sonra) veya **"Uygulamayı kapat"** seçin; deneme sırasında **asla "Gizli bilgileri sıfırla…" seçmeyin**. Pencere tekrarlıyorsa imzasız paket ana anahtarı çözemiyor demektir: canlı gönderimden önce imzalı sürüm (C5c) şarttır (Bölüm 5).

İsteğe bağlı: "Gelen kutusu okumayı etkinleştir" ile okuma izni verilebilir; ancak gerçek gelen kutusu işi `LIVE_INBOX_READING_ENABLED` kapalıyken çalışmaz [GELEN], bu yüzden bugün yalnızca iznin alındığı doğrulanır.

### 3.2 Aşama 2 — Aktarıcı ile [AKTARICI] [ÇIKIŞ]

Önkoşul: madde 19–21. Ortam değişkenleri, dosya yolları ve komutların kesin hâli [`deploy/relay/README.md`](../deploy/relay/README.md) belgesindedir (`RELAY_PUBLIC_ORIGIN`, `/etc/um-relay/keys.json`, `/var/lib/um-relay`, `um-relay.service`, Caddyfile). Komutlardaki `<alan>` aktarıcı alt alan adıdır. Uygulamadaki her adım **Ayarlar → Abonelikten çıkış altyapısı (HTTPS)** ekranındadır.

1. [ ] **Derleme ve kurulum:** geliştirici bilgisayarında `npm run build:relay` (`dist/relay/relay.cjs`); sunucuda Node.js 22, `umrelay` sistem kullanıcısı, systemd birimi (tek örnek) ve önünde Caddy (80/443, Let's Encrypt) — README §1–7. Caddy yalnızca `/u/*`, `/spool/*` ve `/healthz` yollarını `127.0.0.1:8787`'ye iletir; **yol veya sorgu yeniden yazılmaz, önbellek yoktur** (kanal imzası tam yolu kapsar); erişim ve hata günlüğü kapalıdır (belirteç ve imza başlıkları günlüğe düşmesin). `/u/*` ve `/spool/*` aynı kökende (origin) ve 443'te olmalıdır.
2. [ ] **Anahtarsız sağlık:** `curl -s -o /dev/null -w '%{http_code}' https://<alan>/healthz` → `503`; anahtarsız `POST /u/u2.a.b` → `503` (README §8).
3. [ ] **Uygulamada anahtarlar ve adres:** "İmza anahtarı" → **Anahtar oluştur**; "Kanal anahtarı" → **Anahtar oluştur**; "Çıkış sunucusu adresi" → `https://<alan>` → **Adresi kaydet**; **Anahtar dosyasını indir** → `scp` ile sunucuya (Bölüm 2.3; README §9).
4. [ ] **Anahtarlı sağlık:** `/healthz` → `200`.
5. [ ] **RFC 8058 içerik türü** (anahtar dosyası yüklendikten SONRA; önce 503 döner): `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: multipart/form-data; boundary=x' --data 'List-Unsubscribe=One-Click' https://<alan>/u/u2.a.b` → `400` (geçersiz belirteç), **`415` değil** (README §10).
6. [ ] **Uçtan uca doğrulama:** **Doğrula** → "Uç nokta doğrulandı." (`verified`). Sınama belirteci `p` kapsamındadır; hiçbir alıcıya veya engel listesine dokunmaz. Kanıt 30 gün geçerlidir ve imza anahtarına bağlıdır.
7. [ ] **Kuyruk sağlığı:** **Kuyruğu denetle** → "Kuyruk sağlıklı.", derinlik 0.
8. [ ] **Dayanıklılık (K2):** README §11'deki tatbikat: kanal anahtarında **Yeni anahtara geç** (yeni dosyayı henüz yüklemeden) → **Doğrula** ("Sunucu kanal anahtarını tanımıyor…"; olay diskte bekler) → sunucuda `sudo ls /var/lib/um-relay/spool/pending/` (bir dosya) → `sudo systemctl kill -s KILL um-relay` → yeniden başlayınca dosya hâlâ orada → yeni anahtar dosyasını yükle → **Doğrula** (bekleyen olayları da çeker) → **Kuyruğu denetle** → derinlik 0. "Kuyruğu denetle" yalnızca sayıları okur, olay çekmez. (Doğrulama sınama olayını hemen çektiği için olay ancak çekme bu şekilde engellenerek kuyrukta tutulabilir.)
9. [ ] **Döndürme tatbikatı:** imza anahtarında **Yeni anahtara geç** → **Doğrula** → "Sunucu isteği kabul etmedi…" (`bad_status`; aktarıcı yalnızca eski anahtarı biliyor) → yeni anahtar dosyasını yükle → **Doğrula** → `verified`.
10. [ ] **Düzenli çekme (drain):** **"Talepleri düzenli çek"** anahtarını açın (ayar kalıcıdır; uygulama açıkken talepler dakikada bir çekilir). `UM_UNSUBSCRIBE_DRAIN_ENABLED=1` ortam bayrağı yalnızca geliştirici geçersiz kılmasıdır; kurulu uygulamada gerekmez.
11. [ ] **Kanıtın yenilenmesi:** 30 günlük kanıt dolarsa `List-Unsubscribe-Post` ve canlı gönderim durur. Düzenli çekme açıkken ve uygulama açıkken kanıt **25 günden eskiyse kendiliğinden** yeniden doğrulanır (başarısızsa saatte bir yeniden denenir). Uygulama uzun süre kapalı kaldıysa veya çekme kapalıysa **Doğrula** elle yapılır. Kanıtın bitmesine 5 gün kala, bittiğinde, doğrulama başarısız olduğunda, kuyruk 24 saattir denetlenmediğinde veya kanal anahtarı okunamadığında kampanya ve uyum sayfalarının üstünde **uyarı bandı** çıkar (yalnızca uygulama içinde; işletim sistemi bildirimi yok).

Gerçek Gmail ile tek tıklamalı çıkış denemesi bu aşamada **yapılmaz**; gerçek bir ileti gönderilmesini gerektirir (Aşama 3).

### 3.3 Aşama 3 — Son: hukuki onaylar ve pilot [GÖNDERİM] [SÜRÜM] [ANAHTAR] [BELİRSİZ]

Önkoşul: Aşama 1 ve 2 kanıtlı; madde 15 (DNS), 24 ve 25; `feat/golive-prep` ana dalda; imzalı macOS sürümü (C5c).

1. [ ] **Yazılı hukuki onaylar** (madde 24; `09` Bölüm 6). Belgeler bu depoda saklanmaz; yalnızca referansları kaydedilir.
2. [ ] **DNS:** DMARC `p=quarantine` veya `p=reject`; üç denetim taze ve `pass` (`09` Bölüm 5).
3. [ ] **Kapı açma sürümü** [SÜRÜM]: `LEGAL_APPROVALS` ve `LIVE_SENDING_ENABLED` değerlerini onay referanslarıyla değiştiren, bunları `false` olarak sabitleyen testleri güncelleyen ve `09` Bölüm 9 kanıt referanslarını yazan **tek, incelenmiş** bir sürüm. Ortam değişkeni veya ayar bunun yerine geçmez.
4. [ ] **Canlı ülke onayı** [SÜRÜM]: yalnızca onaylı ülkeler için, kayıtlı bir sürüm sırasında, repo kökünden ve uygulama kapalıyken. Önce plan (hiçbir şeyi değiştirmez), sonra aynı değerlerle `--apply`:
   `npx tsx scripts/approve-live-country.ts --db <veritabanı dosyası> --countries GB,FR --mode allowed --approval-ref "<referans>" --approved-by "<ad>"` (`--mode generic_only` da olabilir). `--db` zorunludur (ortam değişkeni ve varsayılan yol kullanılmaz). Betik `LEGAL_APPROVALS.liveCountryPolicies` kodda `true` değilse **reddeder**; bütün ülkeler ve denetim kayıtları (`country_policy.live_approved`) tek işlemde yazılır. Uygulamanın politika ekranı canlı satırları değiştiremez; satırların açılması tek başına gönderim değildir.
5. [ ] **Gönderim bağlantısı** [GÖNDERİM]: Gmail kutusuyla bir kampanyanın oluşturulup başlatılabildiği; kapı kapalıyken davranışın değişmediği.
6. [ ] **Pilot:** ilk hafta günde **≤ 20** ileti, yalnızca yetkilendirilmiş test alıcılarına (madde 25). Bu sırada `09` Bölüm 2'nin gerçek gönderim isteyen maddeleri (`Message-ID` yeniden yazımı, `List-Unsubscribe` başlıklarının korunması, Gmail hata zarfları, kota yanıtları) ve gerçek Gmail tek tıklamalı çıkışı doğrulanır.
7. [ ] **Günlük gözlem:** bounce, yanıt, çıkış talepleri, kuyruk sağlığı, uyarı bandı. Beklenmeyen davranışta gönderim elle durdurulur ve nedeni kaydedilir (`09` Bölüm 7).
   - **Belirsiz gönderim** [BELİRSİZ]: **Kampanyalar → İnceleme bekleyenler**. Karar vermeden önce gönderen kutunun Gmail **Gönderilmiş** klasörüne bakın. İletiyi orada görüyorsanız **"Gönderildi"**; emin değilseniz **"Gönderimi durdur"** (en güvenli seçenek; dizi bu alıcı için durur); **"Gönderilmedi"** yalnızca iletinin gitmediği kesinse (adımı yeniden açar, yanlışsa alıcıya **kopya** gider; ayrıca onay ister).
   - **Hariç tutulan alıcılar:** kampanya alıcıları bir nedenle (posta kutusu, firma profili, doğrulama vb.) hariç tutulduysa ve neden giderildiyse kampanya kuyruğunda **"Hariç tutulanları yeniden denetle"** kullanılır; filtreyle eklemede kalan işletmeler **"Sıradaki {n} işletmeyi ekle"** ile sayfa sayfa eklenir.

> **Tavuk-yumurta sorunu (C11 ile çözüldü):** `09` Bölüm 2'deki bazı maddeler gerçek gönderim gerektirir. Kapılar açılmadan önce **Gönderim günlüğü → Sağlık → "Kendime gerçek test e-postası gönder (Gmail)"** ile bağlı ve gönderim izinli Gmail kutusundan **yalnızca kutunun kendi adresine** gerçek bir e-posta gönderilir (başka alıcı seçilemez; adres birebir eşleşmezse ileti oluşturulmaz ve Gmail bağdaştırıcısı istek atmadan reddeder). `LIVE_SENDING_ENABLED` ve `LEGAL_APPROVALS`'tan bağımsızdır; firma profili geçerli olmalıdır. Gerçek MIME/alt bilgi kod yolunu kullanır; konu ve alt bilgi "[TEST]" işaretlidir. Çıkış uç noktası doğrulanmışsa gerçek `List-Unsubscribe` + `List-Unsubscribe-Post` başlıkları (alıcıya bağlı olmayan sınama belirteciyle; düğmeye basmak kendi adresinizi engellemez) eklenir, değilse başlık yoktur. Kutu başına saatte ve günde en fazla 10; belirsiz sonuç yeniden gönderilmez, inceleme kuyruğuna düşer. Kampanya gönderimi bu yoldan GEÇMEZ.

## 4. Uygulamanın yönettiği anahtarlar ve özetler (kimse bir şey girmez)

| Ne | Nasıl üretilir | Nerede durur | Not |
|---|---|---|---|
| Ana anahtar | 32 bayt rastgele; işletim sistemi anahtarlığıyla şifrelenir | `master.key.enc` (uygulama veri klasörü) | Gizli depoyu (AES-256-GCM) açar. Çözülemezse uygulama sessizce yenisini **üretmez**: engelleyici pencere ("Uygulamayı kapat", "Tekrar dene", "Veri klasörünü göster", "Gizli bilgileri sıfırla…"); sıfırlama ikinci onay ("Sıfırla ve devam et") ister ve `master.key.enc` ile `secrets.json` `.bak-<zaman>` adıyla saklanır (Bölüm 5) |
| Gizli depo | Ana anahtarla AES-256-GCM | `secrets.json` | Google/Hunter anahtarları, OAuth istemci sırrı, yenileme belirteçleri, imza ve kanal özel anahtarları |
| Çıkış belirteci imza anahtarı | Ed25519; anahtar kimliği (`kid`) = ham genel anahtarın SHA-256 özetinin ilk 16 onaltılık karakteri | Özel anahtar gizli depoda; yalnızca genel anahtar aktarıcıya gider | Belirteç biçimi `u2.<yük>.<imza>`, varsayılan ömür 180 gün |
| Kanal anahtarı | Ed25519 | Aynı | Aktarıcıdan çekme/onay isteklerini imzalar; imza girdisi gövdenin `sha256` özetini içerir; ±5 dk saat farkı |
| Alıcı etiketi (`r`) | Ana anahtardan HKDF ile türetilen anahtarla HMAC-SHA256 | Belirtecin içinde | Ana anahtar değişirse eski etiketler tutmaz; çıkış yine de belirtecin işaret ettiği kampanya alıcısına uygulanır ve `unsubscribe.recipient_tag_mismatch` denetim kaydı yazılır |
| Engel ve alıcı özeti | Normalleştirilmiş adresin düz SHA-256 özeti (ek gizli değer yok) | Veritabanı | Engel listesi açık adres tutmaz |
| Silme yer tutucusu | `sha256("um-erased-v1:" + rastgele 128 bit)` | Veritabanı | Başka bir adresle eşleşmez |
| PKCE | S256 | Bellek (10 dk) | OAuth akışı başına |
| OAuth yenileme belirteci | Google verir | Yalnızca gizli depoda | Veritabanında yalnızca adı ve izin özeti |

## 5. Canlı öncesi bilinen riskler

| Risk | Etkisi | Önlem / paket |
|---|---|---|
| İmzasız macOS paketi güncellemede ana anahtarı anahtarlıktan okuyamayabilir | "Ana anahtar açılamadı" penceresi; sıfırlanırsa API anahtarları, Gmail bağlantısı ve çıkış imza/kanal anahtarları yeniden kurulmalı. **Çıkış talepleri kaybolmaz** (etiket uyuşmazlığında çıkış uygulanır, ayrıca denetim kaydı) | Aşama 1/9 denemesi; imzalı ve kararlı kimlikli sürüm (C5c, açık). Pencerede önce "Tekrar dene"; sıfırlamadan sonra aşağıdaki adımlar |
| Hazırlık kartı yalnızca gösterimdir | DMARC `p=none` kartı "tamam" yapmaz ama gönderimi de durdurmaz | Aşama 3/2'de DNS ayrıca kontrol edilir |
| OAuth akışı uygulamanın açık kalmasına bağlı | Uygulama kapanırsa (port değişir) bekleyen yetkilendirme kaybolur; akış baştan başlar | Aşama 1/5'teki talimat; sonuç hem tarayıcıda hem uygulamada görünür (C12) |
| Uç nokta kanıtı 30 günde düşer; başarısız yeniden doğrulama kanıtı hemen düşürür | Canlı gönderim için çıkış bağlantısı hazırlanamaz ve gönderim durur | Düzenli çekme açıkken 25. günde kendiliğinden yeniden doğrulama (başarısızsa saatte bir); kampanya/uyum sayfalarında uyarı bandı (bitiyor, bitti, doğrulanamadı). Uygulama kapalıysa elle **Doğrula** |
| Düzenli çekme kapalı veya çalışmıyor | Çıkış talepleri aktarıcıda birikir, uygulamaya ulaşmaz | Canlı **kampanya** gönderimi kendiliğinden ERTELENİR (`unsubscribe_drain_unhealthy`; dizi dışlanmaz, başarısız sayılmaz, 15 dk sonra yeniden denenir): çekme açık VE son 24 saatte sağlıklı kuyruk kaydı yoksa gönderim yok. Hazırlık ekranında "teslimat" maddesi çekme kapalıyken engel. Sağlık kaydı 24 saatten eskiyse uyarı bandı; Aşama 2/10 |
| Uyarılar yalnızca uygulama içinde | Uygulama açılmadıkça uyarı görülmez | E-posta/push veya işletim sistemi bildirimi açık iş (`08` TB-4) |

### 5.1 Gizli bilgiler sıfırlandıysa (ana anahtar penceresinde "Gizli bilgileri sıfırla…" seçildiyse)

Sıfırlama `secrets.json` dosyasını yedeğe alır; içindeki **imza ve kanal özel anahtarları** dahil bütün gizli bilgiler artık okunamaz. Ayar ekranı bunu gösterir (ilgili adımda "özel anahtar okunamıyor"), çekme işi `no_channel_key` sağlık kaydı yazar ve uyarı bandı çıkar; aktarıcıdaki talepler beklemeye devam eder, kaybolmaz. Sırasıyla:

1. Ayarlar → Abonelikten çıkış altyapısı (HTTPS) → "İmza anahtarı" → **Yeni anahtara geç** (eski anahtar emekli kalır; önceden gönderilmiş bağlantılar genel anahtarla doğrulanmaya devam eder).
2. "Kanal anahtarı" → **Yeni anahtara geç** (eski kanal anahtarı iptal edilir).
3. **Anahtar dosyasını indir** ve sunucuya `deploy/relay/README.md` §9'daki gibi yükleyin.
4. **Doğrula** → "Uç nokta doğrulandı." (bekleyen talepler bu sırada çekilir ve işlenir).
5. **Kuyruğu denetle** → "Kuyruk sağlıklı."
6. Places/Maps/Hunter anahtarlarını ve OAuth istemci sırrını yeniden girin; Gmail kutusunu yeniden bağlayın.
