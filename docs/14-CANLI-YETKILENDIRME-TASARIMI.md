# Canlı Kullanım Yetkilendirmesi — Tasarım Taslağı (B2)

**Durum: TASARIM. Bu belgedeki hiçbir şey henüz uygulanmadı.** Amaç, gerçek e-posta gönderimini ve gerçek gelen kutusu
okumayı müşterinin bilgisayarında, geliştirici terminali olmadan ve güvenli varsayılanlarla (kapalı) yönetmenin yolunu
Efe ile birlikte karara bağlamaktır. Hiçbir mevcut koruma (ülke kilidi, DNS, çıkış bağlantısı, suppression, uygunluk)
gevşetilmez; bu tasarım yalnızca **ek bir kapı** ekler.

> **Önemli:** Uygulama içi yetkilendirme kaydı **hukuki onayın yerine geçmez.** Kaydın tutulması gerekli hukuki
> incelemenin ve şirketin yetkilendirmesinin yapıldığı anlamına gelmez; yalnızca kimin, ne zaman, hangi kapsamda
> "açılsın" dediğini kayda geçirir. Hukuki doğrulamalar uygulama dışında yapılır ve burada yalnızca belge referansı
> olarak anılır.

## 1. İlkeler

1. **Varsayılan kapalı.** Yetki kaydı yoksa hiçbir canlı gönderim, gerçek gelen kutusu okuma veya otomatik suppression
   olmaz. İlk kurulumda da.
2. **Yalnızca VE koşulu.** Yetki tek başına hiçbir şeyi açmaz. Bir işlem ancak mevcut tüm koşullar **ve** geçerli yetki
   varsa gerçekleşir. Mevcut kod kapıları, ülke kilidi (veritabanı kısıtları dahil), DNS denetimi, doğrulanmış HTTPS
   çıkış ucu, çekme sağlığı, suppression ve uygunluk kuralları aynı yerlerde aynen çalışır.
3. **Üç bağımsız yetki.** Gönderim, gerçek gelen kutusu okuma ve gelen kutusundan otomatik suppression ayrı kayıtlardır;
   biri diğerini açmaz. Gmail bağlamak hiçbirini açmaz.
4. **Kapatmak kolay, açmak zor.** Geri alma tek tıkla ve ek onaysızdır; verme çok adımlı, kapsamı dar ve süreli olur.
5. **Terminal yok.** Paketli uygulamada hiçbir adım `npx`, `tsx` veya depo kökü gerektirmez.
6. **Hata durumunda kapalı.** Doğrulanamayan, bozuk, eski dönemli veya süresi dolmuş her kayıt "yetki yok" sayılır.

## 2. Üç yetki

| Yetki | Neyi açar | Ek ön koşul |
| --- | --- | --- |
| `sending` | Gerçek kampanya iletisi gönderimi | Hazırlık kartındaki yazılım koşulları tamam; son N günde başarılı "kendime test gönder" |
| `inbox_read` | Gerçek Gmail gelen kutusu okuma | Ayrıca `gmail.readonly` izni (yeniden OAuth onayı) |
| `auto_suppression` | Gelen kutusu başlıklarına dayalı otomatik suppression/durdurma | `GMAIL_HEADER_TRUST_VERIFIED` kod sabiti ve gerçek hesapla doğrulama kanıtı (`docs/09` Bölüm 1.3); bu sabit kapalıyken yetki bunu **açamaz** |

Koruyucu otomasyon (çıkış bağlantısı ve şikâyet işleme) hiçbir yetkiye bağlanmaz ve kapatılmaz; yetkiye bağlı olan,
sahteciliğe açık olan başlık güvenidir.

## 3. Veri modeli (taslak)

**Eklemeli olay günlüğü** (`live_authorization_events`, yeni migrasyon): her verme veya geri alma bir olaydır, hiçbir satır
güncellenmez veya silinmez. Alanlar: tür (`grant`/`revoke`), yetki, kapsam (kutu, ülke), süre sonu, pilot sınırı ve alıcı
listesi, yetki sahibinin adı ve unvanı, yetki belgesi referansı ve SHA-256 değeri (belgenin kendisi saklanmaz), hukuki
inceleme referansı (serbest metin, uygulama doğrulamaz), önceki satırın özeti ve satırın HMAC imzası.

- **Zincir:** her satır, önceki satırın özetini ve kendi içeriğini kapsayan HMAC taşır. Silme, düzenleme veya araya satır
  sokma imzayı bozar; bozuk zincir **bütün yetkileri geçersiz** kılar.
- **İmza anahtarı:** gizli depodaki ana anahtardan HKDF ile türetilir (`test-send-confirm.ts` ve `open-tracking.ts` ile
  aynı yöntem, ayrı bağlam dizgisiyle).
- **Dönem sayacı (epoch):** veri klasörünün **dışında** (kullanıcı veri klasörünün üst düzeyinde) tutulan sayaç, geri
  yükleme ve "tüm verilerimi sil" tarafından artırılır (`pre-init.ts` kancası). Her olay yazıldığı dönemi taşır; eski
  dönemin kayıtları geçersizdir. Böylece yedekten dönüş eski yetkileri geri getirmez (zaten kampanyalar duraklatılır).
- **Saat güvenliği:** son görülen zaman damgası imzalı durumda tutulur; süre karşılaştırması `max(şimdi, son görülen)` ile
  yapılır (saati geri alarak süre uzatılamaz).

## 4. İnsan onayı: Electron yerel pencere yaklaşımı

**Sorun.** Web arayüzünden gelen bir onay, aynı makinede çalışan bir betikten ayırt edilemez (aynı HTTP uçları, aynı
başlıklar). `test-send-confirm.ts` bu yüzden açıkça "insan varlığının kesin kanıtı değildir" der. Yüksek etkili adımlar
(yetki verme, ülke kilidi açma, pilot çıkışı) için bir insanın görmesi gereken, **web sürecinin taklit edemeyeceği** bir
kanal gerekir.

**Çözüm.** Onay, Electron **ana sürecinin** yerel (native) iletişim penceresinde alınır. Sunucu süreci ile ana süreç
arasında IPC kanalı zaten vardır (`electron/main.ts` sunucuyu `fork` ile `ipc` kanalıyla başlatır; sunucu bugün
`process.send({ type: "notify" })` gönderir ve ana süreç `child.on("message")` ile dinler). Bu kanal istek-cevap biçimine
genişletilir.

**Akış:**

1. Kullanıcı arayüzde yetki talebini doldurur (kimlik, belge referansı, kapsam, sınırlar) ve gönderir.
2. Sunucu talebi doğrular (tüm ön koşullar, kapsam, sınır üst sınırları) ve ana sürece
   `{ type: "confirm-request", id, summary, kind }` gönderir. `summary` sunucu tarafından, **doğrulanmış kayıt alanlarından**
   üretilir (kullanıcı metni değil); örn. "Gönderim yetkisi: kutu X, ülkeler GB, FR, pilot günde Y, 14 gün, yetkili: Ad
   Soyad (Unvan)".
3. Ana süreç `dialog.showMessageBox` ile modal yerel pencere gösterir. Varsayılan ve Esc düğmesi **İptal**'dir; özet
   metni değiştirilemez. macOS'ta Touch ID varsa (`systemPreferences.canPromptTouchID`) ek doğrulama istenebilir.
4. Onaylanırsa ana süreç, `id`'ye ve özetin özetine bağlı, kısa ömürlü, tek kullanımlık bir **imzalı kanıt** döndürür
   (HMAC; anahtar ana anahtardan türetilir).
5. Sunucu kanıtı doğrular, ancak o zaman olayı günlüğe ekler. Zaman aşımı (örn. 2 dakika) veya iptal: hiçbir şey yazılmaz.

**Güvenlik özellikleri.** Web arayüzü ve yerel betikler pencereyi **açabilir** (talep gönderebilir) ama **onaylayamaz**;
beklenmedik bir pencere kullanıcıya şüphe verir ve iptal edilir. Pencere metni sunucu doğrulamasından geçmiş alanlardan
gelir. Kanıt özet ve kimliğe bağlıdır (başka bir talep için kullanılamaz).

**Sınırlar (açıkça).**

- Kullanıcı hesabı altında çalışan kötü amaçlı yazılım Keychain'e erişebilir ve zaten Gmail belirteçlerine de erişebilir;
  bu tehdit modelinin dışındadır.
- Sunucu sürecinin kendisi ele geçirilirse kanıt isteğini taklit edemez ama ana sürece sahte özet gösterterek kullanıcıyı
  yanıltmayı deneyebilir; bu yüzden özet yalnızca imzalı ve doğrulanmış alanlardan, ana süreçte yeniden biçimlendirilerek
  gösterilir.
- Tarayıcıda geliştirme kipi (Electron yok): yedek olarak yazılı ifade onayı; paketli uygulamada bu yedek kapalıdır.
- Kimlik: uygulama yetki sahibinin hukuki kimliğini kanıtlayamaz. Güçlendirmek için isteğe bağlı olarak, gönderen Gmail
  hesabıyla yeniden Google oturumu (hesabın sahibi mi) istenebilir; hukuki doğrulama uygulama dışındadır.

## 5. Denetim noktaları (VE koşulunun eklendiği yerler)

Mevcut senkron `isLiveSendingPermitted()` korunur. Asenkron, kapsamlı bir `yetkiDogrula(db, yetki, kapsam)` yanına
eklenir. Eklenecek yerler: uygunluk (`evaluateSend`), `GmailProvider.send` (G/Ç'den önce), kampanya başlatma önkontrolü,
dağıtıcı aday seçimi, ileti oluşturma, gelen kutusu okuyucusu ve işi, ülke politikası çözümleyicisi, hazırlık kartı.
Her biri "yetki yok / geçersiz imza / eski dönem / süresi dolmuş / başka kapsam" için ayrı reddedilir.

## 6. Ülke kilidi

Veritabanı kısıtları (kilitliyken gevşetme reddi, açarken `approval_ref`, `approved_by`, `approved_at` zorunluluğu)
**aynen kalır**. Bugün ülke kilidini yalnızca `scripts/approve-live-country.ts` açar ve uygulamanın normal yolu o
modülü içe aktarmaz (testle doğrulanır). Terminalsiz çözüm için aynı yazma mantığını, **yalnızca** yukarıdaki yerel onay
akışından geçmiş bir yetki olayı üzerine çalıştıran tek bir hizmet eklenir; betik yedek yol olarak kalır. "Normal yol bu
modülü içe aktarmaz" testi bu tek hizmeti istisna edecek biçimde bilinçli olarak güncellenir (**Efe onayı gerekir**,
çünkü onun tasarım kuralını değiştirir).

## 7. Pilot sınırları

Etkin günlük sınır, aşağıdakilerin **en küçüğüdür**:

1. kodda yazılı mutlak üst sınır (yalnızca yeni sürümle değişir),
2. yetki kaydında yazılı pilot sınırı (şirket kararı, varsayılan 0),
3. posta kutusu ısınma eğrisi,
4. hesap türü tavanı (kişisel Gmail daha düşük, Workspace daha yüksek),
5. ülke başına sınır.

Pilot süresi kendiliğinden biter; yenileme ayrı bir olaydır. Pilot boyunca yalnızca kayıtlı test alıcılarına gönderilir.
Sınırın artırılması yeni bir yetki olayı gerektirir ve ancak sağlık ölçütleri (bounce, şikâyet, çözülmemiş "belirsiz"
gönderim yok) uygunsa kabul edilir. **Sayısal değerleri şirket ve hukuk belirler; bu belge değer önermez.**

## 8. Tehdit analizi

| Tehdit | Önlem |
| --- | --- |
| Yanlışlıkla tıklama | Çok adımlı talep, kapsam özeti, ülke başına ayrı onay, yerel pencerede varsayılan "İptal" |
| Aynı makinede başka süreç yerel API'yi çağırır | Host/Origin/Sec-Fetch korumasına ek: onay yalnızca ana sürecin yerel penceresinden; sunucu kanıtı doğrular |
| Veritabanı elle düzenlenir | Satır HMAC'i ve zincir; bozulursa tüm yetkiler geçersiz |
| Yedekten eski geçerli kayıt geri getirilir | Veri klasörü dışındaki dönem sayacı; geri yükleme ve silmede artar |
| Denetim kaydı değiştirilir | Eklemeli günlük + zincir: kurcalama kanıtlanabilir (engellenemez, ama fark edilir) |
| Yetki sahibinin kimliği sahte | Belge referansı ve SHA-256, isteğe bağlı hesap sahipliği doğrulaması; hukuki doğrulama uygulama dışında |
| Saat geri alınarak süre uzatılır | Son görülen zaman damgası imzalı durumda |
| Kapsam şişmesi | Süreli (örn. 90 gün), ülke ve kutu bazlı, tek tıkla geri alınır |
| Sunucu süreci ele geçirilir | Kanıt ana süreçte üretilir; özet ana süreçte yeniden biçimlenir (kalan risk açıkça belgelenir) |

## 9. Açık kararlar (Efe ile)

1. **Sabitlerin nihai anlamı.** (a) `LIVE_*_ENABLED` kapalı kalır ve yetki tek açıcıdır; (b) sabitler "derleme yeteneği"
   olarak `true` olur ve yetki varsayılan kapalıdır. İkisi eşdeğer güvenlik sağlar; seçim Efe'nin sabitler hakkındaki
   görüşüne bağlıdır. Bu belge her ikisiyle de uyumludur.
2. Yedi `LEGAL_APPROVALS` sabitinin anlamlarının ayrılması (gönderim kapısı, silme talebi davranışı, çıkış hazırlığı).
3. Ülke kilidini uygulama içinden açan tek hizmetin kabulü (Bölüm 6).
4. Yerel onay penceresi için macOS'ta Touch ID zorunlu mu, isteğe bağlı mı.

## 10. Uygulama aşamaları ve testler (öneri)

1. Saf çekirdek kütüphane (zincir, HMAC, dönem, süre; hiçbir yere bağlı değil) + tam birim testleri.
2. Migrasyon (eklemeli) ve geri alma aracı (0003–0006 emsali, iki aşamalı güvenlik).
3. Ana süreç IPC ve yerel pencere (`electron/main.ts`).
4. Arayüz kartı ve yeni i18n parçası (dondurulmuş `base.ts`'e dokunulmaz).
5. **Davranışı değiştiren son adım:** denetim noktalarına bağlama. Ayrı commit, Efe onayı ile.

Testler: her denetim noktası için reddetme tablosu; yetkilerin birbirini açmaması; yedekten dönüşte kapanma; veritabanı
kurcalama; zincir bozulması; mevcut ülke kilidi, DNS, çıkış ve suppression testlerinin **değişmeden** geçmesi;
mutasyon denemesi (denetim noktası çıkarılınca testlerin kırılması).

## 11. Test gönderimi onay belirteci ile ilişki (B1b)

"Kendime test gönder" için `test-send-confirm.ts` sunucu doğrulamalı, tek kullanımlık, kısa ömürlü ve bağlı bir belirteç
kullanır; sahte, tekrarlanan ve parametresi değiştirilmiş istekleri ve çift gönderimi engeller, ancak insan varlığını
kanıtlamaz. Bu yetkilendirme sistemi geldiğinde test gönderimi aynı yerel onay penceresini isteğe bağlı olarak
kullanabilir; etkisi sınırlı olduğu (yalnızca kutunun kendi adresi, saatte ve günde 10) için zorunlu değildir.
