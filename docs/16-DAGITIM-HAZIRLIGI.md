# Dağıtım hazırlığı: macOS imza/notarization ve Cloudflare Worker (müşteri hesabı)

Bu belge GİZLİ DEĞER içermez ve içermemelidir. Sertifikalar, parolalar, anahtarlar ve belirteçler depoya, pakete veya
sohbete yazılmaz. GitHub deposu ayarlarını Efe yapar.

## 1. macOS imza ve notarization (Efe'nin Apple Developer hesabı)

Durum: yapılandırma ve korumalı iş akışı hazır; sırlar TANIMLI DEĞİL. Sürüm etiketi (`v*`) atıldığında imzalı paket işi
sırları bulamayıp **BAŞARISIZ olur ve Release oluşmaz** (sessizce imzasız paket üretilmez). İmzasız teslimata
kendiliğinden karar verilmez: bunun için iş akışı bilerek değiştirilmelidir. İmza kararı test edilecek paket üretilmeden
ÖNCE verilmelidir (imzasız test edilip imzalı teslim edilirse dosyalar aynı olmaz).

### 1.1 Sırlar nerede, kim kullanabilir (GitHub Environment `release-signing`)

- Apple sırları **depo düzeyinde TANIMLANMAZ**. Yalnızca `release-signing` adlı **Environment**'ın sırları olarak girilir.
- Sırlara yalnızca `package-signed` işi erişir; bu iş **yalnızca `v*` sürüm etiketinde** çalışır ve `environment:
  release-signing` kullanır. Normal dal itişleri, PR'lar ve `checks`/`e2e`/`package`/`release` işleri sır başvurusu
  taşımaz (`tests/packaging-config.test.ts` bunu denetler); Environment sırları bu işlerin hiçbirinde okunamaz.
- Sırlar iş içinde yalnızca iki adımın ortamına verilir (varlık denetimi ve derleme); `npm ci` ve diğer adımlar onları
  görmez. Değerler günlüğe yazdırılmaz (varlık denetimi yalnızca "boş mu" bakar).
- Akış: etiket → imzasız `package` (üç platform, duman testi) + imzalı `package-signed` (macOS arm64 ve x64, onay
  gerekirse bekler) → `release` imzalı macOS paketlerini ve Windows x64 paketini alıp TASLAK Release oluşturur. İmzasız macOS
  artifact'ları Release'e girmez. Efe test edilen dosyaları taslak Release'ten indirir; yayımlama aynı dosyaları açar.

### 1.2 Environment kurulumu (Efe, GitHub'da; bu depodan yapılamaz)

1. Depo → **Settings → Environments → New environment** → ad: `release-signing`. (Environment, workflow ilk kez
   başvurduğunda sırasız ve korumasız kendiliğinden de oluşabilir; bu yüzden ÖNCE elle oluşturun.)
2. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → *Ref
   type*: **Tag**, desen: `v*`. (Dal itişleri bu Environment'a erişemez.)
3. **Required reviewers**: Efe (ve yetkili ikinci kişi varsa o). İmzalı iş, bir onaylayıcı onaylayana kadar bekler;
   sırlar onaydan önce işe verilmez.
4. **Environment secrets → Add secret** altında aşağıdaki beş sırrı ekleyin (depo düzeyinde **Repository secrets**
   altına EKLEMEYİN; daha önce eklenmişse silin).
5. Etiketi yalnızca yetkililerin atabilmesi için: **Settings → Rules → Rulesets → New tag ruleset** → hedef `v*`,
   *Restrict creations* (yalnızca yöneticiler). Etiket oluşturmak imzalı sürümü tetiklediğinden bu koruma önemlidir.

**Plan ve depo kısıtları (doğrulanmadı / dikkat):** depo herkese açık (public) ve kişisel hesaba ait; bu durumda
Environment, gerekli onaylayıcı ve dal/etiket kuralları GitHub'ın ücretsiz planında kullanılabilir. Özel (private)
depolarda Environment koruma kuralları ücretsiz planda yoktur (Pro/Team/Enterprise gerekir). Bu belgeyi yazarken
Environment ayarlarına erişimim yoktu; Efe, 2. ve 3. adımda seçeneklerin görünmesini kontrol etmelidir. Seçenekler
görünmüyorsa (ör. depo özel yapılırsa) bu koruma UYGULANMAMIŞ demektir: o durumda sırlar girilmemeli, plan
yükseltilmeli veya depo herkese açık kalmalıdır. Kişisel hesapta tek kişi sahipse "kendi onayını engelle" seçeneği
etkisizdir; yine de onay adımı bilinçli bir duraklama sağlar. Etiket kuralı yalnızca etiketin ADINA bakar; asıl koruma
onaylayıcı ve etiket oluşturma kuralıdır.

### 1.3 Efe'nin yapacakları (yerel Mac'inde, M4)

1. Apple Developer hesabında **Developer ID Application** sertifikası oluştur (Xcode → Settings → Accounts → Manage
   Certificates, veya developer.apple.com). Sertifika Anahtarlık'a iner. (Developer ID Installer gerekmez.)
2. `security find-identity -v -p codesigning` çıktısında "Developer ID Application: … (TAKIM KİMLİĞİ)" görünmeli.
3. Anahtarlık Erişimi'nde sertifikayı özel anahtarıyla **.p12** olarak dışa aktar (güçlü bir parolayla). Dosya depoya
   KOYULMAZ ve sohbette paylaşılmaz.
4. https://account.apple.com → Sign-In and Security → **App-Specific Passwords** → "universal-mail-notarize" oluştur.
5. **Team ID**'yi (10 karakter): developer.apple.com → Account → Membership details.
6. base64 metnini ekrana yazdırmadan panoya al: `base64 -i sertifika.p12 | pbcopy`. Environment sırlarını gir (1.2 / 4. adım):

| Sır | Değer |
| --- | --- |
| `CSC_LINK` | .p12 dosyasının base64 metni (pano) |
| `CSC_KEY_PASSWORD` | .p12 parolası |
| `APPLE_ID` | Apple kimliği (e-posta) |
| `APPLE_APP_SPECIFIC_PASSWORD` | 4. adımdaki uygulamaya özel parola |
| `APPLE_TEAM_ID` | 5. adımdaki Team ID |

7. Yerel `.p12` dosyasını sil, panoyu temizle; yedeği yalnızca parola yöneticisinde tut.

### 1.4 CI doğrulaması ve sınırı

`package-signed` işi macOS paketini **imzalar ve notarize eder** (sertleştirilmiş çalışma zamanı,
`build/entitlements.mac.plist` yetkileri) ve ZORUNLU olarak doğrular: `codesign --verify --deep --strict`, çalışma
zamanı bayrağı, `spctl --assess`, `xcrun stapler validate`. Biri başarısızsa iş ve Release başarısız olur. Hem
`mac-arm64` hem `mac-x64` aynı sertifikayla imzalanır. Windows kod imzalama bu iş akışında YOKTUR (karar bekliyor;
eklenirse ayrı, korumalı bir işe eklenir; `WIN_CSC_*` değişkenleri CI'da kullanılmaz).

Bu doğrulama gerçek Mac kanıtı değildir. Gerçek Mac'te (taslak Release'ten tarayıcıyla indirilen dosya) doğrulanacaklar:
Gatekeeper açılışı (uyarısız), `codesign -dv --verbose=4` (doğru TeamIdentifier, `runtime`), `spctl -a -vv` ("accepted,
source=Notarized Developer ID"), Anahtarlık izin davranışı, güncellemede Anahtarlık sorusu çıkıp çıkmadığı.

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
