# Faz 3 — Şablonlar, Kampanya, Gönderim, Uyum: Uygulama Notları

**Durum (11 Kasım 2026): Demo geliştirmeleri ve canlı entegrasyonun yazılım hazırlığı tamamlandı; Faz 3 canlı doğrulama, hukuki onaylar ve pilot bekliyor.** Faz 3'ün 14 demo aşaması ve 8 canlı hazırlık aşaması (15.1–15.8) `feat/faz-3` dalında kodlandı; her aşamanın CI sonucu GitHub üzerinde yeşil doğrulandı (son kod aşaması: `e30d0e9`). **Faz 3 resmi olarak KAPANMADI:** gerçek Gmail hesabı, gerçek gelen kutusu, genel HTTPS çıkış uç noktası ve alan adı, gerçek DNS doğrulaması, hukuki onaylar, canlı ülke politikaları ve pilot kabulü yoktur (Bölüm 7–9). Gerçek e-posta gönderimi ve gerçek gelen kutusu okuma kodda **kapalıdır**; bu belge o kapıları açmaz.

> Bu belge yalnızca kod ve testlerle doğrulanmış olanı "yapıldı" diye yazar. Kısmi olan, sahte sunucu/simülasyonla çalışan veya gerçek hesap/alan adı/hukuki onay isteyen her şey açıkça işaretlidir. Gerçek ortam doğrulamaları ve kilidin hangi sırayla açılacağı: [`09-FAZ3-CANLI-DOGRULAMA.md`](09-FAZ3-CANLI-DOGRULAMA.md).

## 1. Ne yapıldı

Simgeler: ✔ yapıldı ve test edildi · ◐ kısmen (sahte sunucu/demo/simülasyon kapsamında) · ✘ yapılmadı.

| Kalem | Durum | Not |
|---|---|---|
| Veri modeli (`0002_faz3`) | ✔ | `mailboxes`, `templates`, `campaigns`, `campaign_steps`, `campaign_leads`, `messages`, `suppressions`, `country_policies` (Bölüm 3). **15.1–15.8'de yeni migrasyon eklenmedi** |
| Ülke politikası tablosu ve uygunluk kontrolü | ✔ | Demo ve canlı kapsamlar ayrı; **canlı politikaların tamamı engelli ve kilitli**; demo politikası yalnızca sıkılaştırılabilir |
| Suppression (e-posta, alan adı, CSV, elle) | ✔ | Açık adres tutulmaz (özet + maskeli gösterim); çıkış/şikâyet/silme nedenleri sıradan işlemle kaldırılamaz |
| Suppression — otomatik kaynaklar (bounce, yanıt, çıkış, şikâyet) | ◐ | Kod ve testler var (kanıt katmanları L1–L4); **gerçek tasdik kaynağı yok**: demo simülasyonu veya kapalı kilitli Gmail başlık güveni (Bölüm 5) |
| Gönderim uygunluğu ve temas sıklığı (SRS 5.6.1) | ✔ | Dizide en çok 3 ileti, takip arası ≥ 5 gün, 180 gün dinlenme, 30 gün kampanyalar arası, alan adı başına günde 1 ileti; yalnızca sıkılaştırılabilir |
| Kişisel posta alan adlarını hariç tutma; gönderen profili olmadan kilit | ✔ | |
| Şablon motoru, değişkenler, eksik veri uyarısı, dil bazlı şablon, canlı önizleme, TR/EN hazır şablonlar | ✔ | Yerleşik şablonlar salt okunur (kopyalanır); kampanyada kullanılan şablon kilitli; sürüm kilidi |
| İçerik kontrolü ve "kendime test gönder" | ◐ | Test yalnızca **demo kutusunun kendi adresine**; gerçek sağlayıcıya gitmez |
| Zorunlu alt bilgi motoru | ◐ | Unvan, adres, vergi/sicil numarası, telefon, çıkış bağlantısı otomatik eklenir. **MERSİS ve ticaret sicil alanları isteğe bağlı olarak eklendi (15.1)**; zorunluluk kuralı hukuken belirlenmedi (`trSenderIdentifierRules: false`). Demo ileti çıkış bağlantısı `.invalid`; canlı iletide doğrulanmış HTTPS bağlantı zorunlu |
| MIME oluşturucu ve güvenli başlıklar | ✔ | `List-Unsubscribe` yalnızca güvenli HTTPS ile; `List-Unsubscribe-Post` yalnızca **saklanan uçtan uca doğrulama kanıtıyla** (şu an kanıt yok → eklenmez) |
| Gönderim servisi ve zamanlayıcı | ✔ | Tek adım/tur; günlük tavan (20 → 80), ısınma, 90–240 sn aralık, alıcı yerel saat penceresi (hafta içi 09–17), yeniden deneme ≤ 3, sonucu belirsiz ileti **asla** otomatik tekrarlanmaz. Canlı kutu kapılar kapalıyken hiçbir şey yapmaz |
| Kampanya yönetimi (taslak/hazır/başlat/duraklat/devam/iptal) | ✔ | Başlatma onay belirteci şablon sürümlerini ve firma profilini kapsar |
| Kampanya sihirbazı, başlat öncesi özet ve ilk 5 önizleme | ✔ | |
| Şablon ve uyum ekranları | ✔ | Kampanyalar · Şablonlar · Uyum · Günlük alt gezinmesi (üst çubuk 4 sabit öğe) |
| Gelen ileti işleme (DSN, yanıt, çıkış, olumsuz, ARF şikâyet) | ◐ | 4 katmanlı kanıt; gerçek tasdik kaynağı yok (Bölüm 5) |
| Otomatik durdurma — kampanya düzeyi | ✔ | ≥ 20 alıcı, ≥ 2 doğrulanmış bounce'lu alıcı, ≥ %5 |
| Otomatik durdurma — posta kutusu düzeyi (SRS 5.6.1: %3 bounce) | ◐ | Bounce tarafı tam; **şikâyet oranı (%0,1) ölçülemiyor** ve öyle gösterilir; ARF sayısı yalnızca kısmi kapsam alt sınırıdır (Bölüm 5) |
| Gönderim günlüğü ve işlem kaydı (+ yalnızca maskeli CSV) | ✔ | |
| SPF/DKIM/DMARC denetimi ve sonucunun saklanması | ◐ | Kural değerlendirmesi, sonuç saklama (yalnızca durumlar) ve hazırlık ekranı testli; **gerçek alan adı üzerinde hiç sorgu çalıştırılmadı** |
| Silme talebi (FR-CMPL-03) | ◐ | Akış, API ve ekran var; gerçek gönderim kayıtları ve engel özeti **hukuki değerlendirme bekliyor** |
| Canlı gönderime hazırlık ekranı | ✔ | Salt okunur; 19 madde; gerçek gönderimi açmaz; hiçbir madde beyanla "tamam" olmaz |
| `docs/UYUM.md`, `docs/LIA.md` | ◐ | UYUM **taslak**; LIA yalnızca **iskelet** (teknik olgular güncel); ikisi de hukuk onayı bekliyor |
| **Gmail OAuth çekirdeği (15.3)** | ◐ | PKCE, state, kademeli yetkilendirme (varsayılan yalnızca gönderim), imzalı kimlik belirteci doğrulaması (JWKS), belirteç yenileme; **yalnızca yerel sahte OAuth sunucusuyla** sınandı |
| **Gmail gönderim bağdaştırıcısı (15.4)** | ◐ | `gmail.send`; kabul/kesin ret/belirsiz ayrımı, belirsiz asla tekrar gönderilmez; **yalnızca sahte Gmail sunucusu**; canlı kilit kapalı |
| **Gmail gelen kutusu okuyucusu (15.5)** | ◐ | `gmail.readonly`, sayfalama, `historyId`, veri azaltma; **yalnızca sahte sunucu**; okuma kilidi ve başlık güven kilidi kapalı |
| **HTTPS abonelikten çıkış altyapısı (15.6–15.7)** | ◐ | Ed25519 imzalı belirteç, RFC 8058 aktarıcı işleyicisi, dayanıklı dosya kuyruğu, imzalı çekme kanalı, uçtan uca doğrulama kanıtı; **gerçek alan adı/HTTPS sunucusu/TLS yok** |
| **Birleşik gönderim kapısı (15.7)** | ✔ | `isLiveSendingPermitted()`: sabit bayrak VE her `LEGAL_APPROVALS` maddesi |
| **ARF (RFC 5965) şikâyet işleme (15.8)** | ◐ | Ayrıştırıcı, kanıt katmanları, korumalı `complaint` engeli, kısmi kapsam sayacı; **gerçek FBL yok**, güvenilir rapor sağlayıcı listesi boş |
| SMTP | ✘ | Planlanmadı (yeni paket gerektirir; önce onay) |
| Pilot kabulü (SRS Bölüm 13/6–8, günde ≤ 20) | ✘ | Başlamadı |

### Aşama aşama (commit)

Demo aşamaları: 1. `09837ae` tablolar (`0002_faz3`) · 2. `57618bd` politika/demo kutusu/şablon seed'leri · 3. `782e820` politika servisi · 4. `b0c44ef` suppression servisi · 5. `707c8eb` uygunluk ve temas sıklığı · 6. `3912076` şablon motoru ve alt bilgi · 7. `7889987` MIME · 8. `ade9095` FakeMailProvider ve gönderim servisi · 9. `d511b95` zamanlayıcı ve kuyruk · 10. `e9e9501` kampanya yönetimi · 11. `9f3c7e9` kampanya arayüzü · 12. `4b57312` şablon editörü, ülke politikası ve suppression yönetimi (CI 42699793397) · 13. `e3bf1c8` gelen ileti işleme, otomatik durdurma, günlük (CI 42717880446) · 14. `b8627f5` posta kutusu sağlığı, silme talebi, hazırlık ekranı (CI 42726495692) · `265e9ca` ilk durum belgesi.

Canlı hazırlık aşamaları (şirket bilgisinden bağımsız yazılım işleri; hepsi gerçek hesap/alan adı olmadan, sahte sunucularla):

| Aşama | Commit | İçerik |
|---|---|---|
| 15.1 | `5b5475f` | TR kurumsal tanımlayıcılar (MERSİS, ticaret sicil), isteğe bağlı alanlar |
| 15.2 | `b01e486` | Posta kutusu yapılandırması ve gizli bilgi adları (Gmail, bağlantısız) |
| 15.3 | `a2c631c` | Gmail OAuth çekirdeği, kademeli yetkilendirme, imzalı kimlik belirteci (JWKS doğrulaması; CI 42816482986) |
| 15.4 | `178a3b3` | Gmail gönderim bağdaştırıcısı; 401/ret/belirsiz sınıflandırması |
| 15.5 | `a1e00ca` | Gmail gelen kutusu okuyucusu; başlık güven kilidi (kapalı) |
| 15.6 | `f56ad93` | Ed25519 çıkış belirteci, RFC 8058 aktarıcı, dayanıklı teslimat sözleşmesi |
| 15.7 | `35cb7d3` | Dayanıklı kuyruk + imzalı kanal, uç nokta doğrulama kanıtı, DNS saklama, birleşik gönderim kapısı |
| 15.8 | `e30d0e9` | ARF şikâyet işleme, kısmi kapsam sayacı |
| 15.9 | (bu belge) | Belgeler ve canlı doğrulama listesi (yalnızca `docs/`) |
| 15.10-0 | `ac31268` | `SQLITE_BUSY` sonrası bağlantının kendiliğinden yenilenmesi |
| 15.10-1 | `abd61f8` | Migrasyon `0003`: `messages.classification` CHECK'ine `complaint`, `campaign_leads.stop_reason` (`unsubscribe`/`complaint`), mevcut işaretli satırların geri doldurulması, bakım kilidi, korumalı geri alma (`scripts/rollback-0003.ts`) |
| 15.10-2 | — | **Henüz yok:** kodun yeni sütunlara geçmesi (geri alma için eski işaretlerle çift yazım). O zamana kadar kod eski işaretleri yazar ve okur (Bölüm 6, TB-1/TB-2); ayrıca onay şart |

**Testler (15.8 sonu):** Playwright 49 senaryo (CI yeşil). Yerel Vitest 1415 test: 1255 geçti, 10 atlandı, **150 düştü** — bunlar Windows'ta dosya tabanlı testlerin `libsql` dosyası kapandıktan sonra klasör silinemediği (`EPERM`) ve POSIX/yol biçimi farkları nedeniyle düşen **bilinen ortam hatalarıdır; aşama aşama aynı 150'dir**. **Linux CI belirleyicidir ve yeşildir.** Yerel düşmeler gizlenmedi ve test yapılandırması değiştirilmedi. Yeni güvenlik kuralları mutasyon kontrolüyle (kuralı bozunca testin düşmesi) sınandı.

## 2. API uçları (Faz 3)

| Uç | Açıklama |
|---|---|
| `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/{id}`, `PUT …/steps`, `GET/POST …/leads`, `DELETE …/leads/{clId}`, `GET …/messages` | Kampanya oluşturma, adımlar, lead ekleme/çıkarma, kuyruk ve iletiler. Eşzamanlılık: monoton `updated_at` kilidi |
| `GET /api/campaigns/{id}/preflight`, `POST …/control` | Başlat öncesi özet ve onay belirteci; `ready/draft/start/pause/resume/cancel` (tek işlem + denetim kaydı) |
| `GET /api/campaigns/review` | Sonucu belirsiz (`unknown`) gönderimler |
| `GET/POST /api/templates`, `GET/PATCH …/{id}`, `POST …/{id}/archive`, `POST …/{id}/duplicate`, `POST …/preview` | Şablon yönetimi, sürüm kilidi, taslak önizleme |
| `GET/PATCH /api/compliance/policies` | Ülke politikaları (PATCH yalnızca **demo** ve yalnızca sıkılaştırır) |
| `GET/POST /api/compliance/suppressions`, `…/import`, `…/{id}/lift` | Engel listesi; kaldırma açık onay + gerekçe ister, korumalı nedenler (çıkış, şikâyet, silme) kaldırılamaz |
| `GET/PATCH /api/compliance/auto-stop` | Kampanya düzeyi eşikler (yalnızca sıkılaştırma) |
| `GET/PATCH /api/compliance/mailbox-limits` | Posta kutusu düzeyi eşikler (yalnızca sıkılaştırma) |
| `GET/POST /api/mailboxes`, `PATCH/DELETE …/{id}` | Posta kutusu listesi, Gmail kutusu ekleme (bağlantısız), ad/durum değişikliği, silme (demo ve bağlı kutu değiştirilemez/silinemez) |
| `GET/PUT/DELETE /api/mailboxes/gmail-client` | Gmail OAuth istemci kimliği ve sırrı (sır yalnızca şifreli gizli depoya yazılır, maskeli bile geri döndürülmez) |
| `GET …/{id}/oauth`, `POST …/{id}/oauth/start`, `POST …/{id}/oauth/disconnect`, `GET /api/oauth/gmail/callback` | Yetkilendirme durumu, başlatma (varsayılan yalnızca gönderim; okuma ayrı yükseltme), bağlantıyı kesme (yetkiyi iptal etmeyi dener), geri çağrı. **Gerçek Google'a karşı hiç çalıştırılmadı** |
| `GET /api/mailboxes/{id}/health`, `POST …/{id}/health/reenable` | Sağlık görünümü (bounce oranı, şikâyet kısmi kapsam sayacı), onaylı yeniden etkinleştirme |
| `POST /api/mailboxes/{id}/test-send`, `POST …/{id}/dns-check` | Kendime test (yalnızca demo); DNS denetimi (demo kutusunda sorgu yok; gerçek kutuda sonuç durumlar halinde saklanır) |
| `GET /api/inbox/review`, `POST …/{id}` | İnceleme kuyruğu ve kullanıcı kararı (şikâyet raporunda yalnızca "yok say") |
| `GET /api/mail-log`, `/export`, `GET /api/audit`, `/export` | Günlük ve işlem kaydı; CSV'de yalnızca maskeli adres, bilinmeyen parametre reddedilir |
| `GET/POST /api/compliance/erasure`, `POST …/preview` | Silme talebi (önizleme yalnızca sayı) |
| `GET /api/compliance/live-readiness` | Salt okunur hazırlık listesi |
| `GET /api/leads/{id}/campaigns` | Lead'in kampanyalardaki durumu (adres yok) |
| `POST /api/unsubscribe/{token}` | **Yalnızca demo** çıkış çekirdeği (GET işlem yapmaz; alıcılar ulaşamaz) |
| `POST /api/dev/inbox` | Demo gelen kutusu simülatörü; `FAZ3_DEMO_INBOX_ENABLED` kapalıyken **404** |

**API'si olmayanlar (yalnızca servis işlevi):** HTTPS çıkış adresinin ayarlanması ve uç nokta doğrulaması (`setUnsubscribeBaseUrl`, `verifyOneClickEndpoint`), güvenilir ARF rapor sağlayıcı listesi (`setTrustedReporters`), imza/kanal anahtarı üretimi/döndürme/iptal. Aktarıcı (`src/lib/unsubscribe/relay.ts`) uygulamadan ayrı çalışacak taşınabilir bir modüldür; uygulamada bir rotası yoktur.

## 3. Veri modeli, iç ayarlar, gizli bilgiler ve kilitler

**Tablolar:** `0002_faz3` ile eklenenler: `mailboxes` (`credentials_ref` yalnızca gizli depodaki kayıt adı), `templates`, `campaigns`, `campaign_steps`, `campaign_leads` (alıcı adresi + özet; silme talebinde boşaltılır), `messages` (giden ve gelen; gövde saklanmaz), `suppressions` (e-posta özeti `sha256-v1`, maskeli adres), `country_policies`. Gönderim geçmişi olan lead/kampanya/şablon silinemez (`ON DELETE RESTRICT`). **15.1–15.8'de hiçbir migrasyon eklenmedi**; yeni durum yalnızca ayarlar tablosunda ve gizli depoda tutulur.

**İç ayar anahtarları** (ayarlar API'si bunları YAZAMAZ; katı şema): `seed.faz3`, `mail.autoStop`, `mail.mailboxLimits`, `mail.mailboxHalts`, `mail.gmailOAuth` (istemci kimliği), `mail.gmailGrants` (kutu başına gönderim/okuma izni), `mail.unsubscribeKeys` (çıkış imza anahtarlarının GENEL kısmı), `mail.unsubscribeChannel` (kanal anahtarlarının genel kısmı), `mail.unsubscribeEndpoint` (adres, doğrulama kanıtı, teslimat sağlığı), `mail.dnsReports` (kutu başına DNS durumları), `mail.inboxSync` (son gerçek eşitleme sonucu), `mail.arfReporters` (güvenilir ARF rapor sağlayıcı alan adları; varsayılan boş).

**Şifreli gizli depo adları** (`secrets.json`; değerler SQLite'a, günlüğe veya denetime ASLA yazılmaz): `gmail.oauthClientSecret`, `gmail.refreshToken.<kutu>`, `unsubscribe.signingKey.<kid>`, `unsubscribe.channelKey.<kid>`. Erişim belirteci yalnızca bellektedir.

**Kilitler (kodda sabit; kullanıcı beyanı, ayar veya ortam değişkeniyle AÇILAMAZ):**

| Sabit | Değer | Engellediği |
|---|---|---|
| `LIVE_SENDING_ENABLED` (`policies.ts`) | `false` | Gerçek gönderim |
| `LIVE_INBOX_READING_ENABLED` (`policies.ts`) | `false` | Gerçek gelen kutusu okuma |
| `GMAIL_HEADER_TRUST_VERIFIED` (`policies.ts`) | `false` | Gmail başlıklarından tasdik üretme (Bölüm 5) |
| `LEGAL_APPROVALS` (`legal-status.ts`) | 7 madde, hepsi `false` | Gönderim yolu (birleşik kapı) ve hazırlık ekranı |
| `isLiveSendingPermitted()` (`live-gate.ts`) | bayrak VE tüm onaylar | Uygunluk, gönderim, ileti kurucusu, içerik, Gmail sağlayıcısı |

**İş türleri ve ortam bayrakları (hepsi varsayılan KAPALI; yalnızca E2E sunucusunda `e2e/serve.mjs` demo bayrakları açıktır):** `mail.send` (`FAZ3_DEMO_SCHEDULER_ENABLED`), `inbox.sync` (`FAZ3_DEMO_INBOX_ENABLED`), `unsubscribe.drain` (`UM_UNSUBSCRIBE_DRAIN_ENABLED` ve yapılandırılmış çıkış adresi birlikte gerekir; hiçbir yerde açılmadı).

## 4. Google verisi ve kişisel veri

- Google içeriği (işletme adı, açılış tarihi) iletinin gövdesinde/kalıcı kayıtta tutulmaz; konu satırı Google kaynaklı değişkenler maskelenmiş saklanır (`subject_logged`).
- Gelen ileti gövdesi ve gönderen adresi saklanmaz (özet ve alan adı). **Gmail gelen kutusundan yalnızca bizim giden iletilerimizle ilişkili (Message-ID, DSN/ARF'deki özgün kimlik veya konuşma) iletiler işlenir; ilgisiz gerçek posta hiç saklanmaz.** SENT/DRAFT/SPAM/TRASH iletileri işlenmez.
- ARF raporlarından yalnızca sınıflandırma, durum ve eşleşen ileti saklanır; raporun içeriği ve alıcı adresi saklanmaz (engel adresi kampanya alıcısı kaydından gelir).
- Çıkış belirteçleri kişisel veri içermez (adres yok; alıcı bağı gizli anahtarlı etiket); denetim kayıtları belirteç veya adres içermez.
- DNS sonuçları yalnızca durum ve neden kodlarıdır (ham TXT yok).
- Dışa aktarmalarda adresler yalnızca maskelidir (`i***@alan.adı`); tam adres dışa aktarımı yoktur.

## 5. Kararlar ve SRS'den sapmalar

- **Gerçek gönderim kodda kapalı ve iki anahtarlı:** `LIVE_SENDING_ENABLED = false` ve `LEGAL_APPROVALS` içinde hepsi `false`. Gönderim yolu bunları BİRLİKTE denetler (`isLiveSendingPermitted`); bayrağın yanlışlıkla açılması hukuki onay olmadan gönderim doğurmaz. Canlı kapsamın bütün politikaları engelli ve kilitli; kilit yalnızca hukuki onayla yeni yazılım sürümünde açılır.
- **Sağlayıcı sözleşmesi:** `MailProvider` (sonuç `accepted`/`rejected`/`unknown`; `unknown` asla otomatik tekrarlanmaz) ve `InboxReader`. Gerçek uygulamalar: Gmail bağdaştırıcıları (yalnızca sahte sunucularla sınanmış). **Gmail API birincil (SRS); SMTP alternatif olarak planlanmadı** — eklenirse yeni paket (`nodemailer`) için önce onay gerekir.
- **Kademeli Gmail yetkisi:** varsayılan yalnızca `gmail.send` (+ `openid email`); `gmail.readonly` yalnızca ayrı, açık bir yükseltmeyle. `gmail.modify` veya tam erişim ASLA istenmez. Workspace yapılandırması (Dahili/Harici) varsayılmadı.
- **Gönderimde sınıflandırma güvenliği (15.4):** kesin ret yalnızca Google'ın belgelenmiş hata zarfı (`error.code` HTTP durumuyla aynı + beklenen `status`/`reason`) doğrulanırsa; bozuk/eksik/beklenmeyen yanıt `unknown` sayılır ve **asla otomatik tekrar gönderilmez**. 401'de belirteç yenileme ve tek tekrar yalnızca Google'ın tanınan kimlik doğrulama hatasında.
- **Gelen iletiye güven (Aşama 13, 15.5):** Message-ID eşleşmesi tek başına kanıt değildir. Otomatik etki (suppression, dizi durdurma, kampanya duraklatma) için L1 yapısal eşleşme (aynı kutu, kabul edilmiş kampanya iletisi, ≤ 30 gün), L2 alıcı bağı, L3 **iletinin dışından gelen** kanal tasdiki, L4 etki sınırları birlikte gerekir. Eksik kanıtlı ileti inceleme kuyruğuna düşer ve satıra kampanya bağlantısı yazılmaz. İletinin kendi `Authentication-Results` başlığı yok sayılır. Olumsuz/belirsiz yanıt hiçbir koşulda otomatik suppression üretmez.
- **Gmail başlık güveni (15.5):** Gmail'in eklediği başlıkları gönderenin eklediklerinden yalnızca sıra/biçimle ayırmak gerçek hesapta doğrulanmadan kanıt değildir. `GMAIL_HEADER_TRUST_VERIFIED = false` iken hiçbir Gmail başlığı tasdik üretmez; Gmail'den gelen her ileti yalnızca inceleme için kaydedilir. Ayrıntı ve kilit açma önkoşulları: docs/09 Bölüm 1.
- **İki ayrı otomatik durdurma:** kampanya düzeyi (≥ 20 alıcı, ≥ 2 doğrulanmış bounce'lu alıcı, ≥ %5) ve SRS 5.6.1 posta kutusu düzeyi (son 30 gün, alıcı bazlı, **%3'ü kesin aşarsa**, örneklem < 50 ise "yetersiz veri" ama ≥ 3 doğrulanmış bounce yine durdurur). İkisi de yalnızca sıkılaştırılabilir; posta kutusu durdurması açık onay + gerekçeyle kaldırılır.
- **Şikâyet (15.8):** ARF yalnızca geri bildirim döngüsü (FBL) sunan sağlayıcılardan gelir (Gmail dahil birçok sağlayıcı göndermez; hangilerinin sunduğu doğrulanmadı) ve çoğu şikâyet hiç bildirilmez; bu yüzden %0,1 kuralı **her zaman "ölçülemiyor"** gösterilir ve hiçbir otomatik durdurmaya girmez. Doğrulanmış şikâyetli alıcı sayısı yalnızca **kısmi kapsam alt sınırıdır**. Doğrulanmış şikâyet korumalı `complaint` engeli ve alıcının bütün bekleyen dizilerinin durması demektir; doğrulanması için güvenilir rapor sağlayıcısı listesi (varsayılan boş) da gerekir.
- **Çıkış bağlantısı ve RFC 8058 (15.6–15.7):** Ed25519 imzalı, süre (varsayılan 180 gün) ve kapsam sınırlı belirteç; `GET` işlem yapmaz, onay `POST` ile; olay yalnızca **dayanıklı kayıt makbuzundan sonra** 200 alır; teslimat en-az-bir-kez, tekilleştirme uygulamada (`jti`). `oneClickEndpointVerified` ve hazırlık maddesi yalnızca saklanan uçtan uca sınamadan türer (kullanıcı beyanı kanıt değildir). Bellek içi kuyruk test dışında kullanılamaz. Canlı iletiye doğrulanmamış uç nokta ile çıkış bağlantısı konmaz (`unsubscribe_unavailable`).
- **Silme talebi (Aşama 14):** Güvenle yapılanlar temizlenir; gerçek posta kutusundan iletilmiş kayıtlar ve engel özeti **hukuki değerlendirme bekler** ve dokunulmaz. Yer tutucu `sha256("um-erased-v1:"+rastgele 128 bit)`: başka bir adresle eşleşmez, kişi başına tektir. "Yükümlülüğüm yok" beyanı onay yerine geçmez.
- **Takip adımları:** roadmap Faz 4'te yazar; altyapı (3 adımlı dizi) Faz 3'te çalışır, ek iş yok.
- **Demo çıkış çekirdeği** (`/u/[token]`, HMAC `v1`) alıcılara ulaşamaz; gerçek RFC 8058 çıkış DEĞİLDİR ve değiştirilmedi.

## 6. Açık teknik borç

Bunlar bilinen, bilinçle ertelenmiş ve **belgelenmiş** eksiklerdir; hiçbiri bir kilidi açmaz. "Onay" sütunu, çözümün ayrıca kullanıcı onayı gerektirip gerektirmediğini gösterir.

| Kod | Borç | Etkisi / geçici önlem | Çözüm | Onay |
|---|---|---|---|---|
| **TB-1** | **ARF şikâyeti kodda hâlâ ayrı sınıf olarak yazılmıyor.** 15.10-1'den (migrasyon `0003`) bu yana `messages.classification` CHECK kısıtı `complaint` kabul ediyor ve eski işaretli satırlar `complaint`'e taşındı (`error_code` işareti korundu). Ancak kod 15.10-2'ye kadar yeni şikâyeti hâlâ `other` + `error_code = arf_complaint` (doğrulanmış) / `arf_complaint:<neden>` (doğrulanmamış) olarak yazar ve işarete göre okur | Sorgular ve sayaç bir **metin işaretine** dayanır; dışa aktarım/ham sorguda sınıf `other` görünür; arayüz işareti etiketler (Şikâyet raporu (ARF)). İşaret yalnızca şikâyet yolunda yazılır, kullanıcı girdisiyle oluşamaz (testli) | Migrasyon ve taşıma **15.10-1'de yapıldı**. Kalan, **Aşama 15.10-2:** yazımın, sorgunun ve arayüzün sütuna geçirilmesi (geri alma sözleşmesi gereği `error_code` işaretiyle çift yazım) | **Evet — ayrıca açık onay** |
| **TB-2** | **Şikâyet ve abonelikten çıkış sayaçları/durumları ayrılmadı.** Şikâyetle durdurulan diziler de `unsubscribed` durumunu kullanır. 15.10-1 ayrı durum yerine `campaign_leads.stop_reason` (`unsubscribe`/`complaint`) sütununu ekledi ve mevcut satırları geri doldurdu; kod henüz bu sütunu yazmadığından o tarihten sonraki yeni `unsubscribed` satırlarında `stop_reason` boş (`NULL`) kalır. Kampanya özet sayaçları (`counts`) ikisini aynı `unsubscribed` kovasında toplar | Ayrım yalnızca `exclusionReasons=["arf_complaint"]` işaretiyle ve arayüz etiketiyle ("Şikâyet nedeniyle durduruldu" / "Listeden çıkmak istedi") yapılır; **suppression nedeni (`complaint` / `unsubscribe`) ve denetim kayıtları (`inbound.complaint` / `inbound.unsubscribe`) zaten ayrıdır**. Özet sayaçlar, dışa aktarımlar ve ileride panolar şikâyeti çıkış olarak sayar | Sütun **15.10-1'de eklendi**. Kalan, **Aşama 15.10-2:** `stop_reason` yazımı + ayrı sayaçlar, özetler ve arayüz | **Evet — ayrıca açık onay** |
| TB-3 | Çıkış adresi, uç nokta doğrulaması, ARF rapor sağlayıcı listesi ve kanal/imza anahtarı yönetimi için **arayüz/API yok** (yalnızca servis işlevleri) | Canlıya geçişte bu işlemler elle kod çağrısı gerektirir; kullanıcı hatasına karşı onay/geri alma akışı yok | Kimlik doğrulama, onay ve denetim tasarımıyla ayrı bir arayüz aşaması | Hayır (tasarım onayı önerilir) |
| TB-4 | Çıkış olay kuyruğu için **uyarı kanalı yok** (derinlik/yaş yalnızca hazırlık ekranında) | Aktarıcı olayları geciktirir/atarsa fark edilmesi ekranı açmaya bağlı | E-posta/push uyarı eşiği | Hayır |
| TB-5 | Aktarıcı hız sınırı `clientKey` verilmezse tek genel kova | Saldırgan kovayı doldurup geçerli çıkış isteklerini 429'latabilir | Dağıtım ortamında güvenilir istemci adresi başlığı | Hayır (dağıtım gerekir) |
| TB-6 | Aktarıcı `ReplayStore` bellek içi | Yeniden başlatmada kopya olay üretir; uygulamada `jti` ile güvenle tekilleştirilir (yalnızca trafik artar) | Kalıcı tekrar oynatma kaydı | Hayır |
| TB-7 | Kampanya alıcısı kaydı silinirse çıkış isteği uygulanamaz (`lead_not_found`) | Gerçek kampanyalar silinmez (yalnızca demo temizliği siler); belirteçte adres olmadığından alternatif yok | Gerekirse silinen alıcı için özet tabanlı yedek akış | Hayır |
| TB-8 | Yerel Windows testlerinde ~150 ortam hatası (`EPERM`, POSIX izni, yol biçimi) | Linux CI belirleyici ve yeşil; yerelde gizlenmedi | Windows uyumlu geçici dizin/kapatma stratejisi | Hayır |
| TB-9 | 320 px üst çubuk taşması. (`README.md` durum paragrafı canlıya geçiş belgeleriyle birlikte güncellendi.) | Electron `minWidth: 760`; 760/800 px'te taşma yok | Küçük arayüz/belge düzeltmesi | Hayır |
| TB-10 | Dizi `completed` iken de çıkış/şikâyet `unsubscribed`'a çevirir | Mevcut davranış; sonuç aynı (gönderim zaten bitti) ama bitmiş diziler sayaçlarda kayar | TB-2 ile birlikte durum modeli gözden geçirmesi | Evet (TB-2 kapsamında) |

## 7. Kalan işler ve doğrulanmayanlar (sırayla)

1. **Şirket girdileri** (Bölüm 8) olmadan hiçbir gerçek entegrasyon doğrulanamaz.
2. **Gerçek hesapla doğrulama** — docs/09'daki kontrol listesi: Gmail OAuth/JWKS/kapsamlar, gönderim hata zarfları, `Message-ID` davranışı, gelen kutusu ve başlık güveni, ARF gerçek biçimi.
3. **HTTPS çıkış uç noktası** dağıtımı (barındırma kararı sonrası), uçtan uca doğrulamanın gerçek uç noktaya karşı çalıştırılması ve ancak ondan sonra `List-Unsubscribe-Post`.
4. **SPF/DKIM/DMARC** gerçek gönderim alan adında doğrulama.
5. **Hukuki onaylar** (Bölüm 8); canlı ülke kilidinin yeni sürümle açılması; `LEGAL_APPROVALS` maddelerinin onay kayıtlarıyla `true` yapılması.
6. **Aşama 15.10-2** — TB-1 ve TB-2'nin kod tarafı (migrasyon 15.10-1'de yapıldı; ayrı onay).
7. **Canlı kilitlerin sırayla açılması** (docs/09 Bölüm 9), **SRS 13/6, 7, 8 canlı doğrulaması**, ardından **pilot** (ilk hafta günde ≤ 20).
8. Faz 3'ü kapatmak (Bölüm 9 koşulları tamam olunca).

## 8. Şirketten beklenenler

Bu liste **ihtiyaçları ve nedenlerini** söyler; hangi hizmetin veya ücretli seçeneğin kullanılacağı **şirket kararıdır** ve burada **kesinleşmiş sayılmaz**. Ücretli hizmetler yalnızca "olabilir/koşullu" olarak işaretlenmiştir; fiyat veya zorunluluk Google/barındırma sağlayıcılarının güncel koşullarından doğrulanmadan varsayılmamıştır.

Her girdinin uygulamada **nereye ve ne zaman** girildiği, gizli olup olmadığı ve canlı testlerin sırası: [`10-CANLIYA-GECIS.md`](10-CANLIYA-GECIS.md).

### 8.1 Zorunlu (bunlar olmadan gerçek gönderim hiçbir koşulda açılamaz)

| Girdi | Sahibi | Neden gerekli |
|---|---|---|
| Gönderen firma profili: ticari unvan, adres, vergi/sicil numarası, telefon, iletişim kişisi | Şirket | Her iletinin zorunlu alt bilgisi ve gönderen kimliği; eksikse uygulama kampanya başlatmayı kilitler |
| Hedef ülke listesi ve pilot bölge | Şirket | Canlı ülke politikası ülke bazında kilitlidir; hangi ülkeler için hukuki onay gerektiğini belirler |
| Gönderim için bir **gerçek gönderici posta kutusu** (planlanan yol: Google Workspace/Gmail; SMTP kararı kesinleşmedi) | Şirket | Gerçek gönderimin kendisi; ana markadan ayrı bir gönderim alan adı itibar riskini ayırır |
| Gönderim alan adında **SPF, DKIM, DMARC** DNS kayıtları ve DKIM seçici adı | Şirket (DNS yönetimi) | Teslim edilebilirlik ve gönderen kimlik doğrulaması; hazırlık ekranında `dns_auth` bunu ister |
| **Genel erişilebilir HTTPS çıkış uç noktası** için barındırma kararı ve alan adı | Şirket | Canlı iletide çalışan, tek tıklamalı çıkış bağlantısı olmadan gönderim yapılmaz (`unsubscribe_unavailable`); RFC 8058 gereği alıcıların ulaşabilmesi gerekir |
| **Hukuki onaylar** (aşağıda 8.4): LIA, UYUM, canlı ülke politikası kilidi, silme kayıtları, engel özeti saklama dayanağı | Hukuk / şirket | `LEGAL_APPROVALS` içindeki maddeler yazılı onayla yeni sürümde `true` olmadan gönderim yolu açılmaz |
| Pilot için yetkilendirilmiş test alıcıları | Şirket | Faz 3 kabulü: ilk hafta günde ≤ 20 e-posta; gerçek alıcı verisiyle test yapılmaz |

### 8.2 Koşullu (belirli bir tercih veya hedef yapılırsa zorunlu olur)

| Girdi | Ne zaman gerekir | Neden gerekli |
|---|---|---|
| Google Cloud projesi ve Gmail API için OAuth istemcisi ("Desktop app"); gerekirse OAuth onay ekranı | Gönderim/okuma **Gmail üzerinden** yapılacaksa | Uygulama Gmail'e bu istemciyle bağlanır; yoksa bağlantı kurulamaz. Dış (Harici) kullanıcı için ek doğrulama gerekip gerekmediği ve **olası ücretli değerlendirme süreçleri doğrulanmadı** (Workspace Dahili/Harici yapılandırmasına bağlı) |
| `gmail.readonly` (gelen kutusu okuma) izni ve kısıtlı kapsam gerekliliklerinin netleşmesi | Bounce/yanıt/çıkış iletilerinin **otomatik** işlenmesi istenirse | Okuma izni olmadan bounce ve yanıtlar otomatik işlenemez; elle işleme gerekir. Kısıtlı kapsam doğrulaması gerekebilir (belirsiz) |
| Gmail başlık güveninin gerçek hesapla doğrulanması için **şirket dışı, tek kullanımlık bir test Gmail hesabı** | Gelen kutusundan otomatik etki (suppression, dizi durdurma) açılacaksa | Başlık güven kilidi (`GMAIL_HEADER_TRUST_VERIFIED`) doğrulama olmadan açılmaz; açılmazsa tüm gelen iletiler yalnızca incelemeye düşer (güvenli ama elle iş) |
| Çıkış aktarıcısı için **sunucu/barındırma** (kalıcı disk, TLS sertifikası, ters vekil) | HTTPS çıkış uç noktası kurulacaksa (yukarıdaki zorunlu girdinin gerçekleşmesi) | Aktarıcı ve dayanıklı kuyruk bir sunucuda çalışmalıdır; güç kesintisi dayanıklılığı gerçek POSIX diskinde sınanmalıdır. **Ücretli olabilir; sağlayıcı seçilmedi** |
| MERSİS / ticaret sicil numaraları ve hukuki kural | Türkiye'ye gönderim yapılacaksa | Alanlar isteğe bağlı eklendi; TR için zorunlu olup olmadığı **hukuken belirlenmedi**, belirlenene kadar engel olmaz, canlı gönderim zaten kapalı |
| Geri bildirim döngüsü (FBL/ARF) kayıtları ve rapor sağlayıcı alan adları | Şikâyet raporlarının otomatik işlenmesi istenirse | Yalnızca ilan edilmiş güvenilir rapor sağlayıcılarından gelen raporlar doğrulanabilir; liste boşken tüm raporlar incelemeye düşer. Hangi sağlayıcıların FBL sunduğu şirketin posta düzenine bağlıdır (bilinmiyor) |
| Hukuki değerlendirme: yedeklerde kalan eski verinin durumu | Silme talepleri gerçek veriyle çalışmaya başladığında | Şema güncellemesi öncesi yedekler eski veriyi taşıyabilir |

### 8.3 İsteğe bağlı

| Girdi | Neden faydalı |
|---|---|
| SMTP sağlayıcı bilgileri | Gmail dışı alternatif gönderim; **kesinleşmedi**, eklenirse yeni paket için önce onay gerekir |
| Kuyruk/sağlık uyarı kanalı (e-posta veya push) | Çıkış olaylarının gecikmesinin ekrana bakmadan fark edilmesi (TB-4) |
| İkinci (yedek) aktarıcı veya izleme hizmeti | Erişilebilirlik; yazılım için şart değil |
| Google Cloud bütçe uyarısı / kota sınırları | Beklenmedik maliyet ve kota aşımı koruması (Places/Maps için zaten önerilir) |
| Kalıcı tekrar oynatma kaydı için ek depolama (TB-6) | Aktarıcı yeniden başlatmalarında kopya trafiğini azaltır |

### 8.4 Hukuki kararlar (hukuk/şirket; yazılım bunları varsaymaz)

- [ ] LIA içeriği (`docs/LIA.md`) ve onayı (`lia`)
- [ ] `docs/UYUM.md` hukuk onayı (`uyum`)
- [ ] Canlı ülke politikası kilidinin ülke bazında yazılı onayı (`liveCountryPolicies`)
- [ ] Gerçek gönderim kayıtlarının silme talebinde işlenmesi (`erasureOfTransmissionRecords`)
- [ ] Engel listesinde e-posta özetinin saklanma dayanağı (`suppressionHashRetention`)
- [ ] Türkiye'ye gönderimlerde MERSİS/sicil zorunluluk kuralı (`trSenderIdentifierRules`)
- [ ] Genel HTTPS çıkış uç noktasının kurulduğunun ve doğrulandığının sürüm kaydı (`httpsUnsubscribeEndpoint`; teknik doğrulama kanıtı ayrıca gerekir)
- [ ] Çıkış belirtecinin 180 günlük geçerliliği ve süresi dolan bağlantı davranışı
- [ ] `docs/03-ANLASMA-NOTU.md` onayı (Faz 0)

## 9. Faz 3 kapanış koşulları

Faz 3 yalnızca şunların **hepsi** kayda geçtikten sonra "tamamlandı" olarak işaretlenir:

1. docs/09 kontrol listesinin ilgili bölümleri gerçek ortamda tamamlandı ve kanıtı kaydedildi.
2. Hazırlık ekranında (`live-readiness`) tüm maddeler gerçek kanıtla "tamam".
3. Hukuki onaylar (Bölüm 8.4) alındı ve `LEGAL_APPROVALS` bu onay kayıtlarıyla bilinçli bir sürümde güncellendi.
4. Canlı ülke politikası kilidi onaylı ülkeler için açıldı.
5. Aşama 15.10 (TB-1, TB-2) ya tamamlandı ya da pilot için kabul edilebilir risk olarak yazılı kabul edildi.
6. Pilot (ilk hafta günde ≤ 20) SRS Bölüm 13/6–8 kabul ölçütlerini geçti.

## 10. Sonraki fazlara ekleme noktaları

- `src/lib/mail/provider/provider.ts` (`getProvider`) ve `src/lib/mail/gmail/provider.ts` (`getLiveProvider`) gerçek sağlayıcı için; `src/lib/mail/inbound/sync.ts` (`InboxReader`), `evidence.ts` (`Attestation`) ve `gmail/attestation.ts` gerçek tasdik sözleşmesi için.
- `src/lib/compliance/legal-status.ts` hukuki onay sabitleri ve `live-gate.ts` birleşik kapı (yalnızca onaylı sürümle değişir).
- `src/lib/unsubscribe/` çıkış altyapısı (aktarıcı modülü başka bir sunucuya taşınabilir).
- Faz 4: zamanlanmış tarama, dashboard, TR/EN arayüz, koyu tema, bildirimler (bu belgenin kapsamı dışında).

## 11. Çalıştırma

- Varsayılan: gerçek gönderim ve gerçek gelen kutusu kapalı; `FAZ3_DEMO_SCHEDULER_ENABLED`, `FAZ3_DEMO_INBOX_ENABLED` ve `UM_UNSUBSCRIBE_DRAIN_ENABLED` tanımsız (kapalı). Demo kampanya gönderimi için yalnızca geçici/test veri klasöründe `FAZ3_DEMO_SCHEDULER_ENABLED=1` verilir.
- Testler: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npx playwright test`. Windows'ta Vitest için ASCII bir geçici klasör (`TMPDIR`/`TMP`/`TEMP`) kullanın.
- İlgili belgeler: [Canlı doğrulama listesi](09-FAZ3-CANLI-DOGRULAMA.md), [Canlıya geçiş](10-CANLIYA-GECIS.md) (şirket girdileri, paylaşım kuralları, canlı test sırası), [UYUM](UYUM.md) (taslak), [LIA](LIA.md) (iskelet), [UI Rehberi](07-UI-REHBERI.md).
