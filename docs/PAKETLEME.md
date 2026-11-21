# Paketleme, kurulum ve güncelleme (Faz 6, paket K)

Bu belge kurulum paketlerinin nasıl üretildiğini, kurulum/kaldırma/güncelleme sırasında verilere ne olduğunu ve isteğe
bağlı kod imzalamanın nasıl açılacağını anlatır. Son kullanıcıya yönelik adımlar `docs/KURULUM.md`'dedir.

## 1. Ne, nerede üretilir

| Platform | Çıktı | Nerede derlenir |
| --- | --- | --- |
| macOS (Apple Silicon, arm64) | `Universal-Mail-<sürüm>-mac-arm64.dmg` | GitHub Actions `macos-26` |
| Windows 10/11 (x64) | `Universal-Mail-<sürüm>-win-x64.exe` (NSIS kurulum programı) | GitHub Actions `windows-2025` |

- Yapılandırma: `electron-builder.config.cjs` (JS; imzalama ortam değişkenlerine göre koşullu alanlar içerir).
- Komut: `npm run dist` (önce `npm run build`). Yerelde hızlı deneme için `npm run dist:dir` (yalnızca açılmış
  uygulama klasörü). Paketlenmiş uygulamanın duman testi: `npm run smoke`.
- CI'da paket işi kalite denetimleri ve uçtan uca testlerden sonra çalışır; `v*` etiketi itilince taslak bir GitHub
  Release oluşturulur (`.github/workflows/ci.yml`).
- Paket Node.js kurulumu gerektirmez: Electron kendi Node'unu taşır; web sunucusu, işçi ve şema geçişi
  `resources/server` altındadır.

### Pakete girmeyenler (yerel derleme güvenliği)

Next'in dosya izleyicisi proje kökündeki `.data/` klasörünü (geliştirme veritabanı, `master.key`, `secrets.json`) ve
`.env*` dosyalarını `.next/standalone` içine kopyalayabilir. Yerelde `npm run dist` çalıştırıldığında bunlar kurulum
paketine taşınırdı (Faz 6'da yerel `--dir` denemesinde görüldü). `electron-builder.config.cjs` sunucu klasörünü
kopyalarken iki katmanlı süzgeç uygular: (1) kara liste: `.data*` adlı her klasör (`.data`, `.data-demo`,
`.data-arsiv-…`), `.env*`, `*.db*`, `master.key*`, `secrets.json`, `*.umbk`; (2) izin listesi: izleyicinin taşıdığı
`data/` klasöründen yalnızca `data/cities.eu-tr.json` ve `data/ATTRIBUTION.md` girer (`data/backups/`, dışa
aktarımlar, günlükler girmez). `tests/packaging-config.test.ts` süzgeci electron-builder'ın kendi eşleyicisiyle sahte
dosyalar içeren gerçek bir klasör ağacına uygular. CI temiz checkout'tan derlediği için orada bu dosyalar zaten yoktur.

## 2. Kimlik ve veri klasörü

| Alan | Değer | Neden önemli |
| --- | --- | --- |
| `appId` | `com.universalmail.app` | Windows'ta kayıt defteri/kaldırıcı kimliği, bildirim kimliği (AppUserModelId) |
| `productName` | `Universal Mail` | Veri klasörünün adı |
| Veri klasörü (macOS) | `~/Library/Application Support/Universal Mail` | |
| Veri klasörü (Windows) | `%APPDATA%\Universal Mail` | |

Bu iki değer **değiştirilmemelidir**: eski sürümün üzerine kurulan yeni sürüm verileri bu kimlik sayesinde bulur.
`electron/main.ts` aynı değerleri kullanır; `tests/packaging-config.test.ts` ikisinin eşit olduğunu denetler.

Veri klasörünün içi: `data/` (veritabanı `universal-mail.db`, `secrets.json`, `backups/`, `google-session.db`,
`migrate-result.json`), `master.key.enc` (işletim sistemi anahtarlığıyla şifreli ana anahtar), `ui-prefs.json`,
`logs/`.

## 3. Windows kurulumu (NSIS)

- **Kullanıcı başına** kurulum (`perMachine: false`, `allowElevation: false`): yönetici parolası istemez.
- `oneClick: false` + `perMachine: false` iken electron-builder'ın yardımlı kurulumu her zaman **"Choose Installation
  Options"** sayfasını gösterir ("Anyone who uses this computer (all users)" / "Only for me"). Bu sayfanın metni
  electron-builder şablonunda yalnızca İngilizcedir; yönetici hesabında "all users" seçilebilir ve UAC ile makine
  geneline kurar. Kullanıcı rehberi (`docs/KURULUM.md` 3.2) **Only for me** seçtirir. Sayfayı tamamen kaldırmak için
  tek tıklamalı kullanıcı başına kuruluma (`oneClick: true`) geçmek gerekir; bu, kurulum klasörü seçimini ve kurulum
  sonu "çalıştır" seçeneğini kaldırdığı için yapılmadı.
- Kurulum klasörü değiştirilebilir; **masaüstü kısayolu** her zaman, Başlat menüsü kısayolu oluşturulur; kurulum bitince
  uygulama açılır.
- Dil: Türkçe (varsayılan, `1055`) ve İngilizce; işletim sisteminin diline göre seçilir.
- Kaldırma (`build/installer.nsh`, `customUnInstall`):
  - Kullanıcıya **"Verilerinizi de silmek istiyor musunuz?"** diye sorulur. Varsayılan yanıt **Hayır**'dır.
  - **Evet** yalnızca `%APPDATA%\Universal Mail` klasörünü siler (veritabanı, anahtarlar, bu klasördeki yedekler,
    günlükler). Kullanıcının başka bir klasöre (ör. harici disk) aldığı yedeklere dokunulmaz.
  - **Güncellemede sorulmaz:** yeni sürüm eskisinin üzerine kurulurken electron-builder eski kaldırıcıyı `--updated`
    ile çalıştırır; `${isUpdated}` koruması nedeniyle veri silme adımı tamamen atlanır.
  - **Sessiz kaldırmada (`/S`) sorulmaz** ve veriler korunur.
  - Dosya UTF-8 **BOM'lu** kaydedilir (NSIS Türkçe karakterleri ancak böyle okur).

## 4. macOS kurulumu

- `.dmg` açılır, uygulama Uygulamalar klasörüne sürüklenir. İmzasız sürümde ilk açılışta sağ tık → **Aç** gerekir
  (ayrıntı: `docs/KURULUM.md`).
- macOS'te kaldırıcı yoktur: verileri silmek için uygulama içindeki **Ayarlar → Yedekler → Tüm verilerimi sil**
  (paket Y) kullanılır ya da `~/Library/Application Support/Universal Mail` elle silinir. Anahtarlıktaki
  "Universal Mail Safe Storage" kaydı kaldırmadan sonra da kalır (Anahtar Zinciri Erişimi'nden elle silinebilir).

## 5. Güncelleme: üzerine kur, veriler korunur

1. Kullanıcı yeni sürümün kurulum dosyasını çalıştırır (Windows) veya yeni uygulamayı eskisinin üzerine sürükler
   (macOS). Veri klasörüne dokunulmaz.
2. İlk açılışta Electron şema geçişi alt sürecini (`migrate.cjs` = `scripts/migrate.ts`) çalıştırır. Bekleyen geçiş
   varsa ve veritabanında veri varsa **önce otomatik yedek** alınır: `data/backups/pre-migrate-<zaman>.db` (+ `-wal`),
   en yeni 5 tanesi saklanır. Kopya önce `.tmp` adına alınır ve tamamlanınca yeniden adlandırılır (disk dolarsa yarım
   kopya kalmaz). Geçiş tek işlemde uygulanır; hata olursa işlem geri alınır. Geçişten önce
   `data/migrate-verify.pending` işareti yazılır, geçiş sonrası bütünlük denetimi (yabancı anahtar) geçince silinir;
   işaret kaldıysa sonraki çalıştırmada bekleyen geçiş olmasa bile denetim yeniden yapılır (bozuk veritabanıyla
   açılmaz, yedeğe dönüş seçeneği kaybolmaz).
3. Sonuç `data/migrate-result.json`'a yazılır (`{ok, code, backupPath, applied, total}`; kişisel veri yok).
4. Geçiş başarısız olursa **"Veritabanı güncellenemedi"** iletişim kutusu çıkar (`electron/migration-recovery.ts`),
   metin hata koduna göre değişir:

   | Kod | Anlamı | Düğmeler (Enter = ilk sıradaki) |
   | --- | --- | --- |
   | `BLOCKED` | Başka bir süreç veritabanını tutuyor: bakım kilidi, `migrate.lock` zaman aşımı, `SQLITE_BUSY`/`LOCKED` | Yeniden dene; yedeğe dönüş **yok** |
   | `DISK_FULL` | Diskte yer yok | Yeniden dene, yedeğe dön |
   | `CORRUPT` | Veritabanı dosyası bozuk | Yedeğe dön (varsa); yeniden deneme **yok**. Metin: kopya da bozuk olabilir, şifreli `.umbk` yedeklerin yeri, destek |
   | `VERIFY_FAILED` | Geçiş uygulandı ama bütünlük denetimi başarısız | Yedeğe dön; yeniden deneme **yok** (geçiş zaten uygulandı) |
   | `FAILED` | Diğer hatalar | Yeniden dene, yedeğe dön |

   Düğmeler:
   - **Yeniden dene:** yalnızca `BLOCKED`, `DISK_FULL`, `FAILED` için ve ilk iki gösterimde. Sonraki deneme aynı
     açılışta alınmış yedeği yeniden kullanır (`UM_PRE_MIGRATE_BACKUP`; yeni kopya alınmaz, disk dolu iken yer
     harcanmaz, eski yedekler budanmaz). Üçüncü gösterimde yalnızca aşağıdakiler kalır (sonsuz döngü olmaz; ana
     süreç dördüncü başarısızlıkta genel hata kutusuna düşer, bu yüzden yedeğe dönüş her zaman erişilebilir kalır).
   - **Güncelleme öncesi yedeğe dön:** yalnızca yedek tam olarak `data/backups/pre-migrate-*.db` ise ve diskte varsa
     (ilk kurulumda yedek yoktur, düğme de yoktur; bu denemenin sonucunda yedek yoksa aynı açılıştaki önceki denemenin
     yedeği kullanılır). `BLOCKED`'da sunulmaz. Onay kutusunun varsayılanı Vazgeç'tir. Onaydan sonra canlı bakım kilidi
     veya `migrate.lock` varsa dosyalara dokunulmaz ("veritabanı kullanımda"). Aksi halde: yedeğin kopyası hazırlanır,
     mevcut veritabanı (+ `-wal`/`-shm`) **silinmeden** `data/backups/failed-migrate-<zaman>.db` adıyla kenara alınır
     ve kopya yerine konur. Her adım kopyala-sonra-yeniden-adlandır'dır; bir adım yarıda kalırsa yapılan
     adlandırmalar geri alınır ve kullanıcıya "hiçbir dosya silinmedi" denir. Ardından uygulama kapanır; kullanıcı
     önceki sürümü yeniden kurar veya destek ister.
   - **Günlük klasörünü aç:** klasörü açar, iletişim kutusu yeniden gösterilir.
   - **Çık.**

Destek için: `logs/app.log` ve `data/migrate-result.json` yeterlidir (kişisel veri içermez). `failed-migrate-*.db`
dosyası müşterinin verisini içerir; yalnızca müşterinin onayıyla paylaşılır.

## 6. Kod imzalama (İSTEĞE BAĞLI, varsayılan KAPALI)

İmzasız paketler çalışır; yalnızca ilk açılışta işletim sistemi uyarısı çıkar (`docs/KURULUM.md`). İmzalama için
sertifika ve hesaplar **müşteri/geliştirici kararıdır** (ücretli). Kancalar hazırdır; GitHub deposuna aşağıdaki
**Actions sırları** eklenince CI kendiliğinden imzalar. Sırlar yoksa değişkenler boş gelir ve paket bugünkü gibi
imzasız üretilir.

| Sır (GitHub → Settings → Secrets and variables → Actions) | Platform | Ne |
| --- | --- | --- |
| `CSC_LINK` | macOS (Windows'ta da yedek) | Developer ID Application sertifikası (`.p12`), base64 |
| `CSC_KEY_PASSWORD` | macOS | `.p12` parolası |
| `APPLE_ID` | macOS | Notarize için Apple hesabı e-postası |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | appleid.apple.com'dan uygulamaya özel parola |
| `APPLE_TEAM_ID` | macOS | 10 karakterlik ekip kimliği |
| `WIN_CSC_LINK` | Windows | Kod imzalama sertifikası (`.pfx`), base64 |
| `WIN_CSC_KEY_PASSWORD` | Windows | `.pfx` parolası |

Davranış (`electron-builder.config.cjs`):

- **macOS:** `CSC_LINK` veya `CSC_NAME` varsa `identity` electron-builder'a bırakılır, `hardenedRuntime: true` ve
  `build/entitlements.mac.plist` yetkileri kullanılır (yalnızca JIT, imzasız yürütülebilir bellek ve kütüphane
  doğrulamasını kapatma: Electron ve libsql yerel modülü için). **Notarize** yalnızca `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` ve `APPLE_TEAM_ID` üçü birlikte varsa açılır. Sertifika yoksa `identity: "-"`:
  paket **ad-hoc** imzalanır (ücretsiz, sertifikasız; koşucunun anahtarlığındaki bir kimlik kullanılmaz). Hiç
  imzalamamak (`null`) Apple Silicon'da indirilen uygulamanın "hasar görmüş" hatasıyla açılmamasına yol açar.
- **Windows:** `signAndEditExecutable: true` her zaman: `.exe` simgesi ve sürüm bilgisi (ürün adı) imzasız derlemede
  de gömülür, masaüstü/Başlat kısayolları Universal Mail simgesini taşır. İmzalama ayrı bir anahtardır:
  `signExecutable` yalnızca `WIN_CSC_LINK` veya `CSC_LINK` varsa `true` (electron-builder 26: `signAndEditExecutable:
  false` ikisini birden kapatır, `signExecutable: false` yalnızca imzalamayı). CI Windows işi `scripts/check-win-exe.mjs`
  ile ürün adının `.exe` sürüm bilgisine gömüldüğünü doğrular (simge aynı resedit adımında gömülür).

Yerelde imzalı deneme: sertifikayı anahtarlığa kurup `CSC_NAME="Developer ID Application: …" npm run dist`.

## 7. Simge

`build/icon.png` 1024×1024 RGBA'dır (`npm run icon`, `src/app/icon.svg`'den üretir). electron-builder `.icns` ve
`.ico` (256 px dahil) dosyalarını bundan kendisi üretir; test en az 512 (macOS) ve 256 (Windows) piksel olduğunu
denetler.

## 8. Testler

| Test | Ne kanıtlar |
| --- | --- |
| `tests/packaging-config.test.ts` | Yapılandırma electron-builder'ın kendi şemasıyla geçerli; kimlik main.ts ile aynı; ortam boşken imzasız, doluyken imzalı/notarize; geliştirici verisi pakete girmez; NSIS seçenekleri; `installer.nsh` korumaları (`isUpdated`, `IfSilent`, varsayılan Hayır, yalnızca `$APPDATA\Universal Mail` silinir, BOM); simge boyutu; yetkiler; CI sırları yalnızca paket adımında |
| `tests/migration-upgrade-path.test.ts` | 0000..0005 şemalarının **her birinden** güncel sürüme yükseltme: veri bire bir korunur, yedek alınır ve eski veriyi taşır, bütünlük temiz, ikinci açılış değişiklik yapmaz (fikstürler `tests/fixtures/schema/`) |
| `tests/update-over-install.test.ts` | 0005 kullanıcı klasörünün üzerine yeni sürümün gerçek açılış adımı: ayarlar, lead'ler, kampanyalar ve aynı ana anahtarla gizli bilgiler korunur; `migrate-result.json` OK |
| `tests/electron-migration-recovery.test.ts` | Her hata kodu × her düğme (`VERIFY_FAILED`/`CORRUPT`'ta yeniden deneme yok, `BLOCKED`'da yedeğe dönüş yok, "kullanımda" denetimi, hatırlanan yedek), yedek yolu doğrulaması, kopya/taşıma hataları ve geri alma, yeniden deneme sınırı; gerçek dosyalarla bozuk güncelleme → yedeğe dönüş → düzeltilmiş sürümle açılış |
| `tests/migrate-result.test.ts` | Gerçek geçiş hatası sonuç dosyasına kod ve yedek yoluyla yansır; kilit/BUSY → `BLOCKED`; doğrulama başarısızsa yeniden çalıştırma da `VERIFY_FAILED` (işaret dosyası); ENOSPC'de yarım yedek kalmaz; aynı açılıştaki yedek yeniden kullanılır |

## 9. Bilinen sınırlar

- macOS için `electron-builder --dir` yerelde bir kez denendi (16 Kas 2026): imzasız `.app` üretildi, paket kimliği
  `com.universalmail.app`, simge `icon.icns`, `resources/server` içinde `.next`, `data`, `drizzle` var; `.data` ve
  `.env` yok. Paketlenmiş uygulamanın duman testi yerelde çalıştırılmadı (kullanıcının anahtarlığına dokunmamak için);
  CI'da `npm run smoke` çalışır.
- NSIS betiği ve paketler yalnızca CI'da derlenir; `makensis` yerelde çalıştırılmadı. `installer.nsh` ilk CI
  çalıştırmasında derlenecek ve kaldırma sorusu temiz bir Windows makinede elle denenmelidir.
- `CORRUPT` iletişim kutusunda şifreli `.umbk` yedeğinden geri yükleme yolu YOK: bu yedekler yalnızca açık uygulamadan
  (Ayarlar → Yedekler) geri yüklenebilir. Paket Y ile entegrasyon maddesi: uygulama açılamazken bir `.umbk` yedeğini
  seçip `applyPendingLifecycleInMain`'in uyguladığı geri yükleme hazırlığına (restore staging) bağlayan bir düğme.
- Yedeğe dönüş öncesi "veritabanı kullanımda" denetimi bakım kilidi ve `migrate.lock` işaretlerine bakar; bu
  işaretlere uymayan (eski sürüm) bir süreci göremez. `BLOCKED` sınıflaması bu durumda yedeğe dönüşü hiç sunmaz.
- Yalnızca Apple Silicon (arm64) macOS paketi üretilir; Intel Mac için ayrı bir x64 hedefi gerekir (karar bekliyor).
- Gerçek "temiz makinede kurulum → güncelleme → kaldırma" denemesi ve işletim sistemi iletişim kutularının ekran
  görüntüleri kullanıcının makinelerinde yapılmalıdır.
