# Faz 3 — Canlı Doğrulama Kontrol Listesi

**Durum: TASLAK (Aşama 15.5 ile başlatıldı; Aşama 15.9'da tamamlanacak).** Bu belge, yalnızca **gerçek bir hesapla** (Gmail, DNS, Google Cloud OAuth istemcisi) kanıtlanabilecek varsayımları ve bu varsayımlar doğrulanana kadar kodun nasıl güvenli tarafta kaldığını listeler. Burada işaretlenmeyen hiçbir madde "doğrulandı" sayılmaz. Gerçek gönderim ve gerçek gelen kutusu okuma kodda **kapalıdır** (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`) ve bu belge o kapıları açmaz.

## 1. Gmail gelen ileti başlıklarına güven (Aşama 15.5)

### 1.1 Sorun

Otomatik etki (doğrulanmış bounce → suppression, doğrulanmış yanıt/ayrılma → dizi durdurma) için iletinin **gerçekten alıcıdan/ posta sisteminden geldiğine** dair, iletinin **dışından** gelen bir tasdik gerekir (kanıt katmanı L3, `src/lib/mail/inbound/evidence.ts`). İletinin kendi başlıkları (`Authentication-Results`, `Return-Path`, `Delivered-To`, `Received`) **gönderenin kontrolündedir**: gönderen bu başlıkların herhangi birini, istediği değerle, iletiye ekleyebilir.

Gmail alıcı olarak kendi başlıklarını iletinin **en üstüne** ekler, ancak:

- Gmail'in eklediği başlıkları gönderenin eklediklerinden **yalnızca sırayla veya biçimle** ayırt etmek, gerçek bir Gmail hesabında gözlenip doğrulanmadığı sürece **kanıt değildir**.
- "Gmail, aldığı her SMTP iletisine kendi `Authentication-Results` başlığını ekler" varsayımı **kanıtlanamamıştır**. Eklemediği bir durumda, gönderenin Gmail başlıklarının hemen altına koyduğu sahte bir başlık yapısal kurallarla ayırt edilemez.
- `Return-Path: <>` (boş zarf gönderen, DSN göstergesi) Gmail'in eklediği bir başlıktır; fakat gönderen de ekleyebilir.

### 1.2 Kodun güvenli tarafta kalma biçimi

1. **Güven kilidi:** `GMAIL_HEADER_TRUST_VERIFIED` (`src/lib/compliance/policies.ts`) **varsayılan `false`**. Kapalıyken `extractGmailAttestation` her zaman `null` döner: **hiçbir Gmail başlığı tasdik üretmez.** Sonuç: iletiler `received` (inceleme gerekli, neden `no_attestation`) olarak kaydedilir; **doğrulanmış bounce, suppression, dizi durdurma veya kampanya duraklatma doğmaz**; doğrulanmamış satıra kampanya/dizi bağlantısı da yazılmaz.
2. **Yapısal kurallar (kilit açıldığında da geçerli):** herhangi biri şüpheliyse tasdik `null` olur:
   - `mx.google.com` yetkili kimliğini taşıyan tam **bir** `Authentication-Results` başlığı; ikincisi (nerede olursa olsun, büyük/küçük harf farkı dahil) belirsizliktir;
   - hemen öncesinde, `by mx.google.com` içeren **tek** `Received` başlığı;
   - en üstteki `Delivered-To` bu kutunun adresi;
   - tam **bir** `Return-Path` (birden çoksa boş zarf sayılmaz);
   - hepsi gönderenin kontrolündeki özgün başlıklardan (`From`, `To`, `Subject`...) önce;
   - `Authentication-Results` ayrıştırması: parantez içi yorumlar atılır, her yöntem kendi `;`-segmentinde okunur, tam bir `dmarc` segmenti olmalı, `pass` için `header.from` o segmentte ve `From` alan adıyla aynı olmalı.
3. **Kanıt katmanları L1–L4 aynen geçerlidir:** tasdik yetmez; ileti, aynı kutudan gönderilmiş kabul edilmiş kampanya iletisine eşleşmeli (L1), alıcı bağı tutmalı (L2), etki sınırları geçmeli (L4).
4. **Geçersiz kılma yalnızca testte** kabul edilir (`NODE_ENV==="test"`); üretimde kurucu hata verir.

### 1.3 Kilidi açmadan ÖNCE gerçek hesapla doğrulanacaklar

Kilit (`GMAIL_HEADER_TRUST_VERIFIED = true`) yalnızca bilinçli bir sürüm değişikliğiyle ve aşağıdakilerin **tamamı** kayda geçtikten sonra açılabilir. Test hesabı: şirket dışı, tek kullanımlık bir Gmail hesabı; gerçek müşteri verisi kullanılmaz.

- [ ] **Başlık düzeni:** Gmail'in gerçek bir iletiye eklediği başlıkların sırası (`Delivered-To`, `Received`, `Return-Path`, `Authentication-Results`, `ARC-*`) ve biçimi, 1.2'deki kurallarla birebir tutuyor (en az: dış alan adından düz ileti, SPF/DKIM/DMARC `pass`, `fail` ve `none` örnekleri, bir DSN).
- [ ] **Gmail her zaman ekliyor mu:** SMTP ile alınan her ileti için Gmail'in `Authentication-Results` başlığı ekleniyor; eklenmediği hiçbir durum gözlenmedi (ör. yönlendirilmiş, takma adlı, grup üzerinden gelen iletiler).
- [ ] **Sahte başlık eklenmesi:** Gönderen tarafından özgün iletiye eklenmiş `Authentication-Results: mx.google.com; dmarc=pass ...`, `Return-Path: <>`, `Delivered-To` ve `Received ... by mx.google.com` başlıkları içeren bir deneme iletisi gönderilir; Gmail bunları **silmiyor/değiştirmiyorsa** hangi biçimde kaldıklarına bakılır ve 1.2'deki kuralların bunları ayırt ettiği (ya da `null` döndürdüğü) doğrulanır.
- [ ] **`format=raw` çıktısı:** API'nin döndürdüğü ham ileti, web arayüzündeki "orijinali göster" ile aynı başlıkları içeriyor (Gmail API'nin başlık eklemesi/çıkarması yok).
- [ ] **Return-Path:** DSN'lerde Gmail'in `Return-Path: <>` ekleyip eklemediği.
- [ ] **ARC:** `ARC-Authentication-Results` başlığının güvenilir ek kanıt olarak kullanılıp kullanılmayacağı (kullanılacaksa imza doğrulaması gerekir; şu anda **kullanılmıyor**).

Bir madde doğrulanamazsa kilit **kapalı kalır**; otomatik bounce/yanıt işleme yerine inceleme akışı kullanılır.

## 2. Diğer canlı doğrulama maddeleri (Aşama 15.9'da genişletilecek)

- [ ] **Message-ID yeniden yazımı:** Gmail API ile gönderilen iletinin `Message-ID` başlığı korunuyor mu? Korunmuyorsa yanıt eşleştirmesi `threadId` yedeğiyle (aynı kutuda, aynı konuşmada **tek** kabul edilmiş kampanya iletisi) çalışır; bu yedeğin gerçek konuşma davranışıyla örtüştüğü doğrulanmalı.
- [ ] **JWKS biçimi ve kimlik belirteci:** Google'ın gerçek `jwks_uri` yanıtı ve gerçek ID token'ın `iss`/`aud`/`nonce`/`azp` biçimi 15.3'te sınanan kurallarla uyumlu.
- [ ] **Kapsam dizgileri:** Gerçek yetkilendirme yanıtındaki `scope` değerleri (`gmail.send`, `gmail.readonly`, `openid`, `email`) beklenen biçimde.
- [ ] **İptal (revoke) ucu davranışı:** Yetki iptalinden sonra yenileme `invalid_grant` veriyor ve kutu `reauthorization_required` durumuna geçiyor.
- [ ] **Kısıtlı kapsam doğrulaması:** Dış kullanıcılar için `gmail.readonly` (kısıtlı kapsam) uygulama doğrulaması/güvenlik değerlendirmesi gerekliliği ve Workspace yapılandırması (Dahili/Harici) **varsayılmamıştır**; şirket bilgileri geldikten sonra netleşecek.
- [ ] **Gmail API hata zarfları:** `messages.send` 400/403/404/413 ve 401 yanıtlarının gerçek biçimi, `googleError` doğrulamasındaki beklenen `error.code` / `error.status` kümeleriyle uyumlu (uyumsuzluk güvenli tarafta "belirsiz" sayılır, ancak sürekli belirsiz sonuç üretirse kümeler gözden geçirilmeli).
- [ ] **`historyId` ömrü:** `history.list` için gerçek geçerlilik süresi ve 404 davranışı.

## 3. HTTPS tek tıklamalı çıkış (Aşama 15.6)

Kod tarafı hazırdır (imzalı belirteç, taşınabilir aktarıcı işleyicisi, olay işleme); **gerçek HTTPS sunucusu, alan adı ve dağıtım YOKTUR**. Aşağıdakiler gerçek ortam olmadan kanıtlanamaz ve doğrulanana kadar `oneClickEndpointVerified` ASLA true yapılmaz (Aşama 15.7):

- [ ] **Gerçek HTTPS uç noktası:** Aktarıcı işleyicisi (`src/lib/unsubscribe/relay.ts`) genel bir HTTPS alan adında, geçerli TLS sertifikasıyla çalışır; `https://<alan>/u/<belirteç>` adresine dışarıdan ulaşılır.
- [ ] **RFC 8058 uyumu gerçek istemcilerle:** Gmail ve Yahoo gibi istemcilerin gönderdiği gerçek `POST` isteği (başlıklar, gövde, yönlendirme izlememe, zaman aşımı) işleyici tarafından 2xx ile karşılanır; `List-Unsubscribe` ve `List-Unsubscribe-Post` başlıkları gerçek bir iletide doğru görünür.
- [ ] **Olay iletim kanalı:** Aktarıcıdan yerel uygulamaya olayların dayanıklı iletimi (kuyruk, kimlik doğrulama, ağ erişimi) henüz YOK; yalnızca arayüzleri (`EventSink`, `UnsubscribeEventSource`) ve bellek içi gerçeklemeleri vardır. Ele geçirilmiş/çalışmayan aktarıcı olayları geciktirebilir veya atabilir (erişilebilirlik); bu katman bunu çözmez, izleme ve uyarı gerekir.
- [ ] **Anahtar dağıtımı:** Aktarıcıya yalnızca GENEL anahtar kümesi (`exportRelayKeySet`) verilir; döndürme ve iptal sonrası aktarıcının kümeyi güncellediği doğrulanmalıdır.
- [ ] **Saat ve süre:** Aktarıcı sunucu saatinin doğruluğu (belirteç süresi tıklama anına göre işlenir); 180 günlük varsayılan geçerlilik hukuki danışmanlıkla gözden geçirilmelidir.
- [ ] **Hız sınırı ve istemci adresi:** Aktarıcı önündeki ters vekilin güvenilir istemci adresi başlığı (`clientKey`) belirlenmeli; sınırlar gerçek trafikle ayarlanmalı.

### 3.1 Olay teslimat sözleşmesi ve Aşama 15.7 kabul ölçütleri

**200 yanıtı ne demek:** RFC 8058 isteğine verilen 2xx, "çıkış talebi alındı ve KAYBOLMAYACAK" anlamına gelir. Bu yüzden aktarıcı 200'ü yalnızca olay **dayanıklı** kaydedilip makbuz alındıktan sonra verir (`src/lib/unsubscribe/relay.ts`). Kaydedilemezse 503 + `Retry-After` (istemci yeniden dener); olay asla sessizce atılmaz.

**Bellek içi kuyruk:** `MemoryEventQueue` yalnızca test/demo içindir ve dayanıklı DEĞİLDİR. `NODE_ENV !== "test"` iken oluşturulamaz ve `createRelayHandler`, `durable !== true` olan hiçbir sink'i test dışında kabul etmez (kodla zorlanır; testle kanıtlı).

**Teslimat modeli:** en-az-bir-kez. Aynı olay birden çok kez kuyruğa girebilir (istemci yeniden denemesi, aktarıcı yeniden başlaması sonrası kaybolan tekrar oynatma kaydı, zaman aşımından sonra geç başarı). **Tekilleştirme uygulama tarafındadır** (`jti`, `ingest.ts`); çift suppression/denetim kaydı oluşmaz.

Aşama 15.7'de bağlanacak gerçek iletim mekanizması için **kabul ölçütleri** (hepsi sağlanmadan `oneClickEndpointVerified` açılamaz):

| # | Ölçüt | Nasıl doğrulanır |
|---|---|---|
| K1 | Sink `durable: true` bildirir; `push`, olay kalıcı depoya yazılıp **onaylandıktan sonra** `{ stored: true, id }` makbuzuyla çözülür | `tests/helpers/sink-contract.ts` → `runSinkContract` (gerçek sink gerçeklemesiyle) |
| K2 | Aktarıcı süreci/makinesi yeniden başlasa bile 200 verilmiş olay kaybolmaz | Aynı sözleşme paketi; ayrıca gerçek ortamda: istek → süreci öldür → olay kuyrukta |
| K3 | Uygulama çevrimdışıyken olaylar birikir; hiçbiri atılmaz; uygulama açılınca hepsi çekilir | Sözleşme paketi + gerçek ortam denemesi |
| K4 | Yazma başarısızsa (disk dolu, ağ yok, kota) `push` **reddedilir**; aktarıcı **200 vermez** (503) | Sözleşme paketi (`injectWriteFailure`) + gerçek hata enjeksiyonu |
| K5 | Kuyruk dolu/geri basınç: olay ASLA sessizce atılmaz; reddedilir (503), mevcut olaylar korunur | `tests/unsubscribe-delivery.test.ts` benzeri gerçekleme testi |
| K6 | `pull` olayı tüketmez; yalnızca `ack` siler; onaylanmayan olay yeniden başlatmada tekrar gelir (en-az-bir-kez); bilinmeyen kimlik `ack`'i zararsız | Sözleşme paketi |
| K7 | Olay yalnızca uygulamada **işlendikten** (kabul, tekrar veya kalıcı ret) sonra onaylanır; altyapı hatasında onaylanmaz | `drainUnsubscribeEvents` testleri (`ingest`) |
| K8 | `push` zaman aşımı (`sinkTimeoutMs`) 503 verir; geç başarı olayı kaybettirmez (kopya olabilir, uygulama tekilleştirir) | `unsubscribe-delivery.test.ts` |
| K9 | Kuyruk uygulamaya yalnızca kimliği doğrulanmış kanaldan teslim edilir; aktarıcı ele geçirilse bile olaylar uygulamada **yeniden doğrulanır** (imza); aktarıcı yalnızca GENEL anahtarı bilir | Tasarım (kodda); gerçek kanal 15.7'de gözden geçirilir |
| K10 | Saklama süresi ≥ belirteç ömrü + güvenlik payı (en az 400 gün + 1 gün) ya da onaylanana kadar; yer sınırı aşılırsa K5 geçerlidir | Gerçekleme belgesi ve sınaması |
| K11 | İzleme: kuyruk derinliği ve en eski onaysız olayın yaşı için uyarı eşiği (aksi halde olay gecikmesi fark edilmez) | 15.7'de readiness/sağlık görünümü |
| K12 | Gerçek ortamda bellek içi sink yapılandırması hata verir (yanlışlıkla etkinleştirilemez) | `tests/unsubscribe-delivery.test.ts` (üretim/geliştirme ortamı testleri) |

Sınırlar (kanıtlanamayanlar): Bir sink'in `durable: true` bildirmesi, gerçekten dayanıklı olduğunu **kanıtlamaz**; bunu yalnızca K1–K6'nın gerçek gerçekleme üzerinde geçmesi ve K2'nin gerçek ortamda denenmesi gösterir. Tekrar oynatma kaydı (`ReplayStore`) bellek içi varsayılandır; yeniden başlatmada kaybolması güvenlidir (kopya olay uygulamada tekilleştirilir) ama kopya trafiği artırır.

### 3.2 Aşama 15.7: uygulanan kabul ölçütleri ve BEKLEYENLER

Yazılım tarafı uygulandı ve yerel testlerle (gerçek ağ/alan adı/hesap YOK) sınandı. **Gerçek ortam gerektiren her madde açıkça bekliyor**; hiçbir kapı açılmadı (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `GMAIL_HEADER_TRUST_VERIFIED`, `LEGAL_APPROVALS` hepsi `false`).

| # | Ölçüt | Durum | Kanıt / bekleyen |
|---|---|---|---|
| K1 | Dayanıklı sink, makbuzlu `push` | ✔ yazılım | `FileSpool` (`src/lib/unsubscribe/spool.ts`) sink sözleşmesinden geçer (`tests/unsubscribe-spool.test.ts`) |
| K2 | Yeniden başlatmada kayıp yok | ◐ | Yeniden başlatma (yeni örnek, yalnızca disk) testle; **güç kesintisi ve gerçek POSIX dosya sistemi dayanıklılığı gerçek ortamda sınanmadı** (Windows'ta dizin `fsync` desteklenmez) |
| K3 | Uygulama çevrimdışıyken birikme | ✔ yazılım | Sözleşme + uçtan uca testler |
| K4 | Yazma hatasında 200 yok | ✔ yazılım | Aktarıcı 503; gerçek disk hatası enjeksiyonu bekliyor |
| K5 | Geri basınç, sessiz atma yok | ✔ yazılım | `maxPending` dolunca `queue_full` → 503 |
| K6 | `pull` tüketmez, `ack` siler | ✔ yazılım | Sözleşme paketi |
| K7 | İşlendikten sonra onay | ✔ yazılım | `drainUnsubscribeEvents`; zamanlanmış iş `unsubscribe.drain` **varsayılan kapalı** (`UM_UNSUBSCRIBE_DRAIN_ENABLED`) ve hiçbir yerde açılmadı |
| K8 | `push` zaman aşımı → 503 | ✔ yazılım | `sinkTimeoutMs` |
| K9 | Kimliği doğrulanmış kanal | ✔ yazılım | Ed25519 imzalı çekme/onay/istatistik (`channel.ts`); paylaşılan sır yok. Gerçek TLS ve ağ yapılandırması bekliyor |
| K10 | Saklama ≥ belirteç ömrü | ✔ yazılım | Otomatik silme yok; yalnızca `ack` siler |
| K11 | Derinlik/yaş izleme | ◐ | `checkDeliveryHealth` + hazırlık ekranı `event_delivery`; **uyarı/bildirim kanalı (e-posta, push) YOK**, yalnızca ekran |
| K12 | Bellek içi sink gerçek ortamda engelli | ✔ | 15.6 |

**Uç nokta doğrulaması (kanıt):** `oneClickEndpointVerified` ve hazırlık "https_unsubscribe" yalnızca saklanan uçtan uca sınamadan türer (`verifyOneClickEndpoint`): imzalı sınama belirteci (kapsam `p`, hiçbir alıcıya/engele dokunmaz) → gerçek RFC 8058 `POST` (yönlendirme izlenmez, 200 şart) → olay dayanıklı kuyruktan uygulamaya ulaşır → uygulama imzayı yeniden doğrular. Adres, imza anahtarı değişince veya 30 gün sonra kanıt düşer; başarısız yeniden doğrulama eski kanıtı da siler. Hazırlıkta madde ayrıca sürüm kapısını (`LEGAL_APPROVALS.httpsUnsubscribeEndpoint`) gerektirir; o kapı da `false`.

**Gönderim yolu:** canlı kapsamdaki kutu önce canlı gönderim kilidiyle durur (kapalıyken belirteç basılmaz, anahtar/gizli depo okunmaz, sağlayıcı kurulmaz). Kilit açık olsaydı: uygunluk/ülke politikası, doğrulanmış uç nokta ve iletiye özgü imzalı bağlantı (`unsubscribe_unavailable`), `List-Unsubscribe` + `List-Unsubscribe-Post` ve Gmail sağlayıcısının kendi kapıları zorunlu. Bu yol yalnızca testte (kilit ve uygunluk sahte açıkken) çalıştırıldı.

**DNS:** SPF/DKIM/DMARC sonucu yalnızca kullanıcı "Kontrol et"e bastığında (gerçek kutu, kutunun kendi alan adı) durumlar halinde saklanır; hazırlıkta "tamam" için üçü de taze (30 gün) ve `pass` olmalı. **Gerçek alan adı üzerinde hiçbir sorgu çalıştırılmadı.**

Gerçek ortam gerektiren BEKLEYEN maddeler (bu aşamada YAPILMADI): gerçek alan adı ve HTTPS sunucusunda aktarıcının dağıtımı; gerçek TLS; `setUnsubscribeBaseUrl` ile adresin girilmesi ve `verifyOneClickEndpoint`'in gerçek uç noktaya karşı çalıştırılması (şu an bunu tetikleyen arayüz/API YOK; yalnızca servis işlevi); gerçek DNS denetimi; Gmail hesabı, OAuth ve başlık güven doğrulaması (Bölüm 1.3); gerçek POSIX disk dayanıklılığı (K2); kuyruk uyarı kanalı (K11); hukuki onaylar.

### 3.3 Aşama 15.7 entegrasyon ve güvenlik incelemesi: bulgular

**Düzeltilenler (şirket bilgisi gerektirmeyen):**

| # | Bulgu | Düzeltme |
|---|---|---|
| 1 | `LEGAL_APPROVALS` yalnızca hazırlık ekranında okunuyordu; gönderim yolunda hiçbir kapı onları denetlemiyordu (yalnızca `LIVE_SENDING_ENABLED` bayrağı bakıyordu) | Tek birleşik kapı `isLiveSendingPermitted()` (`src/lib/compliance/live-gate.ts`): bayrak VE her hukuki onay `true` olmalı. Uygunluk (`evaluateSend`), `sendCampaignStep`, ileti kurucusu, içerik oluşturma ve Gmail sağlayıcısı/fabrikası bunu kullanır |
| 2 | Alıcının engeli belgelenmiş talepte kaldırıldıktan sonra eski iletideki bağlantıya yeniden basması, aynı `jti` nedeniyle sessizce yok sayılıyordu (çıkış iradesi kaybolurdu) | Tekilleştirme tıklama zamanına bakar: aynı/eski zaman = tekrar oynatma (etki yok); daha SONRAKİ tıklama ve alıcı engelli değilse yeniden engellenir (denetimde `reclick`); hâlâ engelliyse `already` |
| 3 | Aktarıcı saati ileride/geride olduğunda geçerli çıkış olayı `event_time_invalid` ile reddedilip kuyruktan SİLİNİYORDU; belirteç "verilme zamanı" payı 5 dk idi (geride saatli aktarıcı geçerli isteği 400'lerdi) | Olay zamanı yalnızca bilgilendiricidir ve işleme anına kırpılır; belirteç sapma payı 1 saat |
| 4 | Kalıcı reddedilen olaylar iz bırakmadan onaylanıp siliniyordu | Her kalıcı ret nedeniyle (kişisel veri olmadan) `unsubscribe.event_rejected` denetim kaydı yazar |
| 5 | "Okuma izni verildi" ile "gelen kutusu okuması çalışıyor" ayrı değildi | `inbox_sync` hazırlık maddesi: yalnızca TAZE (24 sa) ve BAŞARILI gerçek eşitleme kaydıyla "tamam" |

**Doğrulananlar (testle):** canlı yol suppression (adres ve alan adı), çıkış yapmış dizi, duran kampanya, onay yokluğu, canlı ülke politikası, silinmiş alıcı, kişisel adres (`email_personal`), alan adı günlük sınırı, kutu günlük tavanı, gönderim aralığı, durdurulmuş posta kutusu, zamanlama penceresi ve doğrulanmış çıkış bağlantısı kontrollerini ATLAYAMAZ (`tests/live-send-gates.test.ts`); her hukuki onay anahtarı tek tek eksik bırakılınca gönderim durur. Hazırlık, yazılımın yerel olarak kanıtlayabildiği en iyi durumda bile `allOk=false` kalır. Tüm kapılar kapalıyken Gmail sağlayıcısı, okuyucu, eşitleme, kampanya gönderimi ve çekme işi HİÇBİR ağ isteği atmaz. İç durum anahtarları ayarlar API'sinden yazılamaz.

**Açık kalan — şirket bilgisi olmadan yapılabilecekler (bu aşamada YAPILMADI):**
1. `setUnsubscribeBaseUrl` ve `verifyOneClickEndpoint` için kullanıcı arayüzü/API YOK (yalnızca servis işlevi). Onay, kimlik doğrulama ve geri alma tasarımı gerekir.
2. Kuyruk derinliği/yaş için UYARI kanalı YOK (yalnızca hazırlık ekranı).
3. Aktarıcıda tek genel hız sınırı kovası (`clientKey` verilmezse): saldırgan tek kovayı doldurarak geçerli çıkış isteklerini 429'layabilir. Güvenilir istemci adresi başlığı dağıtım ortamına bağlıdır.
4. `lead_not_found`: kampanya alıcısı kaydı silinmişse (gerçek kampanyalar silinmiyor; yalnızca demo temizliği siler) çıkış isteği uygulanamaz; belirteçte adres olmadığı için alternatif yoktur.
5. `ReplayStore` aktarıcıda bellek içidir (yeniden başlatmada kopya olay üretir; uygulamada güvenle tekilleştirilir).

**Açık kalan — gerçek ortam/şirket bilgisi gerektirenler:** gerçek alan adı ve HTTPS aktarıcı dağıtımı, TLS, gerçek POSIX disk dayanıklılığı (K2), gerçek DNS denetimi, Gmail hesabı/OAuth, Gmail başlık güven doğrulaması (Bölüm 1.3), gelen kutusu okumasının canlıda çalıştığının kanıtı (`inbox_sync`), hukuki onaylar (`LEGAL_APPROVALS`), canlı ülke politikası kilidi, pilot.

## 4. ARF (RFC 5965) şikâyet raporları (Aşama 15.8)

Kod tarafı hazırdır (ayrıştırıcı, sınıflandırma, kanıt katmanları, suppression ve dizi durdurma, kısmi kapsam sayacı). **Gerçek bir geri bildirim döngüsü (FBL) olmadan hiçbir şey kanıtlanmadı.** Tasarım kararları:

- **Doğrulanmış şikâyet** = `Feedback-Type: abuse` + yapısal geçerli ARF (`Version: 1`) + kimlik doğrulama tasdiki (`pass`) + rapor göndericisinin alan adı **önceden ilan edilmiş güvenilir rapor sağlayıcısı** (`mail.arfReporters`, varsayılan BOŞ) + bizim gönderdiğimiz kampanya iletisiyle Message-ID eşleşmesi (30 gün, aynı posta kutusu) + (rapor verdiyse) `Original-Rcpt-To`/özgün `To` iletinin alıcısıyla birebir aynı + alıcı adresi kayıtlı. Biri eksikse rapor yalnızca **inceleme kuyruğuna** düşer; suppression, dizi durdurma, sayım üretmez.
- **Etki:** korumalı `complaint` engeli (sıradan işlemle kaldırılamaz; engel adresi rapordan değil kampanya alıcısı kaydından gelir) ve alıcının BÜTÜN bekleyen dizilerinin durması.
- **Gmail gelen kutusundan** gelen raporlar yine **Gmail başlık güven kilidine** (`GMAIL_HEADER_TRUST_VERIFIED`, kapalı) bağlıdır: kilit kapalıyken tasdik üretilmez, raporlar yalnızca incelemeye kaydedilir.

**Kısmi kapsam (şikâyet ORANI güvenilir değildir):** Şikâyet oranı kuralı (%0,1) HER ZAMAN "ölçülemiyor" gösterilir ve hiçbir otomatik durdurma kararına girmez. Çünkü ARF yalnızca FBL sunan sağlayıcılardan gelir (Gmail dahil birçoğu göndermez) ve alıcıların çoğu şikâyetini bildirmez; paydaya karşılık gelen şikâyet kapsamı bilinmez. Gösterilen sayı yalnızca son 30 gündeki doğrulanmış şikâyetli **alıcı** sayısının alt sınırıdır; incelemede bekleyen raporlar ayrı sayılır.

**Veri modeli sınırı (migrasyon yok):** `messages.classification` CHECK kısıtı `complaint` kabul etmediğinden şikâyet `other` + `error_code = arf_complaint` (doğrulanmış) / `arf_complaint:<neden>` (doğrulanmamış) olarak saklanır; dizi durumu için ayrı bir "şikâyet" değeri olmadığından `unsubscribed` kullanılır. Her ikisi de **Aşama 15.10 (ayrıca onay gerektiren migrasyon)** ile düzeltilecektir.

Gerçek ortam gerektiren BEKLEYEN maddeler (YAPILMADI):
- [ ] Hangi posta sağlayıcılarının FBL/JMRP sunduğu ve şirketin posta düzeni için kaydolunacak olanlar; rapor göndericisi alan adlarının listesi (`mail.arfReporters`; bu sürümde bilinmez, **varsayılan boş**). Listeyi ayarlamak için arayüz/API YOK (yalnızca servis işlevi).
- [ ] Gerçek bir FBL raporunun biçimi (`Original-Rcpt-To` gizleme, `Reported-Domain`, `message/rfc822` yerine `text/rfc822-headers` kullanımı) ayrıştırıcıyla uyumlu mu; raporun gerçekten kimlik doğrulamalı (DMARC `pass`) geldiği.
- [ ] Raporun, bizim `Message-ID`'mizi aynen taşıması (Gmail Message-ID yeniden yazımı, bkz. Bölüm 2) ve raporlardaki gecikme süresi (30 günlük eşleşme penceresi yeterli mi).
- [ ] ARF'nin gerçek şikâyet kapsamı (hangi sağlayıcılar kapsanıyor; kapsam doğrulanmadan şikâyet oranı kullanılmaz).

### 4.1 Aşama 15.8 güvenlik incelemesi: bulgular

- **Dizi durumu (migrasyon yok):** Şikâyetle durdurulan diziler geçici olarak `unsubscribed` durumunu kullanır; bu, çıkış talebiyle KARIŞMASIN diye sıraya `exclusionReasons=["arf_complaint"]` işareti yazılır. Arayüz (kuyruk, işletme sayfası) bunu "Şikâyet nedeniyle durduruldu" olarak gösterir; çıkış talebi "Listeden çıkmak istedi" kalır. Kampanya özet sayaçları ise ikisini hâlâ aynı `unsubscribed` kovasında sayar (düzeltme: Aşama 15.10).
- **Yeniden etkinleşme:** Durum geçişlerinin hepsi kaynak durum kümesiyle sınırlıdır (`LINKABLE_FROM`, dağıtıcı `defer/exclude`, başlatma yalnızca `pending`); durdurulmuş dizi hiçbir kampanya eylemiyle canlanmaz. Durum bir hatayla geri alınsa bile ikinci güvence olarak şikâyet ENGELİ gönderimi durdurur. Gönderim sürerken (`in_flight`) gelen şikâyette dizi durumu değişmez ama engel yazılır; sonuç kaydedildikten sonra sonraki adım engelden dolayı gönderilmez.
- **Engel korumalıdır:** sıradan kaldırma (servis ve API) reddedilir; daha zayıf nedenler (elle, olumsuz yanıt, bounce, çıkış, CSV) engeli zayıflatmaz; yalnızca silme talebi güçlendirir; engel tablosunu değiştiren tek modül `suppression.ts`'tir (kaynak taraması testi) ve API'de silme/güncelleme ucu yoktur.
- **Tekrar işleme:** aynı ham rapor `duplicate`; aynı alıcı hakkında farklı raporlar tek engel ve tek alıcı sayacı üretir; engel belgelenmiş talepte kaldırıldıktan sonra eski raporun tekrarı yeniden engel koymaz, gerçekten yeni bir rapor koyar.
- **Sahte rapor:** görünen ad/benzer alan adı/alt alan adı sahteciliği, ARF olmayan türler ve DSN/yanıt içeriği doğrulanmış şikâyet, engel, dizi durdurma veya sayaç doğurmaz.
- **Denetim ve arayüz ayrımı:** `inbound.complaint` + `suppression.added(reason=complaint)` ile `inbound.unsubscribe` / `unsubscribe.one_click` + `reason=unsubscribe` ayrıdır; çıkıştan şikâyete geçiş `suppression.strengthened (from=unsubscribe,to=complaint)` olarak ayrıca kaydedilir.
