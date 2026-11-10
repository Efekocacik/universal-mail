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
