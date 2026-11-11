# Uyum Kuralları — Kullanıcı İçin Sade Özet

> **Durum: TASLAK — hukuki onay bekliyor.** Bu belge, uygulamanın **fiilen uyguladığı** teknik kuralları sade bir dille anlatır. Hukuki görüş, yasal uygunluk beyanı veya danışmanlık **değildir**; hiçbir teknik kontrol tüm hukuki riskleri ortadan kaldırmaz. Hukuki değerlendirme `docs/LIA.md` ile birlikte yapılacak ve onaylanana kadar bu belge "onaylandı" sayılmaz (kayıt: `src/lib/compliance/legal-status.ts`).
>
> **Gerçek e-posta gönderimi ve gerçek gelen kutusu okuma bu sürümde kapalıdır.** İkisi de yalnızca yazılı hukuki onaylar ve gerçek ortam doğrulamaları tamamlandıktan sonra, ayrı ve kayıtlı bir yazılım sürümüyle açılabilir (bkz. `docs/09-FAZ3-CANLI-DOGRULAMA.md`). Aşağıdaki kuralların kodu hem demo hem (kapalı) canlı yol için uygulanır; **gerçek bir hesap, alan adı veya alıcıyla henüz doğrulanmamıştır.**

## 1. Gönderim kimin adına, hangi koşulla yapılır?

- Kullanım onayı verilmeden ve **gönderen firma profili** (ticari unvan, adres, vergi/sicil numarası, telefon, iletişim kişisi) tamamlanmadan kampanya başlatılamaz.
- Her ileti, gönderen bilgilerini ve iletişimden çıkma bağlantısını **otomatik ekler**; şablondan silinse bile gönderim sırasında eklenir.
- Kampanya, siz **Başlat** demeden gönderim yapmaz. Başlatmadan önce tahmini ileti sayısı, zaman aralığı ve örnek önizlemeler gösterilir.
- Gerçek gönderim, tek bir ayara bağlı değildir: yazılımdaki gönderim anahtarı **ve** kayıtlı hukuki/operasyonel onayların **hepsi** birlikte verilmeden hiçbir gerçek ileti gönderilmez; ayrıca çalışan ve doğrulanmış bir çıkış bağlantısı olmayan ileti gönderilmez.

## 2. Kime yazılmaz?

Uygulama aşağıdaki kayıtları **gönderim dışında bırakır** ve nedenini gösterir:

- **Engel listesindeki** adresler ve alan adları.
- Ülke politikası **engelli** olan ülkeler. Gerçek (canlı) politikaların tamamı şu an **engelli ve kilitlidir**; kilit yalnızca yazılı hukuki onaydan sonra yeni bir yazılım sürümüyle açılır. Demo politikalarını yalnızca **sıkılaştırabilirsiniz**, gevşetemezsiniz.
- Kişisel posta sağlayıcıları (gmail.com, hotmail.com, outlook.com vb.) — otomatik kampanyalara alınmaz.
- Doğrulanmamış veya geçersiz adresler; yanıt vermiş, çıkış istemiş veya kalıcı teslim hatası almış adresler.

## 3. Temas sıklığı ("rahatsız etmeme" kuralları)

Bu sınırlar kampanya ayarlarından bağımsız, **her gönderimden hemen önce** uygulanır ve yalnızca sıkılaştırılabilir:

| Kural | Değer |
|---|---|
| Bir adrese tek dizide en çok ileti | 3 (ilk e-posta + en çok 2 takip) |
| Takipler arası en az süre | 5 gün |
| Yanıt gelmeden biten dizi sonrası dinlenme | 180 gün |
| Aynı adresin farklı kampanyalarda yeniden kullanımı | son temastan en az 30 gün sonra |
| Aynı alan adına | aynı gün en çok 1 ileti |
| Bir yanıt geldiğinde | otomatik takipler durur |

## 4. Gönderim hızı ve saati

- Posta kutusu başına günlük başlangıç sınırı **20**, üst sınır **80** ileti; ısınma kademeli ilerler.
- İletiler arasında **90–240 saniye** bekleme.
- Gönderim, **alıcının yerel saatine göre hafta içi 09.00–17.00** arasında yapılır.
- Bu sınırlar spam filtrelerini atlatmak için değil, kontrollü gönderim içindir.

## 5. İletişimden çıkma, itiraz ve engel listesi

- Çıkış talebi, itiraz veya şikâyet gelen adrese yeni ticari ileti **gönderilmez**. Bu kayıtlar sıradan işlemle kaldırılamaz.
- **Çıkış talebi ve şikâyet ayrı nedenlerdir.** Engel listesinde, işlem kaydında ve gelen ileti günlüğünde ayrı etiketlerle görünür ("Çıkış talebi" / "Şikâyet"); şikâyet geldiğinde o adresin tüm bekleyen takip dizileri durur ve kuyrukta "Şikâyet nedeniyle durduruldu" olarak gösterilir. Bu ayrım bazı toplu sayaçlara henüz yansımaz (bilinen eksik; bkz. `docs/08-FAZ3-NOTLARI.md` Bölüm 6).
- Elle kaldırma (yanlış girilen kayıtlar için) açık onay ve **en az 10 karakterlik gerekçe** ister; her kaldırma denetim kaydına yazılır.
- Gerçek iletide çıkış bağlantısı kişiye özel, imzalı ve süreli (varsayılan 180 gün) bir **HTTPS** bağlantıdır; bağlantıyı yalnızca açmak veya önizlemek çıkış yaptırmaz, onay düğmesi gerekir. Bağlantı, ancak çalıştığı uçtan uca doğrulanmış bir çıkış uç noktası varsa iletiye konur ve ancak o zaman tek tıklamalı çıkış başlığı (`List-Unsubscribe-Post`) eklenir.
- **Bu sürümde** böyle bir uç nokta kurulmadı ve gerçek posta istemcileriyle denenmedi; yerel demo bağlantısı alıcıların ulaşabileceği bir hizmet değildir. Bu, gerçek gönderimin kapalı olmasının nedenlerinden biridir.

## 6. Gelen iletiler (yanıt, teslim hatası)

- Bir iletinin "teslim hatası", "yanıt", "çıkış isteği" veya "şikâyet raporu" sayılıp otomatik işlem yapması için **birden fazla kanıt** gerekir: bizim gönderdiğimiz iletiyle eşleşme, doğru alıcı, gönderenin güvenilir kanal doğrulaması ve güvenlik sınırları. Eksik kanıtlı ileti **hiçbir şeyi değiştirmez**, "İnceleme" kuyruğuna düşer.
- **Gelen kutusu okuma ayrı bir izindir** ve varsayılan olarak verilmez; gönderim izni okuma izni yerine geçmez. Okunduğunda yalnızca bizim gönderdiğimiz iletilerle ilişkili iletiler işlenir; ilgisiz kişisel posta saklanmaz.
- **Şikâyet raporları** (ARF) yalnızca önceden güvenilir ilan edilmiş geri bildirim sağlayıcılarından, kimlikleri doğrulanmış ve bizim gönderdiğimiz ileti ve alıcıyla eşleşiyorsa şikâyet sayılır; aksi halde yalnızca incelemeye düşer. Güvenilir sağlayıcı listesi başlangıçta boştur.
- Gmail'den okunan iletilerde gönderen doğrulaması, gerçek hesapla doğrulanana kadar kapalı tutulur: bu iletiler **yalnızca inceleme kuyruğuna** düşer, otomatik işlem yapılmaz.
- Olumsuz veya belirsiz yanıtlar **asla otomatik engel üretmez**; karar sizindir.
- Bu sürümdeki kanal doğrulaması **demo simülasyonudur**; gerçek sağlayıcı doğrulaması değildir.

## 7. Otomatik durdurma

- **Kampanya düzeyi:** bir kampanyada en az 20 alıcı, en az 2 doğrulanmış teslim hatası ve %5 oran → kampanya duraklatılır.
- **Posta kutusu düzeyi:** son 30 günde doğrulanmış kalıcı teslim hatası oranı **%3'ü aşarsa** kutudan gönderim durdurulur. Örnek sayısı 50'den azsa istatistiksel olarak yetersiz sayılır, ancak 3 doğrulanmış hata yine de gönderimi durdurur.
- Şikâyet oranı (%0,1) bu sürümde **ölçülemez** ve "temiz" diye gösterilmez: şikâyet raporlarını yalnızca bazı sağlayıcılar gönderir ve çoğu şikâyet hiç bildirilmez. Gösterilen "doğrulanmış şikâyet" sayısı bir **alt sınırdır** (kısmi kapsam), oran değildir ve otomatik durdurma kararına girmez.
- Eşikler yalnızca sıkılaştırılabilir. Durdurmayı kaldırmak açık onay ve gerekçe ister ve oran hâlâ eşiğin üzerindeyse reddedilir.

## 8. Kişisel verilerinizin silinmesi (silme talebi)

Bir kişi silme talep ederse **Uyum → Silme talepleri** ekranından:

1. Önce yalnızca **sayılar** gösterilir (adres yankılanmaz).
2. Onayladığınızda adrese ait kayıtlar temizlenir; kişi iletişim listesinden kalıcı olarak çıkarılır. **Bu işlem geri alınamaz.**
3. **Hukuki değerlendirme bekleyenler:** gerçek bir posta kutusundan fiilen iletilmiş iletilerin kayıtları yasal saklama yükümlülükleriyle çakışabilir; bu kayıtlar hukuki değerlendirme tamamlanana kadar **silinmez** ve ekranda "bekliyor" olarak gösterilir. "Saklama yükümlülüğüm yok" beyanı bu değerlendirmenin yerine geçmez.
4. Yeniden iletişimi önlemek için e-posta **özeti** ve alan adı engel listesinde saklanır. Özetin her durumda anonim olmadığı bilinir; bu saklamanın hukuki dayanağı **onay bekliyor**.
5. **Yedekler:** şema güncellemesi öncesi alınan (en çok 5) yedek dosyaları eski veriyi taşıyabilir; bu işlem onları değiştirmez.
6. 72 saatlik süre yalnızca **operasyonel bir hedeftir**; yasal yanıt sürelerinin yerine geçmez.

## 9. Dışa aktarma ve kayıtlar

- Gönderim günlüğü ve işlem kaydı dışa aktarmalarında adresler **yalnızca maskeli** yer alır; tam adres dışa aktarımı yoktur.
- Silinmiş kayıtlarda adres, konu ve hata metni boştur.
- Uygulama kullanım telemetrisi toplamaz; veriler bu bilgisayarda tutulur.

## 10. Bu belgenin sınırları

- Ülkelerin mevzuatı farklıdır ve değişir. Bu belge hiçbir ülke için "gönderim serbesttir" demez.
- Gönderen olarak mevzuata uyumdan **sorumlu olan müşteri şirkettir**; uygulama bunu kolaylaştıran teknik kontroller sağlar (bkz. SRS 8.5).
- Onay bekleyen maddelerin güncel listesi için **Günlük → Gönderim sağlığı → Canlı gönderime hazırlık** ekranına bakın.
