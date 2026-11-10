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
