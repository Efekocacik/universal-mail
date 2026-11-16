# Faz 6 — Paketleme, Yedekleme, Dokümantasyon: Uygulama Notları

**Durum (16 Kasım 2026):** Faz 6 `feat/faz-6` dalında kodlandı; önce Faz 5'ten kalan dört hata kapatıldı (Bölüm 2.0), ardından P0 temeli ve üç paket (K: kurulum ve güncelleme, Y: yedekleme ve veri yaşam döngüsü, G: güvenlik, performans ve gizlilik) ayrı dallarda geliştirilip `--no-ff` ile birleştirildi, paketler arası dikişler ve kabul testi bağlandı, kullanıcı belgeleri yazıldı ve son inceleme turunun bulguları (Bölüm 6.1) kapatıldı. Bütün kalite kapıları (typecheck, lint, format:check, test:coverage), üretim derlemesi, işçi paketi ve Playwright paketi iki kez arka arkaya yeşil (Bölüm 6). **Kabul ölçütü** ("temiz bir bilgisayarda kurulum dosyasıyla 30 dakikada kurulup ilk tarama yapılır; geliştiricinin bilgisayarı kapalıyken de çalışır") kodda ve otomatik testlerde kanıtlanabilen kısmıyla kanıtlandı (Bölüm 7); **gerçek temiz makinede 30 dakikalık deneme yapılmadı** (kullanıcının makinesi gerekir). Canlı kapılar (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `LEGAL_APPROVALS`) **Faz 6'da değiştirilmedi**.

**Proje durumu: yol haritasındaki altı fazın tamamı kodda bitti.** Açık kalanlar yazılım işi değil; müşterinin hesabını, parasını, makinesini veya kararını gerektiren işlerdir (Bölüm 10).

> Bu belge yalnızca kod ve testlerle doğrulanmış olanı "yapıldı" diye yazar. Demo modunda, sahte sağlayıcıyla veya fikstürle çalışan; ya da gerçek hesap, sertifika veya müşteri kararı isteyen her şey açıkça işaretlidir. Bir çelişki görürseniz **kod belirleyicidir**. Belgedeki işletme adları ve alan adları yapaydır.

## 1. Genel bakış

Simgeler: ✔ yapıldı ve test edildi · ◐ kısmen (kodda ve testte hazır; gerçek makine, hesap veya karar bekliyor) · ✘ yapılmadı.

| Kalem (yol haritası) | Paket | Durum | Not |
|---|---|---|---|
| Kurulum dosyalarının cilası: simge, ilk açılış rehberi, imzasız uygulama için kurulum rehberi | K | ◐ | Simge, gösterge panelinde 7 adımlı "Kurulumu tamamlayın" kartı ve `docs/KURULUM.md` hazır; işletim sistemi uyarı pencerelerinin ekran görüntüleri temiz makinede çekilecek |
| Otomatik veri klasörü, açılışta otomatik yedek ve göç; "verilerimi de sil" ile kaldırma | K + Y | ✔ | Güncelleme öncesi kopya, koda özel kurtarma penceresi; Windows kaldırıcısında "verilerimi de sil" sorusu, macOS'te "Tüm verilerimi sil" |
| Opsiyonel kod imzalama | K | ◐ | Kancalar hazır, varsayılan **kapalı**; sertifika müşteri kararı |
| Şifreli yedekleme/geri yükleme; otomatik haftalık yedek | Y | ✔ | `.umbk` v1 (scrypt + AES-256-GCM), açılışta günde bir ve haftalık otomatik yedek |
| Güncelleme akışı: üstüne kurulum, veri korunur; göç testleri | K | ✔ | 0000..0005 şemalarının her birinden yükseltme testleri; gerçek Windows'ta üzerine kurulum elle denenmedi |
| Veri saklama süresi (12 ay) ve "veriyi sil" akışı | Y | ✔ | Önizleme = silme; bayat önizlemede hiçbir şey silinmez |
| Kullanıcı rehberi, sorun giderme, kurulum rehberi, teslim listesi | belgeler | ✔ | `docs/KULLANIM.md` (33 ekran görüntüsü), `docs/KURULUM.md`, `docs/TESLIM.md` |
| Güvenlik gözden geçirmesi: anahtar saklama, `127.0.0.1` bağlama, `npm audit` | G | ✔ | `docs/GUVENLIK.md`; çalışma zamanı bağımlılıklarında 0 açık |
| Performans: 100k lead ile filtreleme < 300 ms | G | ✔ | 132 durum; ortanca 67 ms, en yavaş 266 ms (yerel ölçüm) |
| Gizlilik doğrulaması: temiz kurulumda ağ trafiği | G | ◐ | Node süreçleri ve arayüz için ağ çıkışı bekçisiyle kanıtlandı; paketli Electron uygulamasının temiz makinede ağ izlemesi yapılmadı |
| Teslim paketi ve kurulum günü | — | ✘ | Müşteriyle birlikte yapılacak (`docs/TESLIM.md`) |
| Faz 5'ten kalan hatalar | Faz 6 öncesi | ✔ | Bölüm 2.0 |

**Paketler:** P0 (ortak temel: migrasyon `0006`, iç ayar anahtarları, 19 yaşam döngüsü hata kodu ve HTTP durum haritası, iki bildirim türü, i18n parçaları, Electron yer tutucuları, 100k tohum) · K (kurulum ve güncelleme) · Y (yedekleme ve veri yaşam döngüsü) · G (güvenlik, performans, gizlilik). Paketler bağımsız inceleme turundan geçti; entegrasyon commit'i Ayarlar kartlarını, Electron sertleştirmesini ve paketler arası dikişleri bağladı ve `tests/faz6-acceptance.test.ts`'i ekledi.

## 2. Özellikler: kullanıcı ne görür, nasıl çalışır

### 2.0 Faz 5'ten kalan hataların kapanışı (Faz 6'nın ilk işi)

- **Harici e-posta servisi (Hunter/Snov)** paylaşımlı platform sitelerinde (bağlantı sayfaları, ücretsiz site oluşturucu alt alan adları) platformun alan adıyla çağrılmaz; platformun kendi adresleri kaydedilmez. Aynı siteyi paylaşan lead'ler için ücretli arama çalışma başına bir kez yapılır. Snov yoklaması süre içinde bitmezse lead "sonuç bekleniyor" nedeniyle kalır ve 24 saat sonra bir kez kendiliğinden yeniden denenir (TR+EN neden metni). Test: `external-snov`, `email-service`.
- **Onaylı kişisel giriş** çok sayıda yeniden üretimden sonra da panelde görünür (dil başına onaylı satır her zaman döner); onay, `intro_pending` nedeniyle ertelenmiş diziyi hemen uyandırır. Test: `ai-intro-api`, `ai-intro-dispatch`.
- **Sicil çekmede** sayfa başına tam tablo taramasıyla yapılan "yeni kayıt" sayımı kaldırıldı; sayı eklemelerin toplamıdır. Test: `registry-api`.
- **Açılma izleme onay anı** sunucu saatiyle damgalanır (kapalı → açık geçişi); istemci yalnızca `{ enabled }` gönderir. Test: `faz5-p0`.

### 2.1 Kurulum, güncelleme ve kurulum listesi (paket K)

**Kullanıcı ne görür:** GitHub Release sayfasından indirilen `Universal-Mail-<sürüm>-mac-arm64.dmg` veya `Universal-Mail-<sürüm>-win-x64.exe`. Windows'ta kullanıcı başına kurulum (İngilizce "Choose Installation Options" sayfasında **Only for me**; yönetici izni istenmez), masaüstü ve Başlat menüsü kısayolu, kurulum sonunda uygulama açılır. Kaldırırken "Verilerinizi de silmek istiyor musunuz?" sorusu (varsayılan Hayır). İlk açılıştan sonra gösterge panelinde **Kurulumu tamamlayın** kartı: kurulum sihirbazı, veri kaynağı, ilk tarama, Gmail bağlantısı, kendinize test e-postası, çıkış sunucusu, yedek parolası (7 adım; her adımın "Aç" bağlantısı ilgili ekrana gider; demo ile tamamlanan adımda "Demo" rozeti; Gizle / Geri al / yeniden göster). Güncelleme başarısız olursa **"Veritabanı güncellenemedi"** penceresi.

**Nasıl çalışır:**

- `electron-builder.config.cjs`: NSIS kullanıcı başına (`perMachine: false`, `allowElevation: false`), `build/installer.nsh` kaldırma sorusu (güncellemede `isUpdated` ve sessiz kaldırmada sorulmaz; yalnızca `$APPDATA\Universal Mail` silinir). Geliştiricinin yerel `.data`, `.env`, veritabanı, anahtar ve yedek dosyaları iki katmanlı süzgeçle pakete girmez. Ayrıntı: [`PAKETLEME.md`](PAKETLEME.md).
- Açılışta şema geçişi alt süreci (`scripts/migrate.ts`): bekleyen işlem (geri yükleme / silme) → geçiş → yedek listesi eşitleme → `data/migrate-result.json`. Bekleyen geçiş varsa ve veri varsa önce `data/backups/pre-migrate-<zaman>.db` alınır (atomik `.tmp` + yeniden adlandırma, en yeni 5). Bütünlük denetimi geçene kadar `migrate-verify.pending` işareti kalır.
- `electron/migration-recovery.ts`: hata koduna göre (`BLOCKED`, `DISK_FULL`, `CORRUPT`, `VERIFY_FAILED`, `FAILED`) "Yeniden dene" (en çok 2), "Güncelleme öncesi yedeğe dön" (kopyala-sonra-adlandır; hiçbir dosya silinmez), "Günlük klasörünü aç", "Çık".
- Kurulum listesi yalnızca okur (`src/lib/onboarding/checklist.ts`); kart gizlenme anı iç ayar `onboarding.checklist`'tedir.

### 2.2 Şifreli yedek ve geri yükleme (paket Y)

**Kullanıcı ne görür:** Ayarlar → **Yedekler**: yedek parolası (en az 10 karakter; değer hiçbir zaman geri gösterilmez), otomatik yedek (açılışta günde bir ve haftalık, tutulacak sayı 7 / 4), "Kayıtlı anahtarları da yedekle", yedek klasörü (masaüstünde **Klasör seç…** + **Kaydet**), **Şimdi yedekle**, yedek listesi (İndir, Geri yükle, Sil), **Yedek dosyası yükle** (masaüstünde büyük dosya için **Dosya seç…**). Geri yükleme penceresi: parola → **Yedeği denetle** → içerik özeti (işletme, kampanya, şablon sayısı, tarih) → anahtarlar da geri yüklensin mi → onay → "Uygulamayı yeniden başlatın" bandı (**İşlemi iptal et**). Yeniden açılışta sonuç bandı. Otomatik yedek alınamazsa günde en çok bir bildirim (tıklanınca Ayarlar → Yedekler).

**Nasıl çalışır:**

- **Biçim `.umbk` v1** (`src/lib/backup/format.ts`): scrypt (N = 2^17, r = 8, p = 1) ile türetilen anahtarla AES-256-GCM; başlık AAD ile doğrulanır, parola doğrulayıcısı ayrıdır; yük akışlı gzip. Yanlış parola `BACKUP_WRONG_PASSPHRASE`, bozuk yük `BACKUP_CORRUPT`, biçim dışı dosya `BACKUP_BAD_FORMAT`. Manifest boyutu ve veritabanı baytı sınırlı (gzip bombası bildirilen boyutu aşınca durur). Başlıktaki scrypt maliyeti en çok 2^18 kabul edilir (Bölüm 6.1).
- **Yedek alma** (`src/lib/backup/service.ts`): `VACUUM INTO` ile anlık görüntü, aynı anda tek yedek (`backups_running_uq` kısmi tekil indeksi süreçler arasında), `.part` → yeniden adlandırma, keep-N döndürme (elle alınanlar silinmez), özel klasör doğrulaması (mutlak, var, yazılabilir, uygulama paketi dışında). Gizli bilgiler parolalı yükün içinde taşınır; yedek parolasının kendisi asla yedeğe girmez.
- **Geri yükleme iki adımlıdır:** denetim dosyayı geçici bir hazırlığa çözer (1 saat geçerli), planlama bekleyen işlem işaretini yazar; asıl değiştirme **bir sonraki açılışta**, veritabanı açılmadan önce yapılır (`src/lib/lifecycle/pre-init.ts`). Şu anki veritabanı `pre-restore-<zaman>.db` olarak kopyalanır (en yeni 3), parola ayarlıysa planlarken ayrıca şifreli güvenlik yedeği alınır. Eski şemalı yedek açılışta güncel şemaya taşınır; daha yeni şemalı yedek `BACKUP_SCHEMA_NEWER` ile reddedilir.
- **Geri yükleme sonrası güvenlik** (`src/lib/lifecycle/post-restore.ts`): çalışan kampanyalar duraklatılır (neden "restore"), geri yükleme öncesi kopyadaki etkin engel kayıtları aktarılır (liste yalnızca büyür), yedekten sonraki silme talepleri yeniden uygulanır, yedekten sonra yazılmış alıcıların dizileri durur.
- **Yedek listesi her açılışta diskle eşitlenir** (`src/lib/backup/reconcile.ts`): yarım kalan satır kapanır, listede olmayan `.umbk` başlıktan eklenir.
- **Otomatik yedek** (`src/lib/backup/auto.ts`): işçi açılışında günde bir ve bakım turunda haftada bir; parola yoksa hiç (bildirim günde bir). Başka bir yedek sürerken başarı sayılmaz, yeniden denenir.

### 2.3 Saklama süresi ve "Tüm verilerimi sil" (paket Y)

**Kullanıcı ne görür:** Ayarlar → Yedekler → **Saklama süresi**: "Eski kayıtları kendiliğinden sil" (varsayılan açık), süre 1–12 ay (en çok 12), korunanların listesi, "Şu an silinecek: N" önizlemesi (otomatik silme kapalıyken "Süresi dolmuş kayıt: N (otomatik silme kapalı…)"), **Şimdi uygula** (onay penceresi), son çalışma. **Tüm verilerimi sil**: kutuya **VERİLERİMİ SİL** (İngilizce arayüzde **DELETE MY DATA**) yazılır, isteğe bağlı **Yedek dosyalarını da sil**, **Silmeyi planla**, yeniden başlatınca kurulum ekranı.

**Nasıl çalışır:**

- **Saklama adayları** (`src/lib/lifecycle/retention.ts`): hiç temas edilmemiş (`last_contacted_at IS NULL`), kesimden önce eklenmiş, durumu `new` veya `enriched` olan ve hiç kampanya satırı ya da iletisi olmayan lead'ler. **Korunanlar:** `do_not_contact` ve `not_interested` (ikisi de uygulamanın geri kalanında iletişim yasağıdır; bkz. Bölüm 6.1), temas edilmiş lead'ler, engel listesi, denetim kaydı, sicil satırları (bağı `NULL` olur). Silme 500'lük gruplar hâlinde, koşul her grupta yeniden değerlendirilerek yapılır; planlayıcı yanlış indeksi seçtiği için `INDEXED BY leads_retention_idx` zorunludur. Elle çalıştırmada güncel aday sayısı kullanıcının gördüğü önizlemeyi aşarsa hiçbir şey silinmez (409 `RETENTION_PREVIEW_STALE`). Günlük iş yalnızca ayar açıkken çalışır; silinen varsa bildirim (tıklanınca Ayarlar → Yedekler).
- **Tüm verilerimi sil** (`src/lib/lifecycle/wipe.ts`) yalnızca **planlanır**; yeniden başlatmada, Electron'da ana anahtar yüklenmeden önce uygulanır: veritabanı, gizli bilgi deposu, Google oturum önbelleği, güncelleme öncesi ve geri yükleme öncesi kopyalar, doğrulama işareti, günlükler; isteğe bağlı olarak varsayılan ve eski özel klasörlerdeki yedekler (yalnızca uygulamanın dosya adı desenine uyanlar). Ana süreç ayrıca tercihleri sıfırlar, "açılışta başlat" öğesini kaldırır ve Chromium depolamasını temizler.

### 2.4 Güvenlik, performans ve gizlilik (paket G)

**Kullanıcı ne görür:** Ayarlar → **Güvenlik ve gizlilik** kartı: veriler nerede, hangi hizmete ne zaman bağlanılır, telemetri yok. Kullanıcıya görünen başka değişiklik yok (koruma arka plandadır). Keşfet 100.000 kayıtta da hızlı açılır.

**Nasıl çalışır** (ayrıntı ve kanıtlar: [`GUVENLIK.md`](GUVENLIK.md)):

- **Yerel sunucu** yalnızca `127.0.0.1`'de dinler; `src/middleware.ts` Host'u yerel adlarla sınırlar, durum değiştiren isteklerde Origin = Host ister, `/api/` altındaki `cross-site` **ve** `same-site` istekleri reddeder (aynı makinede başka bağlantı noktası da yabancıdır). `tests/security-route-guard.test.ts` her `route.ts` dosyasını tarar.
- **Electron sertleştirmesi** (`electron/hardening.ts`): `contextIsolation`, `sandbox`, `app.enableSandbox()`, gezinme/yönlendirme yalnızca yerel kökene, yeni pencere yok, `<webview>` yok, paketli uygulamada geliştirici araçları kapalı, bütün izin istekleri reddedilir, yazım denetimi sözlüğü indirilmez.
- **Gizli bilgiler** AES-256-GCM ile şifreli `secrets.json`'da, ana anahtar işletim sistemi anahtarlığında; testi veri klasöründeki her dosyayı düz metin için tarar.
- **CSP ve başlıklar** (`next.config.ts`, yalnızca üretim derlemesi): kendi kökenimiz + Google Maps JS izin listesi; `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, `Permissions-Policy`.
- **Performans** (`src/lib/leads/query.ts`): geç satır okuma ve tek geçişli süzgeç sayımları; yeni indeks gerekmedi.
- **Gizlilik:** `scripts/egress-guard.cjs` Node süreçlerinde (sunucu, işçi, migrasyon) her dış TCP/DNS/UDP denemesini ağa çıkmadan engeller ve kaydeder; `src/lib/net/egress-allowlist.ts` koddaki her dış adres sabitinin izin listesinde olduğunu, geliştiriciye veya telemetriye giden adres olmadığını denetler.
- **npm audit:** çalışma zamanı bağımlılıklarında 0 açık; kalan 10 orta düzey bulgu yalnızca geliştirme/paketleme araçlarında (`GUVENLIK.md` Bölüm 7).

### 2.5 Kullanıcı belgeleri

- [`KULLANIM.md`](KULLANIM.md): sahibi için sade Türkçe kılavuz; 33 ekran görüntüsü (`npm run docs:shots`, demo modu, kendi geçici veri klasörüyle; normal e2e çalıştırmasına girmez). Ekran görüntüleri tarayıcı görünümündendir; masaüstüne özgü düğmeler ("Klasör seç…", "Dosya seç…") metinde ayrıca anlatılır.
- [`KURULUM.md`](KURULUM.md): temiz kurulum, imzasız uygulama adımları, güncelleme, kaldırma, 30 dakikalık kontrol listesi.
- [`TESLIM.md`](TESLIM.md): teslim paketi, kurulum günü, eğitim akışı, kaynak kod ve bakım dönemi alanları (karar bekliyor), imza listesi, açık kararlar.
- `tests/docs-links.test.ts` göreli bağlantıları, başlık bağlantılarını, görüntü boyutlarını ve geliştirici yolu sızıntısını denetler.

## 3. API uçları (Faz 6)

Bütün değiştiren uçlar ara katmanda aynı-köken denetiminden geçer, gövdeyi zod `.strict()` ile doğrular (400 `VALIDATION` / `BAD_JSON` / `INVALID_ID`) ve denetim kaydı yazar. Yedek ve veri uçları `lifecycleRoute` sarmalayıcısıyla `LifecycleError` → kodlu HTTP yanıtına çevrilir (`src/app/api/backups/http.ts`). Her hata yanıtı `{error, code, …}` biçimindedir; her kodun TR ve EN `apiError` metni vardır (`tests/api-error-text.test.ts`). Parola, yol veya kişisel veri hiçbir yanıtta ve denetim kaydında yer almaz.

### 3.1 Yeni uçlar

| Yöntem ve yol | Gövde / sorgu | Başarılı yanıt | Hata kodları |
|---|---|---|---|
| `GET /api/backups` | — | 200 `{backups, schedule, folder, folderIsDefault, defaultFolder, passphraseSet, preMigrateCount, pending, lastResult}` | — |
| `POST /api/backups` | `{includeSecrets?}` | 201 `{backup, secretsSkipped}` | 400 `BACKUP_PASSPHRASE_REQUIRED`, `BACKUP_FOLDER_UNWRITABLE`; 409 `BACKUP_IN_PROGRESS`; 507 `BACKUP_DISK_FULL`; 500 `BACKUP_FAILED` |
| `DELETE /api/backups/{id}` | — | 200 `{deleted: true}` (dosya yoksa da satır silinir) | 404 `NOT_FOUND`; 409 `BACKUP_IN_PROGRESS` |
| `GET /api/backups/{id}/download` | — | 200 akış (`application/octet-stream`, `no-store`; yol yalnızca satırdan kurulur) | 404; 410 `BACKUP_FILE_MISSING` |
| `PUT /api/backups/passphrase` | `{passphrase, confirm}` | 200 `{passphraseSet: true}` | 400 `BACKUP_PASSPHRASE_WEAK`, `BACKUP_PASSPHRASE_MISMATCH` |
| `PUT /api/backups/settings` | `{auto, onStartup, weekly, keepStartup, keepWeekly, includeSecrets, folder: string\|null}` | 200 `{schedule, folder}` | 400 `VALIDATION`, `BACKUP_FOLDER_INVALID`, `BACKUP_FOLDER_UNWRITABLE` |
| `POST /api/backups/restore/verify` | JSON `{backupId, passphrase}` veya `{path, passphrase}` (masaüstü "Dosya seç…"), ya da `multipart/form-data` `file` + `passphrase` (≤ 9 MiB) | 200 `{stageId, expiresAt, summary, migrationNeeded, hasSecrets}` | 404; 410 `BACKUP_FILE_MISSING`; 413 `BACKUP_TOO_LARGE`; 422 `BACKUP_BAD_FORMAT`, `BACKUP_WRONG_PASSPHRASE`, `BACKUP_CORRUPT`; 409 `BACKUP_SCHEMA_NEWER`, `LIFECYCLE_PENDING` |
| `POST /api/backups/restore` | `{stageId, confirm, restoreSecrets}` | 202 `{restartRequired: true, safetyBackup}` | 400 `RESTORE_CONFIRM_REQUIRED`; 410 `RESTORE_STAGE_NOT_FOUND`; 409 `LIFECYCLE_PENDING` |
| `DELETE /api/backups/restore/{stageId}` | — | 200 `{cancelled: true}` (idempotent) | — |
| `GET /api/data/pending` | — | 200 `{pending}` (yeniden başlatmayı bekleyen geri yükleme/silme ya da `null`) | — |
| `DELETE /api/data/pending` | — | 200 `{cancelled}` (idempotent) | — |
| `DELETE /api/data/result` | — | 200 `{dismissed}` (son sonuç bandını kapatır; idempotent) | — |
| `GET /api/data/retention` | — | 200 `{settings, preview: {cutoff, leads}, lastRun}` | — |
| `PUT /api/data/retention` | `{enabled, months: 1..12}` | 200 `{settings, preview}` | 400 `VALIDATION` |
| `POST /api/data/retention/run` | `{expectedMax ≥ 0}` | 200 `{deleted, cutoff}` | 409 `RETENTION_PREVIEW_STALE` |
| `POST /api/data/wipe` | `{confirm: "VERİLERİMİ SİL"\|"DELETE MY DATA", deleteBackups}` | 202 `{restartRequired: true}` | 400 `WIPE_CONFIRM_MISMATCH`; 409 `LIFECYCLE_PENDING` |
| `GET /api/onboarding` | — | 200 `{items: [{id, done, href, demo?}], dismissedAt, allDone, done, total}` | — |
| `POST /api/onboarding/dismiss` | `{}` | 200 `{dismissedAt}` (idempotent) | — |
| `POST /api/onboarding/restore` | `{}` | 200 `{dismissedAt: null}` (idempotent) | — |

### 3.2 Değişen uçlar (geriye uyumlu)

| Uç | Değişiklik |
|---|---|
| Bütün `/api/` uçları (`src/middleware.ts`) | `Sec-Fetch-Site: same-site` de reddedilir; ayrıştırılamayan Origin (`null`, `file:`) 403; ret yanıtı `code: "FORBIDDEN"` |
| `PUT /api/settings` | `tracking.opens` yalnızca `{enabled}` alır; onay anı sunucuda damgalanır (Bölüm 2.0) |
| `POST /api/enrichment/external/test` | Snov `pending` türü 502 `EXTERNAL_NETWORK`'e eşlenir |
| Bildirimler (`notify`) | Yeni türler `backup.failed`, `retention.purged`; bildirim yolu sonda isteğe bağlı sayfa içi çapa kabul eder (`/settings#backup`) |

## 4. Veri modeli: migrasyon `0006_faz6` ve geri alma

**`drizzle/0006_faz6.sql`** tek, elle düzenlenmiş ve **yalnızca ekleyen** bir migrasyondur (0003–0005 emsali): yeni tablo ve indeksler `IF NOT EXISTS` ile kurulur; mevcut hiçbir tablo yeniden kurulmaz, hiçbir satır yazılmaz, silinmez veya taşınmaz.

- **Yeni tablo `backups`:** şifreli yedek dosyalarının kaydı (kişisel veri yok). CHECK'ler: tür (`manual`, `startup`, `weekly`), durum (`running`, `ok`, `failed`), dosya adı yol ayırıcı içermez, `ok` ⇒ boyut + SHA-256 + bitiş anı, `failed` ⇒ hata kodu. `backups_file_name_uq`, `backups_running_uq` (kısmi tekil: aynı anda en çok bir süren yedek), `backups_kind_created_idx`.
- **Yeni indeks `leads_retention_idx`:** `leads(created_at) WHERE last_contacted_at IS NULL` (saklama önizlemesi ve silmesi).
- **Yeni iç ayar anahtarları** (tablo değişikliği yok; ayarlar API'si yazamaz): `backup.schedule`, `backup.folder`, `retention.leads` (varsayılan `{enabled: true, months: 12}`), `retention.lastRun`, `onboarding.checklist`. **Yeni gizli ad:** `backup.passphrase` (listede görünmez, yedeğe girmez).
- Performans için ek indeks eklenmedi: 100k ölçümünde aday indeks sıralama `places.first_seen_at`'e de dayandığı için kullanılmıyordu; kazanç sorgu yeniden yazımından geldi.

**Geri alma: `scripts/rollback-0006.ts`** (kütüphane `src/lib/db/rollback-0006.ts`; uygulamanın normal yolu bu modülü içe aktarmaz). 0003–0005 ile aynı iki aşamalı güvenlik:

1. Plan (varsayılan, hiçbir şey değiştirmez): `npx tsx scripts/rollback-0006.ts --db <dosya>` — hedef yalnızca `--db`; silinecek yedek kaydı sayısı, diskteki `.umbk` dosyaları (klasör + ad) ve tek kullanımlık doğrulama kodu yazılır.
2. Uygulama (uygulamanın **bütün** süreçleri kapalıyken): `--confirm <KOD>`; yedek kaydı varsa `--accept-data-loss`; hedef geçici dizinde değilse ayrıca `--allow-live-data --type-db-name <dosya-adı>`.

Geri alma `backups` tablosunu ve `leads_retention_idx`'i siler; **diskteki yedek dosyaları silinmez** (Faz 6 sürümü yeniden kurulunca "Yedek dosyası yükle" ile açılabilir). Önce yedek alınır ve doğrulanır; korunan tablolardaki satır sayısı, tablo/indeks kümesi, migrasyon sayısı, denetim kaydı ve yabancı anahtar bekçilerinden biri düşerse işlemin tamamı geri alınır. Testler: `tests/migration-0006.test.ts`.

## 5. Kararlar ve yol haritasından sapmalar

- **Yeni bağımlılık yok:** yedek biçimi `node:crypto` + `node:zlib`; PNG küçültücü (ekran görüntüleri) `node:zlib`; ağ çıkışı bekçisi Node'un kendi modüllerini sarar.
- **Kod imzalama varsayılan kapalı:** imzasız paketler çalışır, yalnızca ilk açılışta işletim sistemi uyarısı çıkar. Sertifikalar müşteri kararıdır; GitHub Actions sırları eklenince CI kendiliğinden imzalar (`PAKETLEME.md` Bölüm 6).
- **Windows'ta "Choose Installation Options" sayfası kaldı:** sayfayı kaldırmak tek tıklamalı kuruluma (`oneClick: true`) geçmeyi gerektirir; bu, kurulum klasörü seçimini ve kurulum sonu "çalıştır"ı kaldırdığı için yapılmadı. Sayfa electron-builder şablonunda yalnızca İngilizcedir; rehber **Only for me** seçtirir.
- **Yalnızca Apple Silicon** macOS paketi üretilir; Intel Mac için ayrı hedef müşteri kararına bağlı.
- **"Tüm verilerimi sil" ve geri yükleme yeniden başlatmada uygulanır:** açık veritabanı bağlantısı varken dosya değiştirilmez; bu yüzden ikisi de "planla → yeniden başlat" akışıdır ve yeniden başlatmadan önce iptal edilebilir.
- **Saklama süresi en çok 12 ay ve yalnızca kısaltılabilir;** temas edilmiş lead'ler (yasal kanıt) ve iletişim yasağı olanlar hiçbir süre ayarında silinmez.

## 6. Testler

Strateji (engineering:testing-strategy): saf kurallar (biçim, kesim tarihi, kurulum listesi) birim testinde; yedek/geri yükleme/silme gerçek geçici veri klasörü ve gerçek açılış betiğiyle; uçlar rota işleyicisi üzerinden; güvenlik korumaları bütün uç dosyalarını tarayan sözleşme testleriyle; gizlilik ağ çıkışı bekçisi altında ayrı süreçte; kullanıcı akışları üretim derlemesi üzerinde Playwright ile. Hiçbir testte gerçek dış API çağrılmaz, gerçek e-posta gönderilmez; yalnızca geçici klasörler kullanılır.

| Katman | Ne sınanır | Örnek dosyalar |
|---|---|---|
| Birim (saf) | `.umbk` biçimi (yanlış parola / bozuk / biçim dışı / gzip bombası / scrypt aralığı), saklama kesim tarihi, kurulum listesi adımları ve bağlantıları, bildirim yolu kuralı, paketleme yapılandırması | `backup-format`, `retention`, `onboarding-checklist`, `notifications`, `packaging-config` |
| Servis + veritabanı | Yedek alma ve döndürme, geri yükleme hazırlığı/uygulaması ve sonrası güvenlik, liste eşitleme, otomatik yedek işleri, silme kapsamı, migrasyon 0006 ve geri alma | `backup-service`, `backup-restore`, `backup-restore-reconcile`, `backup-edges`, `backup-auto-jobs`, `lifecycle-wipe`, `migration-0006` |
| Güncelleme yolu | 0000..0005'in her birinden yükseltme, üzerine kurulum, geçiş sonuç dosyası, kurtarma penceresi | `migration-upgrade-path`, `update-over-install`, `migrate-result`, `electron-migration-recovery` |
| Uç (rota) | Yedek ve veri uçları, hata kodları, idempotentlik | `backup-api`, `faz6-p0`, `api-error-text` |
| Güvenlik / gizlilik sözleşmesi | Her uç dosyası için Host/Origin/Sec-Fetch-Site, gizli bilgilerin diskte düz metin olmaması, `127.0.0.1` bağlama ve başlıklar, Electron sertleştirmesi, dış adres izin listesi, bekçinin kendisi | `security-route-guard`, `security-secrets-at-rest`, `security-server-bind`, `electron-hardening`, `egress-allowlist`, `egress-guard`, `privacy-card` |
| Performans | 100.000 lead'de 132 sorgu durumu, sorgu planı korumaları | `perf-100k` |
| Kabul | Paketler arası dikişler, gerçek açılış betiği ağ bekçisi altında | `faz6-acceptance` |
| Uçtan uca (Playwright) | Yedek → liste → geri yükleme penceresi → iptal; saklama önizlemesi ve kapalıyken metni; silmeyi planla → bant → iptal; kurulum listesi kartı; demo ilk gün boyunca dış bağlantı ve CSP ihlali yok | `e2e/backup`, `e2e/onboarding`, `e2e/privacy` |

**Son sayılar (16 Kasım 2026, üretim derlemesi):** Vitest **180 dosya, 3195 geçti, 1 atlandı**; kapsam **deyim 95,43 / dal 88,36 / fonksiyon 96,86 / satır 97,21** (eşikler 80/80/80/70). Playwright **124 geçti, 1 atlandı**, 0 başarısız / 0 kararsız (`CI=true TZ=UTC`, iki tam çalıştırma arka arkaya, her biri ~2,9 dk; atlanan test `e2e/faz5-templates` demo gönderim istatistiğidir ve yalnızca Londra'da hafta içi 09.00–17.00 gönderim penceresi açıkken koşar). Kılavuz ekran görüntüleri (`npm run docs:shots`, 12 adım, 33 görüntü) yeni metinlerle yeniden üretildi. `npm run build` ve `npm run build:worker` geçti.

### 6.1 Son inceleme turu

| Önem | Bulgu | Sonuç |
|---|---|---|
| P1 | Saklama süresi (varsayılan açık) hiç temas edilmemiş "İlgilenmiyor" lead'lerini siliyordu. Uygulamanın geri kalanı bu durumu iletişim yasağı sayar ama engel listesine satır yazmaz; lead silinince yeniden tarama/içe aktarma işletmeyi `new` olarak geri getirip yeniden uygun kılıyordu | **Düzeltildi:** adaylar yalnızca `new` ve `enriched`; "İlgilenmiyor" korunanlar listesinde (TR+EN kart metni ve kılavuz). Test: `retention` (aynı fikstürde "İlgilenmiyor" lead kalır) |
| P1 | Kurulum listesinde "Kendinize test e-postası gönderin" adımı Ayarlar → Gmail'e gidiyordu; test gönderimi orada yok | **Düzeltildi:** bağlantı `/mail-log?tab=health` (Gönderim günlüğü → Gönderim sağlığı → "Kendime test gönder"). Test: `onboarding-checklist`, `e2e/onboarding` |
| P1 | KURULUM 3.2 Windows sihirbazını yanlış anlatıyordu: dil sorusu yok, İngilizce "Choose Installation Options" sayfası anlatılmıyordu; yönetici hesabında "all users" UAC ile makine geneline kurar | **Düzeltildi (belge):** 3.2'de **Only for me** → **Next** adımı, dil cümlesi kaldırıldı; güncelleme bölümü ve 30 dakikalık listeye eklendi; `PAKETLEME.md` Bölüm 3'te gerekçe |
| P2 | Yedek başlığındaki scrypt maliyeti (doğrulanmamış) 2^20'ye kadar kabul ediliyordu: birkaç yüz baytlık hazırlanmış dosya istek başına ~1 GiB bellek ve saniyeler süren iş yükü yaratabiliyordu | **Düzeltildi:** okumada en çok `DEFAULT_LOG2N + 1` (2^18, ~256 MiB); üstü `BACKUP_BAD_FORMAT`. Uygulamanın yazdığı her yedek 2^17'dir, eski yedekler etkilenmez. Test: `backup-format` (19 ve 20 reddedilir) |
| P2 | Geri yüklemede eski `-wal/-shm/-journal` yeni dosya yerine konmadan önce siliniyordu; yeniden adlandırma düşerse eski veritabanının denetim noktasına yazılmamış işlemleri kayboluyordu | **Düzeltildi:** eski dosyalar kenara alınır (`.restore-old`), yeniden adlandırma düşerse geri konur, başarıda silinir. Test: `backup-edges` (yeniden adlandırma hatası benzetimi; WAL/SHM aynen döner) |
| P2 | "Otomatik yedek alınamadı" ve "Eski kayıtlar silindi" bildirimleri Ayarlar'ın en üstünü açıyordu | **Düzeltildi:** `/settings#backup`; bildirim yolu kuralı (sunucu ve istemci kopyası aynı) sonda `#[A-Za-z0-9_-]{1,64}` çapasını kabul eder, nokta bölümü/çift eğik çizgi korumaları çapadan önce de geçerli. Test: `notifications`, `backup-auto-jobs`, `retention` |
| P2 | Otomatik silme kapalıyken kart yine "Şu an silinecek: N" diyordu | **Düzeltildi:** kapalıyken "Süresi dolmuş kayıt: N (otomatik silme kapalı; yalnızca “Şimdi uygula”ya basarsanız silinir)" (TR+EN). Test: `e2e/backup` |
| P2 | Ayarlar'daki gizlilik kartı ve KULLANIM 3.4 "demo modunda internete hiç bağlanılmaz" diyordu; demo yalnızca veri sağlayıcılarını değiştirir, bağlanan Gmail ve çıkış sunucusu kullanılır | **Düzeltildi:** "Demo veri kaynağında Google'a ve diğer veri servislerine bağlanılmaz; bağladığınız Gmail kutusu ve çıkış sunucusu yine kullanılır" (TR+EN, kılavuz). Test: `e2e/privacy` |
| P2 | Kılavuz masaüstündeki "Klasör seç…" ve ardından **Kaydet** adımını anlatmıyordu; masaüstünde yedek klasörü etiketi bir `<p>`'ye bağlıydı | **Düzeltildi:** KULLANIM 4.1/3 "Klasör seç… → Kaydet", tarayıcı görüntüsü notu; masaüstünde salt okunur `Input` (etiket bağlanabilir öğeye). Ekran görüntüleri tarayıcı görünümünden kaldı (masaüstü köprüsü taklit edilmedi) |
| P2 | KURULUM §4 veri klasörünü `…/Universal Mail` gösteriyordu; **Yardım → Veri klasörünü aç** `…/Universal Mail/data`'yı açar | **Düzeltildi:** tablo `…/data`, üst klasör ayrıca açıklandı (KULLANIM 7.9 ile aynı) |
| P2 | macOS'te devretmeden önce silme adımı **Yedek dosyalarını da sil**'i söylemiyordu (varsayılan işaretsiz; yedekler parolayla şifreli anahtarları ve Gmail bağlantısını içerir); silme sonrası açılışın yeniden oluşturduğu boş klasör anlatılmıyordu | **Düzeltildi:** KURULUM 6.2 ve KULLANIM 5.2'ye kutuyu işaretleme ve `~/Library/Application Support/Universal Mail` klasörünü silme adımı |
| P2 | Yol haritasında yalnızca kılavuz maddesi işaretliydi; Faz 6 notları yoktu | **Düzeltildi:** bu belge; `02-YOL-HARITASI.md` Faz 6 maddeleri işaretlendi (müşteri gerektirenler açık, notlu) |
| P2 | CSP `script-src` içinde `'unsafe-inline'`, `'unsafe-eval'` ve `https://*.google.com` var; Maps anahtarı yokken de | **Ertelendi:** nonce tabanlı CSP bütün sayfaları dinamik işlemeye geçirmeyi ve ara katmanın (veritabanına erişemeyen kenar çalışma ortamı) ayara göre başlık üretmesini gerektirir; Maps'in daraltılmış listeyle çalıştığı gerçek anahtar olmadan doğrulanamaz. Bugünkü risk düşüktür: arayüzde `dangerouslySetInnerHTML` yok, React çıktıyı kaçışlar, e-posta önizlemesi kendi katı CSP'li `srcdoc` çerçevesindedir. Bölüm 9 |

## 7. Kabul ölçütü ve kanıtı

> "Temiz bir bilgisayarda (Node/terminal olmadan) kurulum dosyasıyla 30 dakikada kurulup ilk tarama yapılır (NFR-06); geliştiricinin bilgisayarı kapalıyken de çalışır."

Otomatikleştirilebilen kısım `tests/faz6-acceptance.test.ts` ile, uygulamanın **gerçek açılış yolu** (`scripts/migrate.ts`: bekleyen işlem → şema geçişi → yedek listesi eşitleme → sonuç dosyası) ayrı bir süreçte ve **ağ çıkışı bekçisi engelleme kipinde** yüklüyken kanıtlanır:

1. **Temiz kurulum → ilk açılış:** bütün geçişler uygulanır; kurulum listesi boş, yedek ve güncelleme öncesi kopya yok; ikinci açılış hiçbir şey değiştirmez.
2. **Güncelleme (0000 şemasından güncele):** veri korunur; güncelleme öncesi kopya (K) yedek ekranında (Y) sayılır; "Tüm verilerimi sil" (Y) bu kopyayı ve doğrulama işaretini (K) de siler, şifreli yedek kalır ve listeye geri eklenir.
3. **Yedek → değişiklik → geri yükleme** gidiş-dönüşü açılış betiğiyle uygulanır; veriler, gizli bilgiler ve şema bire bir döner; kurulum listesinin yedek adımı tamamlanır.
4. **100.000 lead'de Keşfet açılış sorguları** < 300 ms (CI'da 900 ms gerileme koruması; ayrıntılı ölçüm `perf-100k`).
5. **Demo kipinde bir ilk gün** (kurulum, tarama, e-posta bulma, yedek, kurulum listesi) hiçbir dış bağlantı denemesi yapmaz; bekçi kaydı boş. Arayüz dahil tam akış `e2e/privacy.spec.ts`'te (tarayıcı yalnızca `127.0.0.1`, `data:`, `blob:`; CSP ihlali yok; pozitif kontrolde Google modu + sahte anahtarla `places.googleapis.com` denemesi engellenip kaydedilir).
6. **Statik dikişler:** Windows kaldırıcısının "verilerimi de sil"i ile uygulama içi silme aynı veri klasörünü hedefler; silme sonrası ana süreç adımı bağlıdır.

"Node/terminal olmadan" ve "geliştiricinin bilgisayarı kapalıyken" kısmı paketin yapısıyla sağlanır: Electron kendi Node'unu taşır; web sunucusu, işçi ve şema geçişi `resources/server` altındadır; geliştiriciye giden hiçbir adres yoktur (`egress-allowlist`). CI'da paket işi `npm run smoke` ile paketlenmiş uygulamayı açar. **Kanıtlanmayan:** gerçek temiz bir Mac ve Windows'ta indirme → kurulum → ilk tarama süresinin 30 dakikanın altında kaldığı; bu, kullanıcının makinesinde [`KURULUM.md`](KURULUM.md) Bölüm 7 kontrol listesiyle yapılır (Bölüm 10).

## 8. Uygulanan beceriler (Skills applied)

| Beceri | Nerede, nasıl |
|---|---|
| **backend-design** (think-before-coding, error-handling-as-design, idempotency, migration-safety, security-discipline) | Geri yükleme ve silme "planla → yeniden başlatmada uygula" olarak tasarlandı (açık bağlantı altında dosya değiştirilmez); her adım kopyala-sonra-adlandır, hata yolunda eski WAL geri konur. Saklama silmesi önizleme sayısına bağlı (bayat önizleme 409), gruplar hâlinde ve her grupta koşul yeniden değerlendirilerek. Uçlar idempotent (iptal, kapatma, kart gizleme). Migrasyon yalnızca ekleyen, geri alma iki aşamalı ve bekçili. Güvenilmeyen yedek başlığındaki maliyet, işe başlamadan önce sınırlandı. |
| **testing-with-discernment** | Her bulgu için en ucuz yeterli katman: saklama kuralı gerçek veritabanı fikstürüyle, WAL güvenliği gerçek dosyalar + tek noktada `renameSync` hatası benzetimiyle, metin değişiklikleri Playwright'ta kullanıcıya görünen hâliyle. Regresyon testleri bulgu senaryosunu birebir kurar (eski kod bu testlerde başarısız olur). |
| **engineering:testing-strategy** | Bölüm 6'daki piramit: saf kurallar → servis + geçici veritabanı → gerçek açılış betiği (ayrı süreç, ağ bekçisi) → üretim derlemesinde e2e. Dış servisler hiçbir testte gerçek değildir. |
| **design** (ux-copy, accessibility) | Gizlilik iddiası gerçeğe çekildi; kapalı otomatik silmede "silinecek" yerine durumu söyleyen metin; bildirimler ilgili bölüme gider; salt okunur yol alanı etiketlenebilir öğe. |

## 9. Bilinen sınırlar ve açık kalanlar (kod)

- **CSP sertleştirmesi (Bölüm 6.1, ertelendi):** nonce tabanlı `script-src`, Maps kaynaklarının yalnızca Maps anahtarı varken eklenmesi. Gerçek Maps anahtarıyla paketli uygulamada doğrulama gerektirir.
- **Electron ana süreci ve Chromium arka plan hizmetleri** ağ bekçisinin kapsamı dışındadır (yalnızca sahte oturumla birim testi); paketli uygulamanın temiz makinede ağ izlemesi açık kalemdir (`GUVENLIK.md` Bölüm 9).
- **`CORRUPT` kurtarma penceresinde `.umbk`'den geri yükleme yok:** şifreli yedekler yalnızca açık uygulamadan geri yüklenir (`PAKETLEME.md` Bölüm 9).
- **Kılavuz ekran görüntüleri tarayıcı görünümündendir;** masaüstüne özgü düğmeler metinde anlatılır.
- **Yükleme sınırı 9 MiB:** daha büyük yedekler masaüstünde "Dosya seç…" ile yol olarak açılır (tarayıcıda açılamaz).
- **`perf-100k` CI ölçümü:** ilk CI koşusunun `[perf]` satırları `GUVENLIK.md` Bölüm 8'e işlenecek.
- **NSIS betiği yalnızca CI'da derlenir;** kaldırma sorusu temiz bir Windows'ta elle denenmelidir.

## 10. Kullanıcıdan beklenenler

Yazılım bu işler için hazırdır; her biri müşterinin hesabını, parasını, makinesini veya kararını gerektirir. Liste [`TESLIM.md`](TESLIM.md) Bölüm 7'deki açık kararları kapsar (ek olarak teslim öncesi denemeleri içerir) ve teslim günü birlikte okunur.

| Bekleyen | Neden gerekli | Ne yapılacak / doğrulanacak | Sahibi |
|---|---|---|---|
| Kod imzalama sertifikaları | İmzasız paket çalışır ama ilk açılışta macOS ve Windows uyarı gösterir | Apple Developer üyeliği (imza + notarize) ve/veya Windows kod imzalama sertifikası; GitHub Actions sırları eklenince CI kendiliğinden imzalar (`PAKETLEME.md` Bölüm 6) | Müşteri (ücretli) |
| Gerçek temiz makinede 30 dakikalık deneme | Kabul ölçütünün süre kısmı ve işletim sistemi pencereleri yalnızca gerçek makinede görülebilir | Temiz bir Mac ve temiz bir Windows'ta `KURULUM.md` Bölüm 7 kontrol listesi; Windows'ta "Only for me" sayfası, SmartScreen, kaldırma sorusu; üzerine kurarak güncelleme; uyarı pencerelerinin ekran görüntüleri; ağ izleme (Little Snitch / Kaynak İzleyicisi) | Müşteri makinesi + geliştirici |
| Teslim toplantısı | Kurulum, müşteri hesabıyla ilk tarama ve ilk test e-postası birlikte yapılır; kısa eğitim | `TESLIM.md` Bölüm 2, 3 ve 6 (imza listesi) | İki taraf |
| Bakım dönemi başlangıç tarihi ve süresi | Anlaşma Notu'nda süre kararı bekliyor | `TESLIM.md` Bölüm 5 alanları teslim günü yazılır | İki taraf |
| Kaynak kodun kimde kalacağı ve kullanım hakları | Anlaşma Notu'nda satır henüz doldurulmadı | `TESLIM.md` Bölüm 4 tablosu yazılı karara bağlanır | İki taraf |
| Çıkış sunucusunun (Cloudflare Worker) dağıtımı | HTTPS tek tıklamalı çıkış ucu olmadan canlı gönderim yapılmaz | Müşteri adına ücretsiz Cloudflare hesabı; `deploy/cloudflare-worker/README.md` (D1 şeması, anahtarlar, `/healthz`, uçtan uca doğrulama) | Müşteri (Cloudflare hesabı) |
| Müşterinin Gmail hesabına erişim | Canlı gönderim, aynı konuşmada takip ve gelen kutusu okuma yalnızca sahte Gmail sunucusuyla sınandı | Gmail bağlantısı (Ayarlar → Gmail), kendine test e-postası, gönderen hesap türü kararı (kişisel @gmail.com veya Google Workspace + SPF/DKIM/DMARC) | Müşteri |
| Intel işlemcili Mac desteği | Yalnızca Apple Silicon paketi üretiliyor | Gerekiyorsa ayrı x64 hedefi eklenir | Müşteri kararı |
| Google Maps anahtarı ile harita doğrulaması | CSP Google'ın izin listesine göre ayarlı ama anahtarlı harita hiçbir testte yüklenmedi | Paketli uygulamada Keşfet haritası; konsolda CSP ihlali olmamalı | Müşteri anahtarı + geliştirici |
| **Önceki fazlardan açık:** canlı kapılar, hedef ülke onayları, uyum metninin hukuki gözden geçirmesi, gerçek Google/sicil/Claude/Hunter/Snov anahtarlarıyla deneme | Yazılımda hazır, gerçek hesap ve hukuki karar gerektirir | [`10-CANLIYA-GECIS.md`](10-CANLIYA-GECIS.md), [`12-FAZ5-NOTLARI.md`](12-FAZ5-NOTLARI.md) Bölüm 10, [`UYUM.md`](UYUM.md) | Müşteri + hukuk |
