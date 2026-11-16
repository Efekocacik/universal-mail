# Güvenlik ve Gizlilik

**Durum (16 Kasım 2026, Faz 6 paket G; entegrasyon feat/faz-6).** Bu belge uygulamanın güvenlik önlemlerini, dışarıya hangi adreslere ne zaman bağlandığını ve bunların nasıl yeniden doğrulanacağını anlatır. Yalnızca kodla ve testle kanıtlanan şeyler "yapıldı" diye yazılır; kanıtın adı her bölümde verilir. Bir çelişki görürseniz **kod belirleyicidir**. Kullanıcıya yönelik kısa özet **Ayarlar → Güvenlik ve gizlilik** kartıdır (`src/features/settings/privacy-card.tsx`, TR+EN). Kart Ayarlar sayfasında `#security` bölümündedir (gezinme etiketi `settings.nav.security`); `e2e/privacy.spec.ts` kartı arayüzden açıp her hizmet satırını denetler, `tests/privacy-card.test.ts` kartın takılı kaldığını zorunlu tutar.

## 1. Kısa tehdit modeli

| Varlık | Tehdit | Önlem | Kanıt |
|---|---|---|---|
| API anahtarları, OAuth istemci sırrı, Gmail yenileme belirteçleri, abonelikten çıkış imza anahtarları, yedek parolası | Disk/yedek dosyasının kopyalanması, başka bir kullanıcının dosyayı okuması | AES-256-GCM ile şifreli `secrets.json`; ana anahtar işletim sisteminin anahtar zincirinde (Electron `safeStorage`: macOS Keychain, Windows DPAPI); dosya izinleri 0600 | `tests/security-secrets-at-rest.test.ts` |
| Yerel sunucu (Next.js + API) | Aynı ağdaki başka bir cihazın bağlanması | Sunucu yalnızca `127.0.0.1`'e bağlanır (`HOSTNAME=127.0.0.1`) | `tests/security-server-bind.test.ts` |
| Yerel sunucu | Tarayıcıda açık kötü niyetli bir sitenin yerel API'yi çağırması (CSRF, DNS yeniden bağlama) | `src/middleware.ts`: Host yalnızca yerel ad; durum değiştiren isteklerde Origin = Host; `/api/` altındaki başka siteden gelen istekler (GET dahil) 403 (yalnızca Gmail OAuth geri çağrısı hariç) | `tests/security-route-guard.test.ts` (tüm uç dosyaları taranır) |
| Uygulama penceresi (Electron) | Dış sayfaya gezinme, yeni pencere, `<webview>`, izin istekleri, geliştirici araçları | `electron/hardening.ts` | `tests/electron-hardening.test.ts` |
| Arayüz | Betik enjeksiyonu, veri sızdırma | İçerik güvenliği politikası (CSP) ve güvenlik başlıkları (`next.config.ts`), e-posta önizlemesi kendi katı CSP'si olan `srcdoc` çerçevesinde | `tests/security-server-bind.test.ts`, `e2e/privacy.spec.ts` |
| Kullanıcının ve lead'lerin verisi | Geliştiriciye/telemetriye/üçüncü tarafa veri gitmesi | Telemetri, hata raporlama, otomatik güncelleme denetimi YOK; dış bağlantılar yalnızca kullanıcının açtığı hizmetlere | `tests/egress-allowlist.test.ts`, `tests/egress-guard.test.ts`, `e2e/privacy.spec.ts` |
| Bağımlılıklar | Bilinen açıklar | `npm audit` (Bölüm 7) | bu belge |

Kapsam dışı: bilgisayarın kendisinin ele geçirilmesi (yönetici hakkıyla çalışan kötü amaçlı yazılım anahtar zincirini de okuyabilir), uygulamanın kod imzası (Faz 6 açık kalemi: sertifika kullanıcının kararı).

## 2. Anahtar saklama

- `secrets.json` (veri klasöründe) her değeri AES-256-GCM ile ayrı IV ve doğrulama etiketiyle şifreler (`src/lib/secrets/store.ts`). Dosya 0600 izniyle, geçici dosya + yeniden adlandırma ile atomik yazılır.
- **Ana anahtar:** Electron'da `<userData>/master.key.enc` dosyasındadır ve işletim sisteminin anahtar zinciriyle (`safeStorage`) şifrelenmiştir; alt süreçlere yalnızca ortam değişkeniyle (`UM_MASTER_KEY`) geçer, diske düz yazılmaz. `UM_REQUIRE_MASTER_KEY=1` iken anahtar yoksa depo **açılmaz** (sessizce yeni anahtar üretilmez). Geliştirme kipinde anahtar `.data/master.key` dosyasındadır.
- Kopyalanan bir `secrets.json` başka bir bilgisayarda (ya da başka bir kullanıcı hesabında) çözülemez. Şifreli yedekler gizli bilgileri kendi parolalarıyla ayrıca şifreler (Faz 6 paket Y).
- API uçları gizli değerleri **hiçbir zaman** döndürmez: `GET /api/secrets` ve `GET /api/settings` yalnızca "var/yok" ve maskeli gösterim verir; yedek parolası maskeli bile dönmez.
- **Kanıt:** `tests/security-secrets-at-rest.test.ts` her gizli bilgi türünü (Google anahtarları, Hunter/Snov/Claude/sicil anahtarları, OAuth istemci sırrı, yenileme belirteci, abonelikten çıkış imza ve kanal anahtarları, yedek parolası) gerçek yollardan yazar, sonra veri klasöründeki **her dosyayı** (veritabanı, WAL, oturum önbelleği, secrets.json, yedekler) düz metnin UTF-8 ve UTF-16 baytları için tarar; 0600 iznini (POSIX) ve ana anahtar yokken deponun açılmadığını denetler.

## 3. Yerel sunucu: bağlama adresi ve istek koruması

- Next sunucusu ve işçi yalnızca `127.0.0.1`'de dinler: Electron `childEnv()` (`electron/child-env.ts`) `HOSTNAME=127.0.0.1` ve `NEXT_TELEMETRY_DISABLED=1` verir; boş bağlantı noktası da yalnızca `127.0.0.1`'de aranır. E2E sunucusu aynısını yapar.
- `src/middleware.ts` (tek merkezî koruma; uçlara ayrı kopya eklenmez):
  - Host başlığı `127.0.0.1`, `localhost` veya `[::1]` değilse 403 (DNS yeniden bağlama).
  - POST/PUT/PATCH/DELETE: Origin başlığı yoksa, ayrıştırılamıyorsa (`null`, `file:`) ya da Host ile aynı değilse 403 (CSRF). Aynı makinede **başka bir bağlantı noktası** da yabancı sayılır.
  - `Sec-Fetch-Site` `cross-site` **veya** `same-site` olan her `/api/` isteği 403. (`same-site` Faz 6'da eklendi: aynı bilgisayarda başka bir bağlantı noktasında çalışan bir sayfa tarayıcıya göre "aynı site"dir ama uygulama değildir.) Tek istisna Google'ın yönlendirdiği `/api/oauth/gmail/callback`.
  - Ret yanıtı `{ error, code: "FORBIDDEN" }`.
- **Kanıt:** `tests/security-route-guard.test.ts` `src/app/**/route.ts` dosyalarını tarar (sabit liste yok; sonradan eklenen uç kendiliğinden kapsanır): eşleştirici her yolu kapsar; her durum değiştiren yöntem yabancı Host, kökensiz, yabancı/bozuk köken, `cross-site`/`same-site` ile 403, kendi kökeniyle geçer; her `/api/` GET'i başka siteden 403; her dışa açık işleyici `route()` ailesiyle sarılı (gerekçeli iki istisna: açılma pikseli, OAuth geri çağrısı); gövde okuyan her durum değiştiren işleyici zod ile doğrular; yeni satır içi gövde şemaları `.strict()` olmalıdır (Faz 6 öncesinden kalan dört gevşek şema listelenmiştir; zod bilinmeyen alanları atar ve işleyiciler alanları tek tek okur).

## 4. Electron ayarları

`electron/hardening.ts` (birim testi: `tests/electron-hardening.test.ts`, sahte WebContents/Session ile):

- **Pencere:** `webPreferences: { preload, ...secureWebPreferences(app.isPackaged) }` (main.ts `createWindow`): `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (alt çerçeve ve işçilerde de), `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `spellcheck: false`, `navigateOnDragDrop: false`, `safeDialogs: true`, paketli uygulamada `devTools: false`. Ayrıca `app.whenReady()`'den önce `app.enableSandbox()` çağrılır (tüm görüntüleyiciler kum havuzunda). Aynı korumalar aşağıda oturum/olay düzeyinde de uygulanır (çifte güvence). Kanıt: `tests/electron-hardening.test.ts` (main.ts statik denetimi + yardımcının birim testi).
- **Yeni pencere** hiçbir zaman açılmaz: dış `http(s)` bağlantısı (kimlik bilgisi içermeyen) varsayılan tarayıcıda açılır; `file:`, `javascript:`, `data:`, özel şemalar (`smb:`, `ms-settings:`…) düşürülür.
- **Gezinme** (`will-navigate`) ve **yönlendirme** (`will-redirect`) yalnızca uygulamanın yerel kökenine; pencereye sürüklenen dosya (`file:`) da engellenir. Günlüğe yalnızca şema ve ana bilgisayar yazılır (yol/sorgu/kişisel veri yazılmaz).
- `<webview>` eklenemez (`will-attach-webview`).
- **Geliştirici araçları** paketli uygulamada açıldığı anda kapatılır; menüdeki "Geliştirici araçları" yalnızca paketlenmemiş çalıştırmada vardır.
- **Oturum:** tüm izin istekleri ve izin denetimleri reddedilir (kamera, mikrofon, konum, bildirim izni, MIDI, pano okuma, USB/HID/seri…); tek istisna yerel sayfanın panoya **yazması** ("kopyala" düğmeleri). Aygıt izinleri reddedilir.
- **Yazım denetimi kapalı** ve sözlük indirme adresi yerel, kapalı bir bağlantı noktasına çevrilir: Chromium aksi hâlde Windows'ta sözlükleri Google'ın sunucusundan indirir (NFR-01).
- Önceden de vardı: tek örnek kilidi, `um:*` IPC kanalları yalnızca yerel kökenden gelen çağrıyı kabul eder.

## 5. İçerik güvenliği politikası ve başlıklar

`next.config.ts` her yanıta şu başlıkları ekler; CSP yalnızca üretim derlemesindedir (`next dev` sıcak yeniden yükleme için `eval` kullanır):

- `Content-Security-Policy`: `default-src 'self'`; kendi kökenimiz dışındaki her kaynak Google Maps JavaScript API içindir ve Google'ın Maps için belgelediği **izin listesi CSP'sinin** (developers.google.com/maps/documentation/javascript/content-security-policy) Maps kısımlarıyla birebir aynıdır: `script-src 'unsafe-eval' blob: https://*.googleapis.com https://maps.gstatic.com https://*.ggpht.com https://*.google.com`; `img-src` Google görsel alanları ve `data:`/`blob:`; `connect-src https://*.googleapis.com https://*.google.com https://*.gstatic.com data: blob:`; `frame-src https://*.google.com` (Maps'in kendi iç çerçeveleri; başka çerçeve kaynağı yok); `font-src https://fonts.gstatic.com`; `style-src 'unsafe-inline' https://fonts.googleapis.com`; `worker-src blob:` (vektör harita ve gelişmiş işaretçiler, `mapId`). Ayrıca `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.
  - `'unsafe-inline'` Next'in satır içi önyükleme betikleri, `'unsafe-eval'` ve `blob:` Google Maps JavaScript API'si için gereklidir. Asıl kazanç veri sızdırma yollarının (connect/img/frame/form/base) kendi kökenimizle ve Google ile sınırlanmasıdır. Maps yalnızca kullanıcı bir harita anahtarı girdiğinde yüklenir.
  - **Sınır:** anahtarlı harita bu CSP altında hiçbir otomatik testte yüklenmez (testler gerçek Google'a bağlanmaz; gizlilik denetimi demo kipindedir). `tests/security-server-bind.test.ts` Google'ın izin listesindeki her kaynağın CSP'de olduğunu denetler; gerçek doğrulama açık kalemdir (Bölüm 9).
- `Referrer-Policy: no-referrer` (dış bağlantılara adres sızmaz), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` (kamera, mikrofon, konum, USB, seri, HID, Bluetooth kapalı).
- Abonelikten çıkma sayfası (`/u/[token]`) kendi formunu kendi kökenine gönderir (`form-action 'self'` ile uyumlu); açılma pikseli bir GIF döndürür.
- **Kanıt:** `tests/security-server-bind.test.ts` başlıkları yapılandırmadan okur ve Google'ın Maps izin listesi CSP'sinin her kaynağını arar; `tests/egress-allowlist.test.ts` CSP'deki her dış kaynağın izin listesinde ve Google Maps hizmetine bağlı olduğunu denetler; `e2e/privacy.spec.ts` üretim derlemesinde (CSP etkin) bütün ekranları demo kipinde dolaşır ve CSP ihlali olmadığını denetler (Maps yüklenmez; yukarıdaki sınıra bakın).

## 6. Dış bağlantılar (gizlilik, NFR-01)

Kural: **geliştiriciye, telemetriye veya analiz/hata izleme hizmetine giden hiçbir bağlantı yoktur.** Uygulama yalnızca

1. kullanıcının kendi anahtarı/hesabıyla açtığı hizmetlere,
2. işin doğası gereği çalışma anında belirlenen adreslere (işletmelerin web siteleri, DNS, RDAP sunucuları, kullanıcının kendi aktarıcısı)

bağlanır; "bağlantı" türündeki adresler yalnızca kullanıcı tıklarsa varsayılan tarayıcıda açılır. **Demo kipinde ve temiz açılışta hiçbir dış bağlantı yapılmaz.**

### 6.1 Hizmetler ve ne zaman bağlanıldığı

| Hizmet | Ne zaman | Açan |
|---|---|---|
| Google Places (`places`) | Google modunda tarama, işletme ayrıntısı yükleme, anahtar sınaması | Kurulum sihirbazı / Ayarlar → Google; kullanıcının API anahtarı |
| Google Maps (`maps`) | Keşfet haritası açıkken (tarayıcıda) | Ayarlar → Google; harita (tarayıcı) anahtarı girilmişse |
| Gmail (`gmail`) | Hesap bağlama (OAuth), gönderim, gelen kutusu/yanıt denetimi, bağlantıyı kaldırma | Ayarlar → Posta kutuları; kullanıcının OAuth istemcisi |
| Hunter / Snov.io (`hunter`, `snov`) | E-posta bulma sırasında, anahtar girilmişse | Ayarlar → Anahtarlar |
| Claude (`anthropic`) | Yapay zekâ ile kişisel giriş üretimi açıksa | Ayarlar → Yapay zekâ |
| Companies House / INSEE (`companiesHouse`, `insee`) | Sicil taraması (Google modunda, anahtarla) | Sicil sayfası |
| RDAP (`rdap`) | Alan adı yaşı denetimi açıksa: IANA önyükleme dosyası + alan adının RDAP sunucusu; yalnızca alan adı gönderilir | Ayarlar → Yenilik |
| İşletme web siteleri (`websites`) | E-posta bulma: lead'in kendi sitesi; yerel/özel ağ adresleri engelli (`src/lib/email/safe-fetch.ts`) | Keşfet → E-posta bul |
| DNS (`dns`) | E-posta alan adı MX denetimi, gönderim hesabının SPF/DKIM/DMARC denetimi | E-posta bulma / Posta kutusu sağlığı |
| Abonelikten çıkma aktarıcısı (`relay`) | Aktarıcı adresi girilmişse, çıkma isteklerini almak için (kullanıcının kendi Cloudflare Worker'ı veya sunucusu) | Ayarlar → Abonelikten çıkma |

### 6.2 Adres envanteri

Kaynak: `src/lib/net/egress-allowlist.ts`. `tests/egress-allowlist.test.ts`: `src/` ve `electron/` altındaki **her** URL sabitinin (`http(s)://…`) ve ana bilgisayar benzeri bir ada (`host`, `hostname`, `domain`, `origin`, `endpoint`, `server`, `baseUrl`, `apiBase`, `API_HOST`…) atanan her çıplak ana bilgisayar sabitinin (`"api.ornek.com"`) listede **tam** karşılığı vardır. Kaynak sabitleri için joker kabul edilmez: Google jokerleri (`*.googleapis.com` vb.) yalnızca CSP içindir, örnek jokerleri yalnızca hiçbir zaman çözülmeyen ayrılmış adlarda (`*.example`, `*.invalid`, `*.example.com`; RFC 2606) geçerlidir. Böylece kodda sabit yazılmış bir geliştirici aktarıcısı (`x.workers.dev`) ya da Google günlük/telemetri adresi "harita" veya "örnek" diye geçemez. Sınır: birleştirmeyle kurulan adresler (`"https://" + HOST`) ancak `HOST` yukarıdaki biçimde bir sabitse yakalanır; çalışma anında hesaplanan adresler gizlilik denetimiyle (6.3) denetlenir. Ayrıca listede geliştirici/telemetri adresi yoktur; ağ modüllerini (`node:dns`, `node:net`, `node:http(s)`, `node:tls`…) yalnızca `src/lib/email/safe-fetch.ts`, `src/lib/email/verify.ts`, `src/lib/mail/dns-check.ts` ve `electron/main.ts` (yalnızca 127.0.0.1) içe aktarır; bu tablo listedeki her adresi içerir. Yeni bir dış hizmet eklendiğinde önce izin listesine, Ayarlar kartının metnine (`src/lib/i18n/{tr,en}/security.ts`) ve bu tabloya eklenmelidir; aksi hâlde test kırılır.

| Adres | Tür | Hizmet | Açıklama |
|---|---|---|---|
| `places.googleapis.com` | Sizin açtığınız hizmet | places | Places API (New) |
| `maps.googleapis.com` | Sizin açtığınız hizmet | maps | Maps JavaScript API |
| `*.googleapis.com` | Sizin açtığınız hizmet | maps | Harita döşemeleri ve Maps JS kaynakları (CSP) |
| `maps.gstatic.com` | Sizin açtığınız hizmet | maps | Maps JS betikleri |
| `*.gstatic.com` | Sizin açtığınız hizmet | maps | Harita görselleri ve yazı tipleri (CSP) |
| `*.google.com` | Sizin açtığınız hizmet | maps | Harita görselleri (CSP) |
| `*.ggpht.com` | Sizin açtığınız hizmet | maps | Harita görselleri (CSP) |
| `*.googleusercontent.com` | Sizin açtığınız hizmet | maps | Harita görselleri (CSP) |
| `fonts.googleapis.com` | Sizin açtığınız hizmet | maps | Maps JS yazı tipi stili (CSP) |
| `fonts.gstatic.com` | Sizin açtığınız hizmet | maps | Maps JS yazı tipi (CSP) |
| `gmail.googleapis.com` | Sizin açtığınız hizmet | gmail | Gmail API (gönderim, gelen kutusu) |
| `oauth2.googleapis.com` | Sizin açtığınız hizmet | gmail | OAuth belirteç alma ve iptal |
| `accounts.google.com` | Sizin açtığınız hizmet | gmail | OAuth onay sayfası (tarayıcıda) |
| `www.googleapis.com` | Sizin açtığınız hizmet | gmail | OAuth imza anahtarları ve izin kapsamı adları |
| `api.hunter.io` | Sizin açtığınız hizmet | hunter | Hunter e-posta bulma |
| `api.snov.io` | Sizin açtığınız hizmet | snov | Snov e-posta bulma |
| `api.anthropic.com` | Sizin açtığınız hizmet | anthropic | Claude (tanıtım metni) |
| `api.company-information.service.gov.uk` | Sizin açtığınız hizmet | companiesHouse | Companies House (Birleşik Krallık sicili) |
| `api.insee.fr` | Sizin açtığınız hizmet | insee | INSEE Sirene (Fransa sicili) |
| `data.iana.org` | Sizin açtığınız hizmet | rdap | RDAP önyükleme dosyası (TLD → RDAP sunucusu) |
| `(RDAP sunucusu)` | Çalışma anında belirlenir | rdap | Alan adının kayıt kuruluşu RDAP sunucusu (IANA listesinden) |
| `(işletme web sitesi)` | Çalışma anında belirlenir | websites | Lead'in kendi web sitesi (güvenli okuyucu: yerel/özel ağ adresleri engelli) |
| `(DNS çözümleyici)` | Çalışma anında belirlenir | dns | İşletim sisteminin DNS sunucusu (MX, SPF/DKIM/DMARC) |
| `(çıkış aktarıcısı)` | Çalışma anında belirlenir | relay | Sizin girdiğiniz çıkış aktarıcısı adresi |
| `www.google.com` | Yalnızca tıklarsanız (tarayıcıda) | – | Google Haritalar'da göster |
| `cloud.google.com` | Yalnızca tıklarsanız (tarayıcıda) | – | Google Maps Platform şartları |
| `developers.google.com` | Yalnızca tıklarsanız (tarayıcıda) | – | Google Places politika belgeleri |
| `www.rfc-editor.org` | Yalnızca tıklarsanız (tarayıcıda) | – | RDAP istemci tanıtımı (User-Agent içinde, bağlanılmaz) |
| `www.facebook.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `www.instagram.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `www.linkedin.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `x.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `www.tiktok.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `www.youtube.com` | Yalnızca tıklarsanız (tarayıcıda) | – | İşletmenin sosyal medya bağlantısı |
| `www.w3.org` | Hiç bağlanılmaz (örnek/yer tutucu) | – | SVG XML ad alanı |
| `firma.com` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek alan adı |
| `cikis.firma.com` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek çıkış aktarıcısı adresi |
| `cikis.firmaniz.com` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek çıkış aktarıcısı adresi (Ayarlar ipucu) |
| `unsubscribe.yourcompany.com` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek çıkış aktarıcısı adresi (İngilizce ipucu) |
| `um-relay.hesabiniz.workers.dev` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek Cloudflare Worker adresi (Türkçe ipucu) |
| `um-relay.youraccount.workers.dev` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek Cloudflare Worker adresi (İngilizce ipucu) |
| `*.example` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Demo verisi ve örnekler (.example ayrılmış, RFC 2606) |
| `*.example.com` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Örnek adres (example.com ayrılmış, RFC 2606) |
| `*.invalid` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Geçersiz adres (.invalid ayrılmış, RFC 2606) |
| `ana.makine` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Açıklamada örnek ana bilgisayar |
| `host` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Açıklamada örnek ana bilgisayar |
| `başka` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Açıklamada örnek ana bilgisayar (aktarıcı) |
| `127.0.0.1` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Bu bilgisayar (yerel sunucu) |
| `localhost` | Hiç bağlanılmaz (örnek/yer tutucu) | – | Bu bilgisayar (yerel sunucu) |

### 6.3 Gizlilik denetimini yeniden çalıştırma

```bash
npm run build
npx playwright test e2e/privacy.spec.ts
```

`e2e/privacy.spec.ts` kendi yalıtılmış sunucusunu açar (`e2e/helpers/isolated-server.mjs`: geçici veri klasörü, ayrı bağlantı noktası, kullanıcının ortam değişkenleri/anahtarları taşınmaz). Migrasyon, web sunucusu ve işçi `scripts/egress-guard.cjs` ile (`NODE_OPTIONS=--require`, `UM_EGRESS_MODE=block`) çalışır: bekçi `net.Socket.connect` (http, https, tls ve `fetch`), `dns.lookup`, `dns.resolve*`/`Resolver` ve UDP gönderimini yakalar; yerel olmayan her denemeyi **ağa çıkmadan** reddeder ve `egress.jsonl`'e yazar. Akış: temiz açılış → kurulum sihirbazı (demo) → gösterge paneli → demo tarama → Keşfet listesi/harita → lead ayrıntısı → e-posta bulma ve elle e-posta ekleme → taramalar, şablonlar, kampanyalar, gönderim günlüğü, uyum → Ayarlar'ın her bölümü → işçinin arka plan işleri. Son adımda sabit bir süre beklenmez: açılış bakım turu boş veritabanında çalıştığı için RDAP (alan adı yaşı) ve yer kimliği yenileme demo veriyle yeniden tetiklenir; test iş kuyruğunu (yalıtılmış veri klasöründeki veritabanı, salt okuma) okuyup zamanı gelmiş hiçbir işin kuyrukta/çalışır durumda kalmadığını, `places.refresh_ids`, `places.watch_future` ve `novelty.rdap` işlerinin **bittiğini** (`done`; yer kimliği ve RDAP için açılış + elle tetiklenen tur), RDAP'nin demo alan adlarını gerçekten denetlediğini ve hiçbir işin başarısız olmadığını görene kadar bekler; bekçi kaydı ancak ondan sonra okunur. Beklenen sonuç: bekçi kaydı **boş**, tarayıcının gördüğü her istek `http://127.0.0.1:<port>`, `data:` veya `blob:`, CSP ihlali yok. Son adım pozitif kontroldür: Google modu + sahte anahtarla "anahtarı sına" çağrılır ve bekçinin `places.googleapis.com` denemesini engelleyip kaydettiği görülür (denetimin gerçekten etkin olduğunun kanıtı).

Bekçinin kendisi: `tests/egress-guard.test.ts` (ayrı süreçte; yerel `fetch` geçer, dış `fetch`/`https.get`/TCP/DNS/UDP engellenir ve kaydedilir; gerçek ağa çıkılmaz). UDP gönderiminde bağımsız değişkenler Node'un imzasıyla ayrıştırılır (ileti hiçbir zaman adres sayılmaz ve kaydedilmez; bağlı sokette hedef `remoteAddress()`); IP sabitinin "çözümlenmesi" (ağa çıkmaz) ve `::ffff:127.*` yerel sayılır.

**Kapsam sınırı.** Bu denetim Node süreçlerini (sunucu, işçi, migrasyon) ve görüntüleyiciyi (Playwright'ın Chrome'u) kapsar. **Electron ana süreci ve Chromium'un kendi arka plan hizmetleri** (yazım denetimi sözlüğü, `shell.openExternal` yolları vb.) burada çalışmaz; onlar yalnızca sahte oturumla birim testindedir (`tests/electron-hardening.test.ts`). "Uygulama internete hiç bağlanmaz" önermesinin paketli uygulama için kanıtı temiz makine denemesidir (Bölüm 9).

## 7. npm audit

16 Kasım 2026, `npm audit` ve `npm audit --omit=dev`:

- **Çalışma zamanı bağımlılıkları (`--omit=dev`): 0 açık.** Paketlenen uygulamaya giren hiçbir pakette bilinen açık yok.
- `npm audit fix` (`--force` olmadan, yalnızca `package-lock.json`; `package.json` değişmedi) uygulandı. Kapananlar: **electron 44.9.0 → 44.11.3** (yüksek: GHSA-jr5w-w6x2-84p9, ele geçirilmiş eMudhra ara sertifikalarına karşı önlem; paketlenen Electron çalışma zamanı), `fast-uri` 3.1.8 → 3.1.9 (orta; eslint/ajv üzerinden, yalnızca geliştirme), `@typescript-eslint/*` 8.71.2 → 8.73.0 (minimatch; yalnızca geliştirme), electron-builder 26.15.3 → 26.18.1 ailesi (yama sürümleri). 17 bulgudan 7'si kapandı.
- Kalan 10 bulgu (hepsi orta, hepsi **yalnızca geliştirme/derleme aracı**, hiçbiri uygulamayla dağıtılmaz):

| Paket | Önem | Yol | Çalışma zamanı mı? | Neden düzeltilmedi | Eylem |
|---|---|---|---|---|---|
| `esbuild` ≤ 0.24.2 (GHSA-67mh-4wv8-2f99) | orta | `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild@0.18.20` | Hayır (yalnızca `drizzle-kit` migrasyon üretimi) | Açık esbuild'in geliştirme sunucusundadır; drizzle-kit bunu çalıştırmaz. npm'in önerdiği düzeltme drizzle-kit'i 0.18.1'e **indirmek** (kırıcı) | Kabul; drizzle-kit `@esbuild-kit`'i bıraktığında güncellenir |
| `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit` | orta | yukarıdaki zincir | Hayır | Aynı | Aynı |
| `minimatch` 7.0.0–11.0.0 (GHSA-g3hv-75wg-m249, ReDoS) | orta | `electron-builder` → `app-builder-lib` → `minimatch@10.2.6`; `@electron/universal` → `minimatch@9.0.9` | Hayır (yalnızca paketleme sırasında, kendi yapılandırma desenlerimizle) | Düzeltme electron-builder'ı 25.1.0'a **indirmeyi** öneriyor (kırıcı) | Kabul; electron-builder minimatch ≥ 11.0.1'e geçince güncellenir |
| `app-builder-lib`, `dmg-builder`, `electron-builder`, `electron-builder-squirrel-windows`, `@electron/universal` | orta | yukarıdaki zincir | Hayır | Aynı | Aynı |

## 8. Performans (NFR-03: 100.000 lead'de < 300 ms)

- Veri: `tests/helpers/seed-leads.ts` (belirlenimci, 100 000 lead; 8 şehir, 7 tür, iki tarama, %40 e-posta, %60 zenginleştirme, %30 önbellek, %1 sicil; yalnızca `firma.com` örnek alan adları).
- Durumlar (`tests/helpers/perf-cases.ts`): her süzgeç tek başına × üç sıralama (yenilik, ad, en yeni), 12 temsilî birleşim ("tüm süzgeçler birden" dahil), derin sayfa (50 000. kayıt), her süzgeç ve birleşim için süzgeç sayımları (facet), harita noktaları (kutulu/kutusuz), toplu seçim sayısı ve kimlikleri.
- Otomatik test: `tests/perf-100k.test.ts` (normal pakette; her durum bir ısınma + 3 ölçümün ortancası; eşiği aşan durumlar tüm durumlardan sonra en çok iki tur daha ölçülür). Süre eşiği yerelde ve `UM_PERF_STRICT=1` ile **300 ms**; CI'da (`CI` tanımlı: paylaşılan koşucu, kapsam ölçümü açık, paralel test dosyaları) yalnızca kaba gerileme koruması **900 ms** ve 300 ms'yi aşan durumlar `[perf]` satırıyla günlüğe yazılır. CI'ın asıl kapısı süreden bağımsız plan korumalarıdır (aşağıda). İki kip: uygulamanın gerçek durumu (istatistik tablosu yok; uygulama `ANALYZE` çalıştırmaz) ve `ANALYZE` sonrası. Ayrıca süreden bağımsız bir koruma: sorgu planlarında otomatik indeks ve sürücü tablo dışında indekssiz tam tarama yoktur; liste sayfası geniş sütunları yalnızca sayfadaki kimlikler için okur.
- Faz 6 iyileştirmeleri (`src/lib/leads/query.ts`): **geç satır okuma** (sayfa kimlikleri önce yalnızca sıralama anahtarlarıyla seçilir, geniş sütunlar yalnızca o ≤ 500 satır için okunur) ve **tek geçişli süzgeç sayımları** (dört sayım ve toplam tek `GROUP BY` çapraz tablosundan; önceden beş ayrı tam tarama). Yeni indeks gerekmedi.
- Elle ölçüm: `npm run bench` (`BENCH_N=200000` ile kayıt sayısı, `BENCH_NO_ANALYZE=1` ile istatistiksiz). Windows'ta ve macOS'ta aynı komut.

Son ölçüm (16 Kasım 2026, Apple Silicon, `npm run bench`, `ANALYZE` sonrası; aynı anda başka derlemeler çalışırken, yani yük altında): 100 000 kayıt 5,9 sn'de üretildi (65 MB). **132 durumun hepsi < 300 ms**; ortanca 67 ms, en yavaş 266 ms (`liste [tarama] sıra=name`).

| Durum | Süre |
|---|---|
| Liste, süzgeçsiz (yenilik / ad / en yeni) | 68 / 168 / 96 ms |
| Liste, derin sayfa (50 000. kayıt; yenilik / ad) | 169 / 118 ms |
| Süzgeç sayımları (facet), süzgeçsiz | 169 ms |
| Süzgeç sayımları, ülke / şehir / kategori | 64 / 55 / 56 ms |
| En yavaş beş: tarama+ad, tarama+en yeni, sicil eşleşmedi+ad, sicil eşleşmedi+en yeni, tarama+yenilik | 266 / 218 / 217 / 194 / 191 ms |

CI ölçümü henüz yok (dal itilmedi); ilk CI koşusunun `[perf]` satırları buraya eklenecek (Bölüm 9).

Ad sıralaması önbellek veritabanındaki (`gcache.place_cache`) adı da kullandığı için bir indeksle karşılanamaz; eşleşen satırlar sıralanır. Bu yüzden ad sıralı geniş süzgeçler en yavaş durumlardır ve ileride kayıt sayısı 100 000'i çok aşarsa ilk izlenecek yer orasıdır.

## 9. Açık kalemler (paket G)

| Kalem | Neden açık | Kim / ne gerekiyor |
|---|---|---|
| Anahtarlı Keşfet haritasını paketli uygulamada CSP altında doğrulamak | Testler gerçek Google'a bağlanmaz; CSP Google'ın izin listesiyle hizalandı ama gerçek yükleme görülmedi | Kullanıcı: kendi Maps tarayıcı anahtarı ve Map ID'siyle paketli uygulamada Keşfet → harita; geliştirici araçlarında (paketlenmemiş çalıştırma) konsolda `Refused to` olmamalı |
| Paketli uygulamada ağ izleme (temiz makine) | Gizlilik e2e'si Electron ana sürecini ve Chromium arka plan hizmetlerini çalıştırmaz | Temiz makinede demo kipinde aç; Little Snitch (macOS) / Kaynak İzleyicisi → Ağ (Windows) ile dışarı bağlantı olmadığını gör |
| `tests/perf-100k.test.ts` CI ölçümü | Dal henüz itilmedi | İlk CI koşusunda `[perf]` satırlarını Bölüm 8'e işle |

