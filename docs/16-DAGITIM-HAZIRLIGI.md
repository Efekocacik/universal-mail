# Dağıtım hazırlığı: macOS imza/notarization ve Cloudflare Worker (müşteri hesabı)

Bu belge GİZLİ DEĞER içermez ve içermemelidir. Sertifikalar, parolalar, anahtarlar ve belirteçler depoya, pakete veya
sohbete yazılmaz. GitHub deposu ayarlarını Efe yapar.

## 1. macOS imza ve notarization (Efe'nin Apple Developer hesabı)

Durum: yapılandırma hazır (`electron-builder.config.cjs`), sırlar TANIMLI DEĞİL → paket şimdilik **imzasız** üretilir.
İmzasız teslimata kendiliğinden karar verilmez: imza kararı, test edilecek paket üretilmeden ÖNCE verilmelidir
(imzasız test edilip imzalı teslim edilirse dosyalar aynı olmaz).

Efe'nin yapacakları (yerel Mac'inde, M4):

1. Apple Developer hesabında **Developer ID Application** sertifikası oluştur (Xcode → Settings → Accounts → Manage
   Certificates, veya developer.apple.com). Sertifika Anahtarlık'a iner.
2. Anahtarlık Erişimi'nde sertifikayı özel anahtarıyla **.p12** olarak dışa aktar (güçlü bir parolayla). Dosya depoya
   KOYULMAZ ve sohbette paylaşılmaz.
3. https://appleid.apple.com → **Uygulamaya özel parola** oluştur ("universal-mail-notarize").
4. **Team ID**'yi (10 karakter) Apple Developer hesabından al.
5. GitHub → depo → **Settings → Secrets and variables → Actions** altında şu depo sırlarını oluştur:

| Sır | Değer |
| --- | --- |
| `CSC_LINK` | .p12 dosyasının base64 hâli (`base64 -i sertifika.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | .p12 parolası |
| `APPLE_ID` | Apple kimliği (e-posta) |
| `APPLE_APP_SPECIFIC_PASSWORD` | 3. adımdaki uygulamaya özel parola |
| `APPLE_TEAM_ID` | 4. adımdaki Team ID |

6. Sırlar tanımlanınca CI paket işi macOS paketini **imzalar ve notarize eder** (sertleştirilmiş çalışma zamanı,
   `build/entitlements.mac.plist` yetkileri) ve ayrıca `codesign --verify --deep --strict`, `spctl --assess` ve
   `xcrun stapler validate` ile DOĞRULAR; doğrulama başarısızsa iş başarısız olur. Üç Apple değişkeninden biri eksikse
   notarization yapılmaz (yalnızca imza); `HAS_MAC_SIGNING` yalnızca `CSC_LINK` ve `APPLE_ID` tanımlıysa true olur.
7. Hem `mac-arm64` hem `mac-x64` paketleri aynı sertifikayla imzalanır. Windows imzası ayrıdır (`WIN_CSC_LINK`,
   `WIN_CSC_KEY_PASSWORD`; bu belgenin kapsamı dışında, kararı bekliyor).

Gerçek Mac'te doğrulanacaklar: Gatekeeper açılışı (uyarısız), notarization (`spctl -a -vv` "accepted, source=Notarized
Developer ID"), Anahtarlık izin davranışı, güncellemede Anahtarlık sorusu çıkıp çıkmadığı (kararlı kimlik).

## 2. Cloudflare Worker (müşterinin Cloudflare hesabına)

Worker kodu dağıtıma hazırdır: `npm run build:worker` → `dist/cloudflare-worker/worker.js` (tek dosya, Node bağımlılığı
yok). Adım adım panel kurulumu: `deploy/cloudflare-worker/README.md` (komut satırı yolu: aynı dosyanın sonunda).

Bu iş MÜŞTERİNİN hesabında, müşterinin kendisi veya onun açık izniyle yapılır; bu depodan hesap bağlantısı veya
dağıtım YAPILMAZ. Kontrol listesi:

- [ ] Müşterinin ücretsiz Cloudflare hesabı var, iki adımlı doğrulama açık.
- [ ] D1 veritabanı (`um-relay`) oluşturuldu ve `deploy/cloudflare-worker/schema.sql` çalıştırıldı.
- [ ] Worker oluşturuldu; `worker.js` (bu sürümle birlikte derlenmiş dosya) yapıştırıldı; `DB` bağlaması eklendi.
- [ ] **Workers Logs KAPALI** (çıkış belirteci istek adresinde taşınır).
- [ ] Uygulamada çıkış adresi (`https://um-relay.<hesap>.workers.dev`), imza ve kanal anahtarları oluşturuldu.
- [ ] `relay-keys.json` (yalnızca GENEL anahtarlar) Worker'a `RELAY_KEYS` **Secret** olarak girildi; dosya e-postayla
      veya sohbetle taşınmadı.
- [ ] `/healthz` `{"ok":true}`; uygulamada "Uçtan uca doğrula" ve "Kuyruğu denetle" başarılı; "Talepleri düzenli çek" açık.
- [ ] `wrangler.toml` içindeki `database_id` yer tutucusu yalnızca yerelde değiştirilir, DEPOYA YAZILMAZ.

Worker sürümü ile uygulama sürümü birlikte gelir: `worker.js` dosyası, teslim edilen uygulama paketiyle aynı commit'ten
derlenmelidir (kanal protokolü uyumu).
