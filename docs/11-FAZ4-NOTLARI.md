# Faz 4 — Zamanlayıcı, Yenilik Motoru, Arayüz Cilası: Uygulama Notları

**Durum (12 Kasım 2026):** Faz 4 `feat/faz-4` dalında kodlandı; beş paket (B–F) ve P0 temeli birleştirildi, bütün kalite kapıları (typecheck, lint, format:check, test:coverage) ve üretim derlemesi üzerinde Playwright paketi yeşil. **Kabul ölçütü** ("uygulama bir hafta açık kaldığında zamanlanmış taramalar çalışır; yeni açılanlar gösterge panelinde birikir") **saat enjeksiyonlu 8 günlük benzetimle** kanıtlandı (Bölüm 7); gerçek Google anahtarıyla bir hafta süren gerçek çalışma **yapılmadı**. Gerçek Places/Place ID yenilemesi, gerçek RDAP, gerçek Gmail konuşma sürekliliği, paketlenmiş uygulamada işletim sistemi bildirimleri ve koyu vektör harita müşteri hesaplarını bekler (Bölüm 10). Canlı kapılar (`LIVE_SENDING_ENABLED`, `LIVE_INBOX_READING_ENABLED`, `LEGAL_APPROVALS`) **Faz 4'te değiştirilmedi**.

> Bu belge yalnızca kod ve testlerle doğrulanmış olanı "yapıldı" diye yazar. Sahte sağlayıcıyla, demo modunda veya benzetimle çalışan; ya da gerçek hesap, anahtar veya hukuki onay isteyen her şey açıkça işaretlidir. Bir çelişki görürseniz **kod belirleyicidir**.

## 1. Genel bakış

Simgeler: ✔ yapıldı ve test edildi · ◐ kısmen (demo/sahte sağlayıcı/benzetim kapsamında veya gerçek hesap bekliyor) · ✘ yapılmadı.

| Kalem (yol haritası) | Paket | Durum | Not |
|---|---|---|---|
| Bölge başına tekrarlayan tarama (7/14/30 gün), kaçanların telafisi | P0 + B | ✔ | Uygulama açıkken çalışır; işletim sistemi düzeyinde zamanlayıcı yok (arayüzde yazılı) |
| Google verisi alan düzeyinde saklama, yer kimliği (Place ID) yenileme | B | ◐ | Politika, temizlik ve yenileme işi testli; gerçek Google çağrısı ve türetilmiş bayrak süresi için hukuki görüş yok |
| `FUTURE_OPENING → OPERATIONAL` tespiti, "açıldı!" bildirimi, açılış izleme | B | ◐ | Demo sağlayıcıyla testli; gerçek `businessStatus` sorgusu denenmedi |
| RDAP alan adı yaşı sinyali | B | ◐ | Sahte RDAP sunucusu ve demo modunda testli; gerçek ağda denenmedi |
| Gösterge paneli | E | ✔ | Sayaçlar, bugünkü kuyruk, aylık harcama, bu hafta yeni açılanlar, yaklaşan taramalar, son bildirimler |
| Harita kullanılabilirliği, "görünümdekileri seç" | C | ✔ | Şematik haritada e2e; gerçek Google haritasında görsel kontrol anahtar bekliyor |
| Kayıtlı süzgeçler, toplu işlemler, klavye kısayolları | C | ✔ | |
| Koyu tema, boş durumlar, "Bu nedir?" balonları, TR/EN arayüz | D + entegrasyon | ◐ | Tümü var; bazı ekranlarda balon eksik ve İngilizcede tekil/çoğul ayrımı yok (Bölüm 9) |
| Takip (follow-up) adımları, aynı konuşmada | E | ◐ | Sahte Gmail sunucusuyla testli; gerçek Gmail'de konuşma görünümü denenmedi |
| Yerel bildirimler (macOS/Windows), uygulama içi zil | B + D | ◐ | Zil ve yoklayıcı testli; paketlenmiş, imzalı uygulamada denenmedi |
| Posta kutusu günlük sınırı ve ısınma arayüzü | E | ✔ | |
| Devralınan Faz 3 işleri: TB-1, TB-2, TB-10, TB-11(d) ve "hata a" | F | ✔ | Aşama 15.10-2; ayrıntı docs/08 Bölüm 5–6 |

**Paketler:** P0 (ortak temel: migrasyon `0004`, ayar anahtarları, bildirim servisi, i18n parça düzeni, beşinci gezinme öğesi) · B (tarama motoru, zamanlanmış taramalar, saklama, RDAP, bildirim API'si, işçi) · C (Keşif ekranı) · D (arayüz cilası, koyu tema, İngilizce, zil, masaüstü bildirimleri) · E (takip iletileri, günlük sınır, sihirbaz taslağı, gösterge paneli) · F (Faz 3'ten devralınan şikâyet/durma nedeni işleri). Paketler ayrı dallarda geliştirildi, bağımsız inceleme turundan geçti, `--no-ff` birleştirmelerle tek dala alındı; ardından paketler arası "dikişler" (işçi ↔ Electron IPC, zil sözleşmesi, gösterge paneli → Keşif bağlantıları, ayar kartları, hata kodlarının TR/EN metinleri, tema belirteçleri) ayrı commitlerle bağlandı.

## 2. Özellikler: kullanıcı ne görür, nasıl çalışır

### 2.1 Düzenli (zamanlanmış) taramalar

**Kullanıcı ne görür:** Tamamlanmış her tarama kartında "Düzenli tekrarla" penceresi (Ne sıklıkla? haftada bir / 2 haftada bir / ayda bir; isteğe bağlı çalışma başına USD üst sınırı); tarama oluşturucuda "Bu taramayı düzenli tekrarla" kutusu. Taramalar sayfasında "Düzenli taramalar" bölümü: her zamanlama için aç/kapa anahtarı, sıklık seçimi, sonraki çalışma, son sonuç ve zamanı, kaçırılan çalışma notu, onaylı maliyet üst sınırı ve onu değiştiren alan, "Şimdi çalıştır" (gerekirse maliyet onayı penceresiyle) ve onaylı "Zamanlamayı sil". Atlama/duraklama nedenleri sade Türkçeyle ve "ne olacak / ne yapmalısınız" diyerek yazılır. Zamanlamanın başlattığı taramalarda "Zamanlanmış" rozeti. Bölümde "zamanlamalar yalnızca uygulama açıkken çalışır" notu.

**Nasıl çalışır:**

- **Tick:** işçide tekil `scan.schedule.tick` işi 5 dakikada bir zamanı gelmiş zamanlamaları işler. Her çalışma aralığı (slot) **en çok bir kez** çalışır: tek işlemde `next_run_at` üzerinde karşılaştır-değiştir (CAS; ayrıca `enabled = 1` şartı) ve `scans(schedule_id, schedule_slot)` kısmi tekil indeksi.
- **Telafi (catch-up):** uygulama kapalıyken kaçırılan pencereler **tek** çalışmada birleşir; sayısı `missed_runs` olarak yazılır ve kartta gösterilir.
- **Maliyet onayı (M5):** zamanlama kurulurken arka plan çalışmasının kendiliğinden onaylı sayılacağı tarama başına azami tutar (`ack_max_usd`) saklanır: kullanıcı üst sınır verdiyse o, yoksa liste fiyatıyla yüksek tahmin (aylık ücretsiz kota bitince onaylı çalışmalar `NEEDS_ACK` ile atlanmasın diye). Tahmin bunu aşarsa çalışma `NEEDS_ACK` ile atlanır ve günde en çok bir "Zamanlanmış tarama atlandı" bildirimi yazılır. Kullanıcı kartta üst sınırı yeniden onaylayabilir (`PATCH maxCostUsd`).
- **Birikimli maliyet tavanı:** zamanlanmış tarama kendiliğinden sürdürmelerle onaylı tutarı aşamaz; toplam maliyeti tavanı geçirecek çağrıdan **önce** `COST_CAP` koduyla duraklar. `COST_CAP` kendiliğinden sürdürülmez; elle "Sürdür" tavanı kaldırır ve denetime yazılır.
- **Sağlayıcı değişince onay geri alınır:** Ayarlar'da `places.provider` başka bir sağlayıcıdan `google`'a geçtiğinde, aynı işlemde bütün zamanlamaların ön onayı sıfırlanır (`ack_max_usd = 0`) ve her biri için `schedule.authorized {revoked: true, providerFrom, providerTo}` denetim kaydı yazılır. Böylece demo modunda verilmiş bir onay gerçek ücretli tarama için rıza sayılmaz; sonraki çalışma `NEEDS_ACK` ile atlanır, kullanıcı kartta yeniden onaylar.
- **Kendi duraklayan çalışma:** zamanlamanın önceki çalışması hâlâ sürüyorsa sessizce `PREVIOUS_RUN_ACTIVE` (1 saat sonra yeniden bakılır). Geçici Google hatası (`PROVIDER_*`), `INTERRUPTED`/`APP_STOPPED` ya da bütçe nedeniyle durmuşsa ve kapılar izin veriyorsa **kaldığı yerden sürdürülür** (tek işlemde zamanlama CAS'ı + tarama durum CAS'ı + iş yoksa tek `scan.run`, denetim `schedule.resumed`). Bütçe hâlâ yetmiyorsa `SCAN_BUDGET_STOPPED`, kullanıcı duraklattıysa veya güvenlik tavanına (`CALL_LIMIT`) ulaşıldıysa `SCAN_PAUSED` ile atlanır (günlük hatırlatma). Duraklayan çalışma `next_run_at`'i öne çeker (geçici hatada +1 saat, diğerlerinde +1 gün); çalışma tamamlanınca veya başarısız olunca zamanlama **kendi takvimine geri döner** (elle sürdürülüp erken biten bir çalışmadan sonra ikinci ücretli tarama başlamaz).
- **Yeniden başlatma (M9):** yarıda kalan **elle** başlatılmış taramalar duraklatılmış kalır ve kullanıcıya bildirim gider. Zamanlanmış `INTERRUPTED`/`APP_STOPPED` taramalar yalnızca zamanlaması **hâlâ var ve etkinse** ve kurulum/anahtar/bütçe kapıları izin veriyorsa yeniden sıraya alınır; zamanlaması kapatılmış veya silinmiş olanlar duraklatılmış kalır ve tek bildirimde sayılır.
- **Demo zamanı (M2):** demo sağlayıcıda her zamanlanmış çalışma `mock.epoch`'u bir ilerletir; zamanla yeni ve yeni açılan işletmeler görünür.
- **Kapılar:** yeni tarama, "Yeniden tara", "Şimdi çalıştır" ve zamanlayıcı aynı ücretli tarama kapılarını kullanır (`src/lib/scan/gates.ts`): kurulum/kullanım onayı, Places anahtarı, hedef ülke, kategori seti, plan geçerliliği, bütçe, yüksek tahmin onayı.

Ana dosyalar: `src/lib/scan/{schedule,schedule-service,gates,scan-notifications,pause-codes}.ts`, `src/worker/{loop,background}.ts`, `src/features/scans/{schedules-section,repeat-fields}.tsx`.

### 2.2 Açılış izleme ve "açıldı!" bildirimi

- Tarama sonlandırılırken `FUTURE_OPENING → OPERATIONAL` geçişleri sayılır; tarama başına tek `place.opened` bildirimi ("{n} işletme açıldı!") Keşif'te o taramanın açılanlarını açar (`/?scan=<id>&lifecycle=opened&detectedSince=<tarama zamanı>`).
- Karşılaştırılabilir önceki tarama varsa tarama başına tek `scan.done` bildirimi ("{n} yeni işletme bulundu"), aynı biçimde `lifecycle=new` bağlantısıyla.
- **Açılış izleme işi** (`places.watch_future`, gün anahtarlı, varsayılan 7 günde bir yer başına, turda en çok 100): "yakında açılacak" işaretli yerleri Google'a **yalnızca kimlik ve `businessStatus`** alanlarıyla sorar; açılan yer aynı bildirim yoluna düşer. Ayar: `novelty.futureWatch`.

### 2.3 Google verisi saklama ve yer kimliği yenileme

**Kullanıcı ne görür:** Ayarlar → Google verisi altında "Google verisi saklama" kartı: sınıf başına özet (süresiz / süreli / oturum / türetilmiş), alan düzeyinde politika tablosu (her satırda Google koşullarına kaynak bağlantısı), türetilmiş bayrakların saklama süresi ve "Yer kimliklerini şimdi yenile" düğmesi. Google'ın artık bulamadığı yerin lead'inde "Google'da artık yok" rozeti.

**Nasıl çalışır:**

- Her Google alanının bir saklama sınıfı vardır (`src/lib/places/retention.ts`): yer kimliği süresiz saklanır ama 12 ayda bir yenilenir; koordinatlar en çok 30 gün; diğer içerik yalnızca oturum önbelleğinde; türetilmiş bayraklar (`statusCheckedAt` vb.) `google.derivedFlagsDays` ayarına bağlı (boş = süresiz, en az 30 gün; **hukuki görüş bekliyor**). Ayarın silmediği alanlar tabloda neden saklandığıyla (`keptBecause`: yeniden görünmeyi önler / her taramada yeniden hesaplanır / kendi verimiz) dürüstçe gösterilir. Koşulların gözden geçirildiği tarih: 12 Kasım 2026.
- **Yer kimliği yenileme** (`places.refresh_ids`, ücretsiz "IDs Only" çağrısı): kimlik aynıysa yalnızca denetim zamanı; yeni kimlikte yer, lead ve anlık görüntüler tek işlemde yeni kimliğe taşınır; yeni kimlik zaten varsa ve iki yerin de lead'i varsa eski lead `google_id_merged` etiketi alır, **lead'ler kendiliğinden birleştirilmez** (karar kullanıcıda); `NOT_FOUND` yerde `gone_at` yazılır, lead silinmez.
- Bakım turu (6 saatte bir) süresi dolan Google verisini ve türetilmiş bayrakları temizler.

### 2.4 RDAP alan adı yaşı

- Kaynak: site taramasının bulduğu alan adı (`lead_enrichment.site_domain`). RDAP sunucusuna **yalnızca kayıt edilebilir alan adı** gider; sunucu IANA önyükleme dosyasından seçilir (30 gün önbellek, yalnızca HTTPS, güvenli istemci: iç ağ adresi yok, zaman aşımı var). Yalnızca kayıt tarihi saklanır (`domain_registrations`).
- Hata geri çekilmesi 1, 3, 7, sonra 30 gün; başarılı sonuç 365 gün sonra yeniden sorulur. Büyük birikim devam çalışmalarıyla erir (5 sn aralıkla; tarama ve posta işleri önce gider).
- **Hız sınırı (429):** o RDAP sunucusu turun geri kalanında bir daha sorgulanmaz; sunucunun kalan alan adları `Retry-After` süresi sonrasına ertelenir (başlık yoksa 15 dk; 1 dk–6 sa aralığına sıkıştırılır) ve devam çalışması da en erken o ana kurulur. Hız sınırı alan adının hatası sayılmaz: deneme sayısı artmaz, 30 güne kadar giden geri çekilmeye girmez.
- Alan adı `novelty.domainYoungDays` (varsayılan 183 gün) içinde kaydedildiyse yenilik puanına `domain_young` sinyaliyle +20 eklenir. `novelty.rdap` kapalıysa sinyal ve iş çalışmaz; lead ayrıntısında "Denetim kapalı (Ayarlar > Alan adı yaşı bölümünden açabilirsiniz)" yazar.
- Demo modunda ağa hiç çıkılmaz. Ayarlar → Yenilik altında "Alan adı yaşı" kartı (durum sayıları, önyükleme yaşı).

### 2.5 Gösterge paneli

- Sayaçlar: işletme, e-postası bulunan, bu hafta yeni, bu hafta açılan, aktif kampanya (+ duraklatılan), bugün gönderilen (kullanıcının yerel günü; günlük sınır sayacının UTC günü farklıysa ayrıca gösterilir), bu ay gönderilen, yanıtlar ("ilgilenmiyor" ve "incelemede" alt satırlarıyla).
- Posta kutusu başına bugünkü kuyruk (kullanılan/tavan, bekleyen, sonraki gönderim: tavan dolunca yarına, Google geri çekilmesinde bitişine kayar, yeniden yetkilendirme gerekiyorsa söyler).
- Aylık Google harcaması ve bütçe; 3. günden itibaren ay sonu tahmini.
- "Bu hafta yeni açılanlar" listesi (en çok 8) ve Keşif bağlantıları (`/?lifecycle=opened|new&detectedSince=<hafta başı>`; bağlantının açtığı küme sayaçla birebir aynıdır, testli).
- Yaklaşan zamanlanmış taramalar (gecikmiş ve atlanmış işaretli), etkin tarama sayısı, son 5 bildirim.
- "Bu hafta" kullanıcının saat diliminde pazartesi 00:00'da başlar. Bir bölüm hesaplanamazsa yalnızca o bölüm hata gösterir; sayfa 60 sn'de bir yenilenir. Sorgular sabit sayıda, gruplanmış ve sınırlıdır (`0004` kısmi indeksleri).

### 2.6 Keşif ekranı: harita, seçim, kayıtlı süzgeçler, toplu işlemler, kısayollar

- **Harita:** "Görünümdekileri seç (N)" (nokta listesi kırpıldıysa veya sonuç 2.000'i aşarsa süzgeçle seçime geçer), "Listede yalnızca bu alan", kamera konumu ve lejant durumu yeniden yüklemede korunur, ayrı işaretçi stilleri (kampanyada/gönderildi, yanıtladı/müşteri, durduruldu, seçili), ekran okuyucu başlıkları; şematik harita bandı ile boş harita iletisi artık üst üste binmez.
- **"Yenilikler" süzgeci:** Yeni açılanlar / Açılışı beklenenler / Yeni tespit edilenler ve "Ne zamandan beri" (7 gün / 30 gün / tüm zamanlar); etkin süzgeçler kaldırılabilir çip olarak. Bağlantılar: `/?scan=&lifecycle=&detectedSince=&archived=1`; `opened`/`new` bağlantısı `detectedSince` vermezse ayardaki "yeni" penceresi (varsayılan 60 gün) uygulanır, `detectedSince=0` tüm zamanlardır.
- **Kayıtlı süzgeçler:** kaydet (isteğe bağlı harita alanıyla; aynı adda "Üzerine yaz"), uygula, "Değişti · Güncelle", yeniden adlandır, sil. Tarih dönemi göreli gün olarak saklanır. Artık geçersiz seçenek içeren kayıt üstü çizili gösterilir, yalnızca silinebilir. En çok 50 kayıt; adlar Türkçe büyük/küçük harf duyarsız tekildir.
- **Toplu işlemler:** satır kutuları (Shift ile aralık), "Süzgece uyan tümünü seç (N)". Seçim çubuğunda: E-posta bul, Kampanyaya ekle (500'lük parçalarla, kısmi hatada "Yeniden dene"), Dışa aktar (yalnızca seçilenler; Google alanları isteğe bağlı), Arşivle / Arşivden çıkar, "İletişime geçme" olarak işaretle. Arşivleme ve "İletişime geçme" önce sunucuda **kuru çalıştırma** yapar ve onay penceresinde kaçının değişeceğini, zaten o durumda olanı, kampanyası süreni ve artık olmayanı gösterir. Arşivlemeden sonra "Geri al" yalnızca değişen kimlikleri geri çevirir. Arşivdekiler liste, harita, süzgeç sayıları ve süzgeçle dışa aktarmada gizlenir, yeniden tarama onları geri getirmez. "İletişime geçme" toplu kaldırılamaz; lead ayrıntısında onayla tek tek kaldırılır.
- **Kısayollar:** tek kayıt hem işleyicileri hem "?" yardım penceresini besler: J/K sonraki/önceki, / ara, X seç, E e-posta bul, C kampanyaya ekle, F sığdır, V yalnızca bu alan, ? yardım, Esc (çizim → seçim → ayrıntı sırasıyla). Metin alanında, pencerede, IME bileşiminde ve Ctrl/Alt/Cmd ile yok sayılır; Türkçe klavyede / ve ? çalışır. Önceki J/K gerilemesi (ayrıntı açıkken ikinci J'nin çalışmaması) düzeltildi.

### 2.7 Koyu tema, tam İngilizce, boş durumlar, "Bu nedir?" balonları

- **Ayarlar → Görünüm ve dil:** dil (Türkçe / English), tema (Sistem / Açık / Koyu), masaüstü uygulamasında "Bilgisayar açılınca başlat" ve "Masaüstü bildirimleri". Tema sunucuda `<html>` üzerine uygulanır (açık-koyu yanıp sönmesi yok); "Sistem" yalnızca CSS ile işletim sistemini izler. Bildirim baloncukları, Electron pencere arka planı, yerel menü ve pencereler, Google haritası (DARK renk şeması) temayı izler.
- **Tema belirteçleri:** bütün renkler açık, koyu ve sistem-koyu bloklarında tanımlı; ana metin/arka plan çiftleri WCAG AA kontrast testinden geçer. `src/features` ve `src/components` altındaki her `.ts/.tsx` dosyası sabit hex/rgb/hsl renk için taranır (tek belgelenmiş istisna: e-posta istemcisini taklit eden önizleme).
- **Tam İngilizce:** temel sözlüğün tamamı ve her parça çevrildi; `en` sözlüğü türde `Record<TrKey, string>` olduğundan eksik anahtar derlemeyi kırar. Eşlik testi eksik/fazla anahtarı, yer tutucu uyuşmazlığını, İngilizcede kalmış Türkçe harfi ve yardım metni uzunluğunu denetler. Dil değişince ekran yeniden kurulur; kaydedilmemiş değişiklik varsa önce uyarır, kurulum sihirbazı taslağını taşır.
- **Hata kodları:** her API hata yanıtı kararlı bir `code` (BÜYÜK_HARF) taşır; Türkçe arayüz sunucunun metnini, İngilizce arayüz `apiError.<KOD>` metnini gösterir (Türkçe sunucu metni İngilizcede asla görünmez). Kod kataloğu testle toplanır, her kodun TR ve EN metni zorunludur. Sayı, para, tarih ve göreli zaman etkin dile göre biçimlenir.
- **Boş durumlar ve balonlar:** suppression, denetim, silme geçmişi, şablonlar, zamanlamalar, kayıtlı süzgeçler ve gösterge panelinde "süzgeç sonucu boş" ile "hiç kayıt yok" ayrı ve açıklamalı; yeni ekranlarda yeniden denenebilir hata durumu. "Bu nedir?" balonu tıklama/dokunma/Enter ile açılır (farede 200 ms sonra üzerine gelince de), sabitlenebilir; ekran okuyucu için `aria-describedby` ve canlı bölge.
- **Dar ekran:** 320 px'te üst çubuk taşmaz (TB-9); 640 px altında demo göstergesi başlığın altında tek satır şerittir. Genişlik planı Bölüm 5'te.

### 2.8 Uygulama içi zil, işletim sistemi bildirimleri ve uyanma

- **Zil:** üst çubukta okunmamış rozeti (9 üstü "9+"), liste, "tümünü okundu işaretle". Öğeye tıklamak okundu işaretler ve **yalnızca uygulama içi** bir yola gider. Tarayıcıda yeni bildirim kısa bir toast olarak da görünür (masaüstünde OS bildirimi açıksa toast gösterilmez).
- **Bildirim türleri:** `scan.done`, `scan.failed`, `scan.paused`, `place.opened`, `schedule.skipped`, `background.skipped`. Her olayın tekilleştirme anahtarı vardır (aynı olay iki kez yazılmaz); metin okunurken arayüz dilinde üretilir, bildirimde Google içeriği yoktur.
- **İşletim sistemi bildirimleri (Electron):** ana süreç 30 sn'de bir ve işçinin `{type:'notify'}` dürtmesiyle hemen `POST /api/notifications/os-claim`'i yoklar (aynı-köken `Origin` başlığıyla). Sahiplenme tek `UPDATE … RETURNING`'dir: her bildirim işletim sisteminde **en çok bir kez** görünür (dürtme fırtınası ve iki yoklayıcıyla testli). Aynı anda 3'ten fazlası tek özet bildirimde birleşir ve gösterge panelini açar. Tıklama pencereyi öne getirip uygulama içi yolu açar. `notifications.os` kapalıysa hiçbir şey gösterilmez.
- **Çıkış teslimat uyarısı (TB-4, kısmen):** yeni bir çıkış teslimat uyarısı belirince bir kez OS bildirimi gösterilir (uyumluluk sayfasını açar); uygulama yeniden açıldığında aynı uyarı tekrarlanmaz.
- **Uyanma IPC'si:** sistem uykudan dönünce veya ekran kilidi açılınca Electron işçiye `{type:'wake'}` gönderir; pencere odağı en çok 60 sn'de bir uyandırır. İşçi zamanlayıcı tick'ini öne çeker ve gönderim dağıtıcısını `wakeDispatchSafely` ile uyandırır (tek `mail.send` işi; iş yoksa ekler, bekliyorsa öne çeker, çalışıyorsa bayrak bırakır; gönderim zamanlayıcısı kapalıysa hiçbir şey yazmaz). İki eylem birbirinden bağımsızdır; biri başarısız olursa `wake.failed` günlük satırı yazılır ve 30 sn'lik tekilleştirme penceresi tüketilmez (sonraki uyandırma beklemeden denenir).
- **Gösterilemeyen OS bildirimi:** gösterim hatası (izin kapalı, platform desteklemiyor, `Notification` `failed` olayı) ana süreç günlüğüne `toast.failed` olarak düşer ve kalan bildirimleri engellemez. Sahiplenilmiş ama gösterilememiş bildirim yeniden gösterilmez; **zil tek doğru kaynaktır**. Gösterilemeyen teslimat uyarısı "bildirildi" sayılmaz, sonraki yoklamada yeniden denenir.
- **Günlük döndürme (M9):** `app.log` 5 MB'ta `.1` ve `.2`'ye döner.

### 2.9 Takip iletileri ve aynı konuşma

- **Yanıt incelemede iken takip bekler (9a):** alıcıdan ilk e-postadan sonra gelen ve hâlâ incelemede bekleyen bir ileti varsa takip `inbound_review_pending` ile ertelenir (6 saatte bir yeniden bakılır); dizi bitmez, inceleme kararıyla kalkar. Kuyrukta neden ve "İncelemeye git" bağlantısı.
- **Hazır takip şablonları (9b):** tohum v2 dört şablon ekler (Takip 1/2 TR, Follow-up 1/2 EN); yalnızca eksik olanı ekler, mevcut şablona dokunmaz. Sihirbaz takip sayısı artınca hazır takipleri önerir.
- **Başlat öncesi özet (9c):** her adımın önizlemesi (eksik değişkenler işaretli), "en çok N e-posta, son takip ≥ X gün sonra, ~Y gün" tahmini; yeni uyarılar `followup_missing_variables`, `followup_compose_error`.
- **Aynı konuşma (9d):** şablonda "İlk e-postanın konusunu kullan" (`followup_reuse_subject`, varsayılan açık) ise takip "Re: <ilk konu>", `In-Reply-To`/`References` başlıkları ve geçerliyse Gmail `threadId` ile gider. Şablon konusunda "Re:" yasağı sürer; "Re:" yalnızca ileti kurucusu tarafından eklenir.
- **Sihirbaz:** yerel taslak (1 sn sonra, 7 gün, kampanya sürümüne bağlı; "Geri yükle / Taslağı sil"), geri/kaydırma koruması (kaydedince veya atınca koruma girdisi kaldırılır).
- **Hemen gönderim (hata b):** kampanyayı başlatmak/sürdürmek, incelemede "gönderilmedi" kararı ve kutu tavanını yükseltmek dağıtıcıyı hemen uyandırır. Hiçbir gönderim kuralı gevşemez (90 sn aralık, tavan, ısınma, gönderim penceresi, uygunluk gönderim anında yine uygulanır).

### 2.10 Posta kutusu günlük sınırı ve ısınma

- Ayarlar → Posta kutuları → "Günlük sınır" (demo kutusu hariç): günlük tavan ve haftalık ısınma artışı, canlı önizleme ("bugün X, gelecek hafta Y, N haftada tavana"), kişisel Gmail'de günde 30 üstü için risk uyarısı, satır içi hatalar (`aria-describedby` bağlı), eski sürüm çakışması iletisi.
- Sınırlar: kişisel Gmail 10/gün başlar, haftada en çok +5, en çok 50; diğer kutular 20 başlar, en çok +10, en çok 80. Tavan üstü değer **reddedilir**, sessizce kırpılmaz.
- **Rampa atlanamaz:** daha yüksek tavan veya artış bugünkü tavandan devam eder (ısınma başlangıcı yalnızca ileri kaydırılır); pencere bunu açıklar. Eşzamanlılık belirteci `updated_at` değil sınır alanlarının kendisidir (gelen kutusu eşitlemesi sahte 409 üretmez). Aynı değerle tekrar hiçbir şey yazmaz.
- Sihirbaz, kampanyanın günlük sınırı kutunun bugünkü tavanını aşarsa ipucu gösterir.

### 2.11 Devralınan Faz 3 işleri (paket F): TB-1, TB-2, TB-10, TB-11(d), "hata a"

Faz 3'te ekip içinde ayrıca planlanmış Aşama 15.10-2 işleri Faz 4 paket F'de devralındı (sahip onayıyla). Özet; ayrıntılı davranış ve geri alma sözleşmesi docs/08 Bölüm 5 ve 6'da:

- **TB-1:** ARF şikâyeti `messages.classification = 'complaint'` olarak yazılır; eski işaret aynı satıra çift yazılır (0003 geri alması çalışmaya devam eder). Okuma sütundan, eski satırlarda işaretten.
- **TB-2:** her durdurma yolu ortak çekirdekle (`src/lib/mail/inbound/stop.ts`) `stop_reason` yazar; arayüz "Listeden çıktı" ile "Şikâyet nedeniyle durdu"yu ayırır; şikâyet çıkıştan ağırdır.
- **TB-10:** tamamlanmış dizi sonraki çıkış/şikâyette `completed` kalır, yalnızca neden yazılır ("Tamamlandı, sonra …"). Neden yalnızca olayın ait olduğu diziye yazılır.
- **TB-11(d):** doğrulanmış şikâyet aynı işletmenin diğer adreslerine **o anda süren** dizileri de durdurur; diğer adresler engellenmez, bitmiş dizilere dokunulmaz. Durdurulan kimlikler ve işletme alan adı denetime yazılır (adres yazılmaz).
- **"Hata a":** "gönderildi" artık "en az bir ileti kabul edildi" demektir; hiç ileti almamışlar ayrı kovalarda ("ileti almadan durdu", "önceden yanıt verdiği için ileti almadı"); çıkış ve şikâyet ayrı "Bunlardan: …" satırında.

## 3. API uçları (Faz 4)

Bütün değiştiren uçlar ara katmanda aynı-köken denetiminden geçer, gövdeyi zod `.strict()` ile doğrular (geçersiz gövde 400 `VALIDATION`, bozuk JSON 400 `BAD_JSON`, geçersiz kimlik 400 `INVALID_ID`) ve denetim kaydı yazar (os-claim hariç: makine yoklaması). Her hata yanıtı `{error, code, …}` biçimindedir.

### 3.1 Yeni uçlar

| Yöntem ve yol | Gövde / sorgu | Başarılı yanıt | Hata kodları |
|---|---|---|---|
| `GET /api/schedules` | — | 200 `{schedules:[{id, regionId, regionName, countryCode, categories, customKeywords, strategy, fieldProfile, intervalDays, enabled, nextRunAt, lastRunAt, lastScanId, lastOutcome, lastSkipCode, missedRuns, maxCostUsd, ackMaxUsd, createdAt}]}` | — |
| `POST /api/schedules` | `{fromScanId, intervalDays?: 7\|14\|30 (vars. 14), maxCostUsd?: number\|null}` | 201 `{id, nextRunAt, ackMaxUsd}`; ülke hedef dışıysa ayrıca `warning:{code:"COUNTRY_NOT_TARGETED"}` | 403 `SETUP_REQUIRED`; 404 `SCAN_NOT_FOUND`; 409 `SCAN_NOT_STARTED`, `SCHEDULE_EXISTS` (`scheduleId` ile) |
| `PATCH /api/schedules/{id}` | `{intervalDays?, enabled?, maxCostUsd?}` (en az biri) | 200 `{schedule}` | 404 `SCHEDULE_NOT_FOUND` |
| `DELETE /api/schedules/{id}` | — | 204 (geçmiş taramalar kalır, zamanlamanın bildirimleri silinir) | 404 `SCHEDULE_NOT_FOUND` |
| `POST /api/schedules/{id}/run-now` | `{acknowledgeRisk?: boolean}` (boş olabilir) | 201 `{scanId}` | 403 `SETUP_REQUIRED`; 400 `PLACES_KEY_MISSING`, `COUNTRY_NOT_TARGETED`, `CATEGORY_SET_MISSING`, `PLAN_INVALID`; 409 `BUDGET_BLOCKED`, `NEEDS_ACK`, `ACTIVE_SCAN`, `RACE`; 404 `SCHEDULE_NOT_FOUND` |
| `GET /api/notifications` | `?limit=1..50 (vars. 20)&before=<id>&unread=0\|1` | 200 `{items:[{id, kind, title, body, url, createdAt, readAt}], unread}` | 400 (bilinmeyen/geçersiz parametre) |
| `POST /api/notifications/read` | `{ids: number[1..200]}` veya `{all: true}` | 200 `{updated, unread}` (idempotent) | 400 |
| `POST /api/notifications/os-claim` | gövde yok | 200 `{items:[…]}`: okunmamış, OS'ta gösterilmemiş, son 24 saatteki en çok 5 bildirim atomik sahiplenilir; `notifications.os` kapalıysa `[]` | 403 (aynı-köken `Origin` yoksa) |
| `GET /api/dashboard` | `?tz=<IANA>&locale=tr\|en` | 200 bölümlü gövde `{generatedAt, timeZone, weekStart, today, month, counters, queue, budget, newThisWeek, scans, notifications, errors[]}`; `no-store`, `Server-Timing` başlığı; hesaplanamayan bölüm `null` ve adı `errors`'ta | 400 `INVALID_QUERY` |
| `POST /api/google-data/refresh-ids` | `{limit?: 1..5000}` (vars. 500; boş olabilir) | 202 `{queued, jobId}`; gün başına bir elle istek (tekrar `queued:false`) | 403 `SETUP_REQUIRED` |
| `POST /api/leads/rdap` | `{leadIds?: int[1..500]}` (boş = tümü) | 202 `{added, queued}` | 403 `SETUP_REQUIRED`; 409 `RDAP_DISABLED` |
| `GET /api/settings/novelty/rdap-status` | — | 200 `{enabled, demo, bootstrap, counts, due, lastCheckedAt}` | — |
| `POST /api/leads/bulk` | `{action: archive\|unarchive\|do_not_contact, selection: {leadIds: int[1..2000]} \| {filterQuery: string ≤ 8000}, dryRun?}` | 200 `{action, matched, changed, skipped:{unchanged, activeCampaign, notFound}, capped, matchedTotal, dryRun, changedIds}`; hepsi zaten istenen durumdaysa `changed: 0` | 400 `FILTER_INVALID`; 409 `NOTHING_MATCHED` (hiç uyan yoksa) |
| `GET /api/saved-filters` | — | 200 `{items}` (son kullanılan önce; geçersizleşmiş kayıt `invalid: true`) | — |
| `POST /api/saved-filters` | `{name ≤ 60, payload (sürümlü, v:1), sort?, overwrite?}` | 201 `{item}`; `overwrite` ile 200 | 409 `SAVED_FILTER_EXISTS`, `SAVED_FILTER_LIMIT` (50) |
| `PATCH /api/saved-filters/{id}` | `{name?, payload?, sort?}` (en az biri) | 200 `{item}` | 404 `SAVED_FILTER_NOT_FOUND`; 409 `SAVED_FILTER_EXISTS` |
| `DELETE /api/saved-filters/{id}` | — | 204 (idempotent; kayıt yoksa da) | — |
| `POST /api/saved-filters/{id}/use` | — | 204 (son kullanım zamanı) | 404 `SAVED_FILTER_NOT_FOUND` |
| `POST /api/export/leads` | `{selection, google?: boolean = false}` | 200 CSV; kimlikle seçimde arşivdekiler dahil, süzgeçle seçimde hariç | 400 |
| `PATCH /api/mailboxes/{id}/limits` | `{dailyCap?: 1..80, warmupStep?: 0..10, expected:{dailyCap, warmupStep}}` (en az biri); kullanım onayı gerekir | 200 `{id, dailyCap, warmupStep, updatedAt, todayCap, warmupRebased, unchanged, wake}` | 400 `CAP_ABOVE_PROVIDER_MAX` / `WARMUP_STEP_ABOVE_MAX` (`max` ile); 404 `NOT_FOUND`; 409 `NOT_EDITABLE` (demo), `CONFLICT` (`expected` eski) |

### 3.2 Değişen uçlar (geriye uyumlu eklemeler)

| Uç | Değişiklik |
|---|---|
| `GET /api/status` | `unreadNotifications`, `schedules:{total, due, nextRunAt}` |
| `GET /api/config` | `notificationsOs` (Electron yoklayıcısı ve zil okur) |
| `PUT /api/settings` | `places.provider` başka sağlayıcıdan `google`'a geçerse aynı işlemde zamanlama ön onayları sıfırlanır (Bölüm 2.1) |
| `GET /api/google-data` | `termsReviewedAt`, `byPolicy {indefinite, ttl, session, derived}`, `policy[] {field, class, storage, maxDays, refreshAfterDays, termsRef, legalReview, keptBecause}` |
| `GET /api/leads/{id}` | `place.goneAt`; `domainAge: {domain, status: pending\|ok\|no_date\|not_found\|unsupported_tld\|rate_limited\|error\|disabled, registeredAt, checkedAt} \| null` |
| `PATCH /api/leads/{id}` | gövde artık `.strict()`; "İletişime geçme"den çıkarmak `confirmUnblock: true` ister, yoksa 409 `LEAD_UNBLOCK_CONFIRM` (kaldırma `lead.unblocked` olarak denetlenir) |
| `GET /api/leads`, `/points`, `/facets`, `GET /api/export/leads` | `lifecycle=opened\|future\|new` (virgüllü), `detectedSince=<epoch ms ≥ 0>`, `archived=1`; geçersiz değer 400 `FILTER_INVALID`. API varsayılan pencere uygulamaz (yalnızca Keşif bağlantısı uygular) |
| `POST /api/leads/find-emails` | ortak 8.000 karakterlik süzgeç şeması; `leadIds` pozitif tamsayı; ön izlemede `matched`, `capped`, `max` (2.000); süzgeç kipinde zaten aranmış ve "iletişime geçme" lead'ler LIMIT'ten önce atlanır (her tekrar sonraki 2.000'i alır); hiç uyan yoksa 400 `NOTHING_MATCHED` |
| `POST /api/scans`, `POST /api/scans/{id}/rerun` | ortak kapılar; `NEEDS_ACK` yanıtında `highUsd`, `remainingUsd` (arayüz tutarları dile göre biçimler) |
| `GET /api/campaigns`, `GET /api/campaigns/{id}` | `breakdown[] {status, contacted, stopReason, n}` |
| `GET /api/campaigns/{id}/leads`, `GET /api/leads/{id}/campaigns` | `stopReason: unsubscribe\|complaint\|null` |
| `GET /api/mailboxes` | `limitsEditable`, `consumerGmail`, `warmupStartedAt`, `updatedAt`, `limits {todayCap, warmupBase, maxDaily, profileMaxDaily, maxWarmupStep}` |
| Şablon oluştur/güncelle/listele | `followupReuseSubject` |
| Başlat öncesi özet | `previews[].steps[]`, `estimate {stepCount, totalMessages, lastFollowupAfterDays, totalDays}`, iki yeni uyarı |
| `GET /api/oauth/gmail/callback` | sonuç sayfası `ui.language` dilinde |

**İşçi IPC sözleşmesi:** Electron → işçi `{type:'wake'}`; işçi → Electron `{type:'notify'}` (yoklayıcıyı dürter). **Yeni denetim eylemleri:** `schedule.created`, `schedule.authorized`, `schedule.updated`, `schedule.started`, `schedule.skipped`, `schedule.resumed`, `notifications.read`, `places.ids_refresh_requested`, `novelty.rdap_requested`, `novelty.rdap_checked`, `lead.bulk` (yalnızca kimlik sayısı; kimlik listesi veya arama metni yok), `lead.unblocked`, `saved_filter.created/updated/deleted`, `mailbox.limits_updated` (adres yok).

## 4. Veri modeli: migrasyon `0004_faz4` ve geri alma

**`drizzle/0004_faz4.sql`** tek, elle düzenlenmiş ve **yalnızca ekleyen** bir migrasyondur (0003 emsali): mevcut tablolar yalnızca `ALTER TABLE … ADD` ile sütun alır (CHECK satır içi), yeni tablo ve indeksler `IF NOT EXISTS` ile kurulur; hiçbir satır yeniden yazılmaz, silinmez veya taşınmaz. Eski sürüm yeni sütunları okumaz.

- **Yeni tablolar:** `scan_schedules` (aralık CHECK 7/14/30, `scan_key` tekil, onay alanları birlikte dolu/boş — tutar NULL iken onay anı tek başına kalamaz, `last_outcome` ve `last_skip_code` biçim denetimi; `scan_schedules_due_idx (enabled, next_run_at)`), `notifications` (`dedupe_key` tekil, `kind` yalnızca biçim denetimi — izinli türler kodda; `url` yalnızca uygulama içi yol; OS bekleyenleri için kısmi indeks), `domain_registrations` (durum CHECK, `ok` ise tarih zorunlu, küçük harf alan adı), `saved_filters` (`name_key` tekil, `payload` JSON nesnesi ≤ 16.000).
- **Yeni sütunlar:** `scans.origin` (`manual`/`schedule`), `scans.schedule_id` (silinince NULL), `scans.schedule_slot` (+ `(schedule_id, schedule_slot)` kısmi tekil indeksi), `scans.pause_code`; `places.place_id_checked_at`, `gone_at`, `status_checked_at`; `leads.archived_at`; `lead_enrichment.site_domain`; `templates.followup_reuse_subject` (varsayılan açık).
- **Yeni indeksler:** açılan/yeni tespit tarihleri ve ilk görülme (gösterge paneli ve Keşif), açılış izleme ve kimlik yenileme kuyrukları, arşiv (kısmi), giden kampanya iletisi gün/kutu ve gelen ileti alış zamanı (kısmi).
- **Yeni ayar anahtarları** (tablo değişikliği yok): `maps.mapId` (satır içi doğrulama), `ui.theme`, `app.openAtLogin`, `notifications.os`, `novelty.rdap`, `novelty.rdapBootstrap`, `novelty.domainYoungDays` (30–730, vars. 183), `novelty.futureWatch`, `google.derivedFlagsDays` (null veya 30–3650), `mail.dispatch.wakeRequestedAt` (iç).

**Geri alma: `scripts/rollback-0004.ts`** (kütüphane `src/lib/db/rollback-0004.ts`; uygulamanın normal yolu bu modülü asla içe aktarmaz, testle doğrulanır). 0003 ile aynı iki aşamalı güvenlik:

1. Plan (varsayılan, hiçbir şey değiştirmez): `npx tsx scripts/rollback-0004.ts --db <dosya>` — hedef yalnızca `--db`'dir (ortam değişkenleri ve varsayılan veri yolu kullanılmaz); silinecek Faz 4 verisinin sayıları ve tek kullanımlık doğrulama kodu yazılır.
2. Uygulama (uygulamanın **bütün** süreçleri kapalıyken): `--confirm <KOD>`; Faz 4 verisi varsa ayrıca `--accept-data-loss`; hedef geçici dizinde değilse ayrıca `--allow-live-data --type-db-name <dosya-adı>`.

Geri alma **kayıplıdır ve bu açıkça onaylanır:** zamanlamalar, bildirimler, kayıtlı süzgeçler, RDAP önbelleği, arşiv işaretleri ve yeni sütunlar silinir; arşivlenmiş lead'ler yeniden etkin görünür. Önce `backups/pre-rollback-0004-<zaman>.db` yedeği alınır ve **doğrulanmadan** başlanmaz. `scans.schedule_id` yabancı anahtar olduğundan `scans` tablosu 0000 tanımıyla güvenli kalıpla yeniden kurulur (kimlikler ve bağlı tablolar korunur); diğer sütunlar `DROP COLUMN` ile kaldırılır. Satır sayısı, kimlik toplamı, sıra, indeks kümesi ve yabancı anahtar bekçilerinden biri düşerse işlemin tamamı geri alınır; şema bakım kilidi başka süreçle çakışmayı engeller. 0004 kaydı migrasyon tablosundan silinir (yeniden yükseltme 0004'ü yeniden uygular). Sonrasında veritabanı yalnızca Faz 4 öncesi sürümle açılmalıdır; tam geri dönüş için yedek kullanılır. Testler: `tests/migration-0004.test.ts`.

## 5. CI hatası: P0 temelinde beşinci gezinme öğesi taşması

- **Belirti:** P0 temelinin son commiti (`b2bee00`, "P0 inceleme bulguları") üzerindeki iki CI çalışması yalnızca `npx playwright test` adımında düştü (kalite işi geçti). O commitin yerel derlemesinde 2 senaryo düştü: `campaigns.spec.ts` ve `templates-compliance.spec.ts` içindeki "dar ekran (390 px)" testleri, sayfa yatay olarak 8 px taşıyordu.
- **Kök neden:** P0'da üst çubuğa eklenen beşinci gezinme öğesi ("Gösterge paneli") başlığı genişletti. Paket D'nin başlık çalışması sayfa düzeyindeki taşmayı gidermişti (birleşik dal bu yüzden yeşildi), ancak ölçümle görüldü ki hata **768–1279 px** arasında sürüyordu: gezinme kutusu küçülüyor (`min-w-0`) ve öğeleri kutudan taşıyor, DEMO rozeti "Ayarlar"ın üstüne biniyor, bütçe hapı iki satıra kırılıyordu. Taşma başlığın içinde kaldığı için sayfa düzeyindeki taşma denetimleri bunu göremiyordu.
- **Düzeltme (`src/components/app-shell.tsx`):** gezinme artık küçülmez (`shrink-0`); gezinme etiketleri `lg` (1024 px) ve üstünde, logo metni ve uzun bütçe metni `xl` (1280 px) ve üstünde görünür; altında bütçe hapı kısa biçimde ("$x / $y") ve tek satırdır, tam metin erişilebilir ad ve araç ipucu olarak kalır. Genişlik planı `docs/07-UI-REHBERI.md`'ye yazıldı.
- **Gerileme testi (`e2e/ui-polish.spec.ts`):** "üst çubuk: 320–1440 px, Türkçe ve İngilizce" yedi genişlikte ve iki dilde sayfa taşması olmadığını, gezinmenin kendi kutusuna sığdığını, gezinme ile sağ grubun çakışmadığını, sağ grubun başlık içinde kaldığını ve bütçe hapının kırılmadığını denetler. Düzeltme olmadan "tr 768px"te 118 px gezinme taşmasıyla düştüğü doğrulandı.
- Sonuç: düzeltme commitinden ("üst çubukta beşinci gezinme öğesi hiçbir genişlikte taşmaz ve çakışmaz") sonra CI yeşil; e2e art arda iki kez `CI=true`, `TZ=UTC` ile ve bir kez CPU yükü altında, tekrar denemesiz geçti.

## 6. Testler

Son kapı (CI ile aynı sıra: `typecheck`, `lint`, `format:check`, `test:coverage`, `build`, `CI=true TZ=UTC npx playwright test`): hepsi geçti.

- **Birim/entegrasyon (Vitest):** 122 dosya, 2261 test geçiyor, 1 atlanıyor. Kapsam (eşikler 80/80/80/70): ifadeler %94,91, dallar %88,18, fonksiyonlar %96,07, satırlar %96,58. Bütün testler geçici veritabanlarıyla çalışır.
- **Uçtan uca (Playwright):** 81 senaryo, üretim derlemesine karşı (`npm run build`, ardından `npx playwright test`; geçici veri klasörü). Art arda iki tam koşu: 81/81 geçti, 0 hata, 0 kararsız (tekrar denemesiz).
- Faz 4'ün yeni test dosyaları: `faz4-acceptance`, `scan-schedule`, `scan-faz4-fixes`, `worker-faz4`, `future-watch`, `google-retention`, `rdap`, `notifications-api`, `scan-ui-models`, `leads-bulk`, `saved-filters`, `explore-ux`, `i18n-en-parity`, `api-error-text`, `error-codes`, `format-locale`, `theme-tokens`, `electron-notify`, `electron-ui-prefs`, `electron-ipc-seams`, `notification-bell`, `locale-switch`, `dashboard`, `faz4-e-dispatch-limits`, `faz4-e-followups`, `faz4-e-ui-models`, `complaint-stop-reason`, `migration-0004`. Yeni e2e dosyaları: `schedules`, `explore`, `ui-polish`, `dashboard`, `faz4-e-campaigns`, `complaint-stop`.
- Düzeltme testlerinin düzeltme olmadan düştüğü (birikimli maliyet tavanı, üst çubuk, tema belirteci denetiminin düzenli ifadesi, 0003 geri alma) ayrıca doğrulandı. Eşzamanlılık testleri gerçek rotalar ve geçici veritabanıyla yapılır; kod altındaki birim taklit edilmez.

### 6.1 Son denetim

Son kapıdan önce güvenlik, şema ve olay (incident) odaklı denetim yedi bulgu verdi. Her biri kodla doğrulandı:

| Önem | Bulgu | Sonuç |
|---|---|---|
| P1 | `scan.run` işinde onay/sağlayıcı hazırlığı `try` dışındaydı; fırlarsa tarama işsiz "kuyrukta" kalıyor, zamanlama her tick `PREVIOUS_RUN_ACTIVE` ile sessizce atlıyordu | **Düzeltildi:** hazırlık `try` içinde; kuyrukta/çalışan tarama başarısız işaretlenir, zamanlamaya `failed` sonucu ve `scan.failed` bildirimi gider. Test: `worker-faz4` |
| P2 | RDAP 429'dan sonra aynı sunucuya sorgu sürüyor, `Retry-After` yok sayılıyor, deneme sayısı artıyordu | **Düzeltildi** (bkz. 2.4). Test: `rdap` |
| P2 | `scan_schedules_ack_ck` NULL deliği (tutar NULL + onay anı dolu satır geçiyordu) | **Düzeltildi:** 0004 yayınlanmadığı için yerinde; şema ve anlık görüntü eşlendi. 0004'ü önceden uygulamış geliştirme veritabanı eski kısıtı korur (geri alma + yeniden uygulama ile yenilenir). Test: `migration-0004` |
| P2 | İşçi açılışında bakım turu `recover()` ile çakışıp `TRANSACTION_ACTIVE` ile işçiyi çökertebiliyordu | **Düzeltildi:** `recover()` bakım turundan önce ve kısa yeniden denemeyle çalışır; ilk tick hatası işçiyi düşürmez; Electron her yeniden başlatmada art arda çökme sayısını günlüğe yazar. Test: `worker-faz4` (yardımcı) |
| P2 | Tick zincirini yeniden kurma hatası zinciri koparıp asıl hatayı gölgeliyordu | **Düzeltildi:** yeniden kurma birkaç kez denenir, olmazsa `tick.rearm_failed`; `/api/status` `schedules.tickArmed` ve `schedules.stalled` (10 dk'dan uzun tick'siz bekleyen zamanlama) döner. Test: `worker-faz4`, `scan-schedule` |
| P2 | Uyanmada tick hatası gönderim uyandırmasını engelliyor, 30 sn kapısını tüketiyordu | **Düzeltildi** (bkz. 2.8). Test: `worker-faz4` |
| P2 | OS bildirimi: gösterim hatası kalanları düşürüyor, yoklama reddi işlenmiyor, dil okuması sahiplenmeden sonra 500 verebiliyordu | **Düzeltildi** (bkz. 2.8). Test: `electron-notify` |

**Ertelenen (izleme):** `stalled` bayrağı ve "işsiz kuyrukta tarama" durumu henüz arayüzde uyarı olarak gösterilmiyor; tükenen bakım turu yeniden denemeleri yalnızca günlükte. Kök nedenler düzeltildiği için bunlar uyarı katmanı olarak sonraki fazın izleme işine bırakıldı. **Çalışma kılavuzu:** zamanlamalar çalışmıyorsa `/api/status` → `schedules.stalled`; işçiyi yeniden başlatmak (açılış tick zincirini kurar) yeterlidir. Uzun süre "kuyrukta" kalan tarama için işçiyi yeniden başlatın; açılış toparlaması onu duraklatır veya sürdürür.

## 7. Kabul ölçütü ve kanıtı

**Ölçüt (docs/02 Faz 4):** Uygulama bir hafta açık kaldığında zamanlanmış taramalar çalışır; yeni açılanlar dashboard'da birikir.

**Kanıt: `tests/faz4-acceptance.test.ts`** (geçici veritabanı, demo sağlayıcı, enjekte edilen saat):

1. Temel Londra taraması 21 gün önce yapılır ve haftalık zamanlama o gün kurulur; uygulama iki hafta kapalı kalmıştır.
2. 8 günlük süre 5 dakikalık işçi tick'leriyle (1.500'den fazla açık tick) benzetilir; 6. ve 7. günler uygulama kapalıdır. Her gün bakım turu ve açılış izleme çalışır.
3. Denetlenenler:
   - **Zamanında çalışma ve telafi:** tam iki zamanlanmış çalışma olur — açılışta kaçırılan iki pencere **tek** çalışmada birleşir (`missedRuns: 2`), ikincisi kapalı geçen günden sonra açılışta; yüzlerce tick fazladan tarama doğurmaz. Slotlar, son sonuç ve sonraki çalışma zamanı beklenen değerlerdedir.
   - **Yeniler birikir (M2):** demo zamanı her çalışmada ilerler; her çalışmada yeni işletme bulunur, lead sayısı artar, açılan işletmeler oluşur.
   - **Gösterge paneli:** 1. haftanın son açık tick'inde ve 8. günde `getDashboard` çağrılır; "bu hafta yeni" ve "bu hafta açılan" sayaçları, liste toplamı ve liste uzunluğu veritabanından **bağımsız** bir sayımla birebir eşittir ve sıfırdan büyüktür; iki haftanın açılışlarının toplamı bütün açılışlara eşittir (kayıp veya çift sayım yok).
   - **Bildirimler tekildir:** tarama başına tek `scan.done`; yeniden tetikleme çoğaltmaz.
   - **Gün anahtarlı işler:** açılış izleme işi açık geçen her gün bir kez kurulur; `schedule.started` denetim kaydı iki tanedir.

**Sınır:** Bu benzetimdir; gerçek Google anahtarıyla ve gerçek saatle bir hafta açık kalan uygulamada denenmedi (Bölüm 10).

## 8. Kararlar ve yol haritasından sapmalar

- **Zamanlayıcı yalnızca uygulama açıkken çalışır.** İşletim sistemi düzeyinde zamanlayıcı (launchd/Görev Zamanlayıcı) eklenmedi; kaçırılanlar açılışta tek çalışmada telafi edilir. "Bilgisayar açılınca başlat" bunu destekler.
- **Arka plan maliyeti ön onaya bağlıdır;** onaysız arka plan çalışması hiçbir koşulda para harcamaz. Sağlayıcı değişikliği ön onayı geçersiz kılar.
- **Google koşulları için sabit "30 gün" varsayılmadı;** alan düzeyinde sınıf ve kaynak tutuldu. Türetilmiş bayraklar varsayılan olarak süresiz (en az 30 gün sınırıyla ayarlanabilir) ve **hukuki görüş bekliyor**.
- **Lead'ler kendiliğinden birleştirilmez** (yer kimliği çakışmasında karar kullanıcıda).
- **RDAP'ye yalnızca kayıt edilebilir alan adı** gider; tam adres, e-posta veya işletme adı gitmez.
- **Takip iletileri yeni kural getirmez:** Faz 3'ün 3 ileti / ≥ 5 gün / dinlenme kuralları aynen geçerlidir; takip yalnızca aynı konuşmada ve incelemedeki yanıtı bekleyerek gider.
- **Kişisel Gmail sınırları (50/gün, haftada +5) muhafazakâr ürün kurallarıdır;** gerçek teslim edilebilirlik müşteri hesabında gözlenmelidir.
- **"İletişime geçme" toplu kaldırılamaz;** arşiv geri alınabilir, "iletişime geçme" bilinçli olarak tek tek ve onayla kaldırılır.

## 9. Bilinen sınırlar ve açık kalanlar (kod)

- **Tek veritabanı bağlantısı:** işçi açılışında `recover()` artık bakım turundan önce çalışır; bakım turu yine de aynı süreçte açık bir işlem varken `TRANSACTION_ACTIVE` ile düşebilir ve 60 sn sonra (en çok 3 kez) yeniden denenir. Kalıcı çözüm bağlantı düzeyinde kuyruk/kilittir. Next sunucusunda bir `db.transaction` sürerken eşzamanlı istekler 503 `DB_BUSY` alabilir (mevcut tasarım).
- **TB-11(d):** gönderimi o anda süren (`in_flight`) dizi durdurulmaz; sonraki adımı yine adres engeline tabidir.
- **Son inceleme turunun bulguları kapandı:** eksik yardım balonları, her sayfada "?" kısayolu, İngilizcede tekil biçim ("1 business"), zamanlama uyarısının arayüz dilinde gösterilmesi ve gösterge paneli bağlantıları düzeltildi (testli). Son denetimin ertelenen izleme işleri için bkz. 6.1.
- Tarama duraklama nedeni metinleri (`COST_CAP` dahil) yalnızca Türkçe. Küçük harfli şablon denetim kodlarının İngilizce `apiError` metni yok (genel metin gösterilir).
- `notifications.os` kapalıyken birikmiş bildirimler sahiplenilmez; yeniden açılınca 24 saate kadar eski bildirimler görünebilir.
- Keşif'te "Yenilik" (puan) ile "Yenilikler" (yaşam döngüsü) süzgeç adları yan yana; biri yeniden adlandırılmalı.
- 900 px ve altında harita bölmesi açıkken "/" arama kutusuna odaklanamaz (liste bağlanmamış).

## 10. Entegrasyon bekleyenler

Bu liste **ihtiyacı ve nedenini** söyler; hangi hizmet veya ücretli seçenek kullanılacağı müşteri kararıdır. Girdilerin nereye girileceği: [`10-CANLIYA-GECIS.md`](10-CANLIYA-GECIS.md).

| Bekleyen | Neden gerekli | Ne doğrulanacak | Sahibi |
|---|---|---|---|
| Müşterinin Gmail hesabına erişim (gerçek OAuth bağlantısı) | Canlı gönderim ve takip iletilerinin aynı konuşmada kalması yalnızca sahte Gmail sunucusuyla sınandı | Gmail'in `threadId`, `In-Reply-To`/`References` ve "Re:" konusunu kabul edip iletileri tek konuşmada göstermesi; gönderim/okuma izinleri | Müşteri |
| Aktarıcı için sunucu (VPS) ve abonelikten çıkış alt alan adı için DNS kaydı | HTTPS tek tıklamalı çıkış uç noktası olmadan canlı gönderim yapılmaz (Faz 3 kuralı) | Aktarıcının dağıtımı, TLS, uçtan uca doğrulama kanıtı, düzenli çekme | Müşteri (barındırma ve DNS) |
| Google Cloud anahtarı ve faturalandırma | Gerçek Places çağrıları, `businessStatus` açılış izlemesi, ücretsiz "IDs Only" yer kimliği yenilemesi ve yeni SKU fiyatları yalnızca demo sağlayıcıyla sınandı | Gerçek tarama maliyeti tahmini ve ön onay, `NOT_FOUND` eşlemesi, kimlik değişimi; gerçek haritada işaretçi stilleri ve kamera | Müşteri |
| Koyu stilli **vektör Map ID** (aynı Google Cloud projesinde) | Gerçek koyu harita döşemeleri Map ID stiline bağlıdır; şu an yalnızca renk şeması değişiyor | Koyu temada harita ve şekil renkleri (adımlar docs/10 Bölüm 6.1) | Müşteri |
| Canlı RDAP denemesi | Gerçek kayıt şirketi sunucuları, hız sınırları ve yanıt biçimleri yalnızca sahte sunucu ve demo ile sınandı | Önyükleme dosyası, geri çekilme, birikimin erimesi | Geliştirici (gerçek ağ, anahtar gerekmez) |
| Türetilmiş bayrak saklama süresi için hukuki görüş | `google.derivedFlagsDays` varsayılanı süresiz; Google Maps Platform koşulları 12 Kasım 2026'da gözden geçirildi ama hukuken onaylanmadı | Süre kararı ve gerekirse varsayılanın değişmesi | Hukuk / müşteri |
| Microsoft 365 posta kutusu kararı | Yalnızca Gmail (Workspace ve kişisel) destekleniyor; Microsoft 365 gönderici istenirse yeni sağlayıcı bağdaştırıcısı gerekir | Gerek olup olmadığı | Müşteri |
| TB-11 (a) ve (b) sahip kararları | (a) işletmenin başka adresine yeniden temas için elle inceleme, (b) aynı alan adını paylaşan bağımsız şubeler için istisna; davranış kararıdır | Karar verilirse kural ve test | Sahip |
| Paketlenmiş, imzalı uygulamada OS bildirimleri | Bildirim izni, Windows `AppUserModelId`, oturum açılınca başlatma ve uykudan dönüş yalnızca geliştirme yapısında ve birim testleriyle sınandı | macOS ve Windows'ta bildirimin görünmesi, tıklayınca doğru ekranın açılması | Geliştirici + müşteri bilgisayarı |
| Ekran okuyucu testi | Erişilebilir adlar, canlı bölgeler ve balonlar kodla ve otomatik testlerle denetlendi; gerçek ekran okuyucuyla dinlenmedi | VoiceOver/NVDA ile Keşif, zil, gösterge paneli, zamanlamalar | Geliştirici |
| Tek veritabanı bağlantısı (`TRANSACTION_ACTIVE`) izlemesi | Açılıştaki bakım turu yeniden denemeyle toparlanıyor ama eşzamanlı sorgu yine reddedilebilir | Bağlantı düzeyinde kuyruk/kilit tasarımı | Geliştirici |

## 11. Uygulanan beceriler (Skills applied)

**backend-design**

- `think-before-coding` / `design`: zamanlayıcı tick'i, bildirim API'si, açılış izleme, yer kimliği yenileme ve RDAP işleri kodlanmadan önce altı adımla tasarlandı (değişmezler, CAS'lı slot, birleştirme, enjekte edilen `now`); entegrasyonda her çakışmanın iki tarafı okunup çözüldü; CI hatasının kök nedeni düzeltmeden önce ölçümle bulundu.
- `idempotency-and-side-effects`: slot başına tek çalışma (CAS + kısmi tekil indeks); tekilleştirme anahtarlı bildirimler; atomik `os-claim`; tek `mail.send` işi üreten, yalnızca öne çeken uyanma; toplu işlemlerde sabit değer yazan, SQL bekçili güncellemeler ve tam "Geri al" için `changedIds`; aynı değerli sınır güncellemesinin hiçbir şey yazmaması; durdurma çekirdeğinin tekrarında değişiklik olmaması; ek-yalnız tohum v2; yan etkiler (bildirim) işlem bittikten sonra.
- `error-handling-as-design`: kararlı `code` alanlı hata yanıtları ve istemcide yerelleştirme; tipli kapı ve atlama/duraklama kodları (`PREVIOUS_RUN_ACTIVE`, `SCAN_RETRYING`, `SCAN_BUDGET_STOPPED`, `SCAN_PAUSED`, `COST_CAP`); bölüm bölüm hata veren gösterge paneli; `TRANSACTION_ACTIVE`'in sınırlı yeniden denemeyle geçici sayılması; tavan üstü değerin kırpılmayıp açık kodla reddedilmesi.
- `query-discipline` / `hunt-n-plus-one`: gösterge panelinde sabit sayıda gruplanmış, sınırlı sorgu ve `0004` kısmi indeksleri; bekleyen koşulun LIMIT'ten önce SQL'e alınması (her tekrar ilerler); tek `UPDATE … RETURNING` sahiplenme; parçalı `IN` listeleri.
- `migration-safety` / `data-modeling-discipline`: `0004` yalnızca ekleyen, CHECK'leri şemada taşıyan migrasyon; plan → kod → yedek → bekçiler sırasıyla kayıplı-onaylı geri alma; 0003 geri almasının TB-10 verisiyle de anlam kaybetmeden çalışması.
- `security-discipline`: zod `.strict()` gövdeler; aynı-köken denetimi (os-claim için `Origin` testi); RDAP için güvenli istemci; denetim kayıtlarında ve günlüklerde adres yok; bildirimlerde Google içeriği yok; sağlayıcı değişince ön onayın geri alınması; uygulama içi yol doğrulaması.
- `observability-by-default`: `wake.failed`, `tick.rearm_failed`, `toast.failed`, `retry step=…` yapılandırılmış günlük satırları ve `/api/status` `schedules.stalled`; zamanlama ve RDAP denetim olayları, şikâyet/çıkış denetimlerinde sınırlı kimlik listeleri ve işletme alan adı, gösterge panelinde `Server-Timing`, işçi tick sonuç günlükleri.
- `testing-with-discernment`: gerçek rotalar ve geçici veritabanlarıyla senaryo testleri; bağımsız sayımla doğrulanan kabul testi; düzeltme testlerinin düzeltme olmadan düştüğünün doğrulanması; ekran görüntüsü yerine geometri ölçen e2e.
- `performance-and-scaling`: RDAP birikiminin devam çalışmalarıyla günlerden dakikalara inmesi.

**design**

- `ux-copy`: işletme sahibine sade Türkçe, her atlama/duraklama nedeninde "ne olacak / ne yapmalısınız"; onay düğmelerinin eylemi adlandırması ("Taslağı sil", "Zamanlamayı sil"); "Bunlardan: …" notu ile çakışan sayıların ek kişi gibi okunmaması; doğal İngilizce karşılıklar.
- `accessibility-review`: WCAG AA kontrast testleri (yeni `--caution-text` belirteci dahil), `aria-describedby` ile bağlı alan hataları, balonun canlı bölge dışında tutulması, satıra özgü erişilebilir adlar (zamanlama satırları bölge adını taşır), bütçe alanındaki etiket/kimlik çakışmasının düzeltilmesi, klavye ve Esc e2e senaryoları.
- `design-system`: sabit renkler yerine tema belirteçleri ve bunu koruyan tarama testi; ortak `EmptyState`/`HelpTip`; Tailwind kırılma noktalarıyla belgelenmiş üst çubuk genişlik planı.
- `design-critique`: Keşif'te yan yana duran "Yenilik" / "Yenilikler" ad çatışmasının ve gösterge paneli bağlantılarının açtığı kümenin sayaçla tutarsızlığının işaretlenmesi.

## 12. Çalıştırma ve ilgili belgeler

- Kalite kapıları: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:coverage`, `npm run build`, `npx playwright test`. Testler yalnızca geçici veri klasörü ve veritabanıyla çalışır.
- Demo modunda zamanlamalar ve açılış izleme ağa çıkmadan çalışır; demo zamanı her zamanlanmış çalışmada ilerler.
- İlgili belgeler: [Yol haritası](02-YOL-HARITASI.md), [Faz 3 notları](08-FAZ3-NOTLARI.md) (TB-1, TB-2, TB-10, TB-11 ayrıntısı), [Canlıya geçiş](10-CANLIYA-GECIS.md) (Bölüm 6: görünüm, dil ve masaüstü), [UI Rehberi](07-UI-REHBERI.md).
