# Universal Mail — Teslim Listesi

Bu belge, yazılımın müşteri şirkete teslim edildiği günün kontrol listesidir: teslim paketinde ne olduğu, kurulum
günü hangi sırayla ne yapılacağı, kısa eğitimin akışı, kaynak kod ve bakım dönemi kayıtları ve iki tarafın imza
listesi. Dayanak: [Anlaşma Notu](03-ANLASMA-NOTU.md) Bölüm 7–8 ve [Yol Haritası](02-YOL-HARITASI.md) Faz 6.

Her satırdaki ☐ teslim günü işaretlenir. Boş bırakılan alanlar (`……`) o gün doldurulur.

---

## 1. Teslim paketi

| # | Öğe | Nerede | ☐ |
| --- | --- | --- | --- |
| 1 | macOS kurulum dosyası `Universal-Mail-<sürüm>-mac-arm64.dmg` | GitHub Release sayfası (Assets) | ☐ |
| 2 | Windows kurulum dosyası `Universal-Mail-<sürüm>-win-x64.exe` | GitHub Release sayfası (Assets) | ☐ |
| 3 | Kurulum Rehberi | [docs/KURULUM.md](KURULUM.md) | ☐ |
| 4 | Kullanım Kılavuzu (ekran görüntülü, sorun giderme dahil) | [docs/KULLANIM.md](KULLANIM.md) | ☐ |
| 5 | Uyum kuralları özeti | [docs/UYUM.md](UYUM.md) | ☐ |
| 6 | Hesap ve anahtar hazırlığı (Google Cloud, Gmail OAuth) | [docs/04-FAZ0-KILAVUZU.md](04-FAZ0-KILAVUZU.md) | ☐ |
| 7 | Çıkış sunucusu kurulumu (Cloudflare Worker) | [deploy/cloudflare-worker/README.md](../deploy/cloudflare-worker/README.md) | ☐ |
| 8 | Canlıya geçiş adımları ve paylaşım kuralları | [docs/10-CANLIYA-GECIS.md](10-CANLIYA-GECIS.md) | ☐ |
| 9 | Anlaşma Notu (doldurulmuş ve imzalı) | [docs/03-ANLASMA-NOTU.md](03-ANLASMA-NOTU.md) | ☐ |

Teslim edilen sürüm: `v……` · Release bağlantısı: `……`

### 1.1 Teslimden önce (geliştirici)

- ☐ Ana daldaki son derlemenin bütün denetimleri (birim, uçtan uca, paketleme) yeşil.
- ☐ Sürüm etiketi (`v…`) itildi; GitHub Actions taslak Release'i oluşturdu; iki kurulum dosyası Assets'te; taslak
  **yayımlandı** (taslak Release'i müşteri göremez).
- ☐ Kurulum dosyaları temiz bir Mac'te ve temiz bir Windows'ta bir kez kuruldu, açıldı, demo taraması yapıldı.
- ☐ Arayüz değiştiyse kılavuz görüntüleri yeniden üretildi (`npm run build && npm run docs:shots`).
- ☐ Müşteriden beklenen hesaplar hazır: [Canlıya Geçiş](10-CANLIYA-GECIS.md) Bölüm 1 (şirket girdileri). Eksik olanlar
  bu listenin sonundaki "Açık kararlar" bölümüne yazıldı.

---

## 2. Kurulum günü (müşterinin bilgisayarında, müşterinin hesaplarıyla)

Bütün hesap girişlerini ve anahtar yapıştırmalarını **müşteri kendisi yapar**. Anahtarlar, parolalar ve OAuth sırları
sohbet, e-posta veya ekran görüntüsüyle paylaşılmaz ([Canlıya Geçiş](10-CANLIYA-GECIS.md) Bölüm 2).

| # | Adım | Rehber | ☐ |
| --- | --- | --- | --- |
| 1 | Kurulum dosyasını indir, kur, güvenlik uyarısını bir kez onayla | [KURULUM](KURULUM.md) Bölüm 2 / 3 | ☐ |
| 2 | Kurulum sihirbazı: onay (müşteri yetkilisinin adıyla), firma bilgileri, hedef pazarlar, bütçe | [KULLANIM](KULLANIM.md#11-kurulum-sihirbazı-ilk-açılış) 1.1 | ☐ |
| 3 | Google Places anahtarı → **Anahtarı test et** → "Anahtar çalışıyor"; isteğe bağlı Maps anahtarı | [KULLANIM](KULLANIM.md#31-google-bağlantısı-ve-bütçe) 3.1 | ☐ |
| 4 | **İlk tarama:** küçük bir alan, bir-iki kategori; maliyet ekranı okunur; sonuçlar liste ve haritada | [KULLANIM](KULLANIM.md#21-tarama-yeni-işletmeleri-bulun) 2.1 | ☐ |
| 5 | Birkaç işletmede **E-posta bul**; bulunan adres ve kaynağı gösterilir | [KULLANIM](KULLANIM.md#24-e-posta-bulma) 2.4 | ☐ |
| 6 | **Gmail bağlantısı:** kutu ekle, OAuth istemcisi, **Gmail'e bağlan (yalnızca gönderim)**; isteğe bağlı gelen kutusu okuma | [KULLANIM](KULLANIM.md#32-gönderim-hesabı-gmail) 3.2, [Faz 0](04-FAZ0-KILAVUZU.md) Adım 8 | ☐ |
| 7 | **Çıkış sunucusu:** Cloudflare Worker kurulur; uygulamada anahtarlar, adres, anahtar dosyası; **Doğrula** → "Uç nokta doğrulandı."; **Kuyruğu denetle**; **Talepleri düzenli çek** açık | [Cloudflare rehberi](../deploy/cloudflare-worker/README.md), [KULLANIM](KULLANIM.md#33-abonelikten-çıkış-altyapısı-çıkış-sunucusu) 3.3 | ☐ |
| 8 | Kendi alan adıyla (Workspace) gönderiliyorsa **Alan adı denetimi → Kontrol et** (SPF, DKIM, DMARC). Kişisel @gmail.com'da gerekmez | [KULLANIM](KULLANIM.md#27-kendinize-test-e-postası-gönderin) 2.7 | ☐ |
| 9 | **İlk test e-postası:** Günlük → Gönderim sağlığı → kendime test gönder (bağlı Gmail kutusundan, yalnızca kutunun kendi adresine). Müşterinin Gmail'inde açılır: firma bilgileri altta, "[TEST]" işareti, çıkış bağlantısı var | [KULLANIM](KULLANIM.md#27-kendinize-test-e-postası-gönderin) 2.7 | ☐ |
| 10 | **Yedek:** yedek parolası belirlenir ve müşterinin güvenli yerine yazılır; yedek klasörü harici disk/bulut klasörü; **Şimdi yedekle** | [KULLANIM](KULLANIM.md#4-yedek-alma-ve-geri-yükleme) 4 | ☐ |
| 11 | Ayarlar → Görünüm ve dil → **Bilgisayar açılınca başlat** (gönderim yapılacak bilgisayarda) | [KULLANIM](KULLANIM.md#35-diğer-ayarlar) 3.5 | ☐ |
| 12 | Gösterge paneli → **Kurulumu tamamlayın** kartı: tamamlanan maddeler kontrol edilir; kalanlar "Açık kararlar"a yazılır | [KULLANIM](KULLANIM.md#13-gösterge-paneli-ve-kurulumu-tamamlayın-kartı) 1.3 | ☐ |

**Gerçek kampanya gönderimi bu listede yoktur.** Kampanya gönderimi için hedef ülkenin canlı onayı (geliştiricinin,
müşteri kararıyla, kayıtlı bir işlemle yaptığı son adım) ve ilk hafta günde en çok 20 iletilik pilot gerekir:
[Canlıya Geçiş](10-CANLIYA-GECIS.md) Bölüm 3.3. Eksik adımları uygulamadaki **Günlük → Gönderim sağlığı → Canlı
gönderime hazırlık** kartı listeler.

---

## 3. Kısa eğitim (30–45 dakika)

Müşterinin kendi bilgisayarında, kendi verisiyle; müşteri tıklar, geliştirici anlatır.

| Süre | Konu | Göster | Müşteri kendisi yapar |
| --- | --- | --- | --- |
| 5 dk | Ekranın düzeni | Menüler, DEMO rozeti (yoksa gerçek veri), zil, bütçe göstergesi, Gösterge paneli | Bildirimleri açar |
| 8 dk | Tarama | Yeni tarama, maliyet ve onay, düzenli tekrar, Taramalar sayfası, duraklat/devam | Bir şehir taraması başlatır |
| 7 dk | Liste ve e-posta bulma | Süzgeçler, renkler, "Neden bu skor?", toplu **E-posta bul**, elle adres ekleme | 5–10 işletmede e-posta arar |
| 7 dk | Şablon ve kampanya | Şablon çoğaltma, canlı önizleme; kampanya sihirbazının 4 adımı; önizleme ve onay kutusu | Taslak kampanya kurar (başlatmaz) |
| 5 dk | Yanıtlar ve uyum | Günlük sekmeleri, İnceleme, yanıt gelince takiplerin durması, engel listesi, silme talepleri | Engel listesine bir adres ekler |
| 5 dk | Yedek ve veri | Otomatik yedek, geri yükleme adımları, saklama süresi, **Tüm verilerimi sil** (yalnızca anlatılır) | Bir yedek alır |
| 3–8 dk | Sorun giderme ve destek | Uyarı bantları, Yardım → Günlük klasörünü aç, desteğe ne gönderilir / ne gönderilmez | Günlük klasörünü bulur |

Eğitim sonunda müşteri şu soruları kendisi yanıtlayabilmeli: Bir tarama ne kadara mal olur? Bir kampanya neden bir
işletmeyi hariç tuttu? Biri listeden çıkmak isterse ne olur? Yedek parolası nerede?

---

## 4. Kaynak kod ve kullanım hakları

Anlaşma Notu Bölüm 7:

> "Yazılımın kaynak kodunun kimde kalacağı ve müşterinin kullanım hakları birlikte kararlaştırılacaktır."

Notta "Kaynak kod konusunda anlaşma" satırı **henüz doldurulmamıştır**.

**Durum: karar bekliyor.** Teslim günü aşağıdakiler iki tarafça yazılı olarak doldurulur ve Anlaşma Notu'na işlenir:

| Konu | Karar |
| --- | --- |
| Kaynak kodun kimde kalacağı (depo erişimi dahil) | …… |
| Müşterinin kullanım hakları (kaç bilgisayar, kopyalama, değiştirme) | …… |
| Müşteri adına açılmış hesapların (Google Cloud, Gmail, Cloudflare) sahipliği | Müşteri (Anlaşma Notu Bölüm 2) |
| Müşteri verisinin sahipliği | Müşteri; veri müşterinin bilgisayarında kalır, geliştiriciye gönderilmez (Bölüm 5) |

---

## 5. Bakım dönemi

| Alan | Değer |
| --- | --- |
| Teslim tarihi | …… (teslim günü yazılır) |
| **Bakım dönemi başlangıç tarihi** | …… (teslim günü yazılır) |
| Bakım süresi | …… (Anlaşma Notu Bölüm 7, "Teslim sonrası destek süresi"; karar bekliyor) |
| Destek kanalı | …… |

Anlaşma Notu'na göre bakım süresi içinde ortaya çıkan hatalar giderilir; yeni özellikler ve büyük değişiklikler
ayrıca konuşulur. Destek isteğinde müşteri yalnızca `app.log` ve gerekirse `migrate-result.json` dosyalarını paylaşır;
veritabanı, anahtarlar ve yedek parolası paylaşılmaz ([KULLANIM](KULLANIM.md#79-günlükler-nerede) 7.9).

---

## 6. Teslim ve onay

| # | Madde | Müşteri ☐ | Geliştirici ☐ |
| --- | --- | --- | --- |
| 1 | Kurulum dosyaları ve rehberler (Bölüm 1) teslim edildi | ☐ | ☐ |
| 2 | Uygulama müşterinin bilgisayarına kuruldu ve açılıyor | ☐ | ☐ |
| 3 | Müşteri hesabıyla ilk tarama yapıldı | ☐ | ☐ |
| 4 | Müşteri hesabıyla ilk test e-postası gönderildi ve alındı | ☐ | ☐ |
| 5 | Yedek parolası belirlendi, ilk yedek alındı, parola müşteride güvenli yerde | ☐ | ☐ |
| 6 | Kısa eğitim yapıldı | ☐ | ☐ |
| 7 | Kaynak kod kararı yazıldı (Bölüm 4) | ☐ | ☐ |
| 8 | Bakım dönemi başlangıç tarihi yazıldı (Bölüm 5) | ☐ | ☐ |
| 9 | Açık kararlar listesi (Bölüm 7) birlikte okundu | ☐ | ☐ |

**Tarih:** ……

**Müşteri şirket yetkilisi (ad, unvan, imza):** ……

**Geliştirici (ad, imza):** ……

---

## 7. Açık kararlar (teslim günü gözden geçirilir)

Aşağıdakiler yazılımda hazırdır ama müşterinin hesabını, parasını veya kararını gerektirir:

| Konu | Gereken | Kimin kararı |
| --- | --- | --- |
| Kaynak kod ve kullanım hakları | Bölüm 4 | İki taraf |
| Bakım süresi ve başlangıç tarihi | Bölüm 5 | İki taraf |
| Kod imzalama (uyarısız kurulum) | Apple Developer üyeliği ve/veya Windows kod imzalama sertifikası (ücretli). Olmadan uygulama çalışır, yalnızca ilk açılışta uyarı çıkar | Müşteri |
| Intel işlemcili Mac desteği | Gerekiyorsa ayrı bir kurulum dosyası üretilir | Müşteri |
| Gönderen hesap türü | Kişisel @gmail.com (düşük günlük sınır) veya Google Workspace + kendi alan adı (SPF/DKIM/DMARC) | Müşteri |
| Cloudflare hesabı | Çıkış sunucusu için ücretsiz Cloudflare hesabı müşteri adına açılır | Müşteri |
| Hedef ülkelerin canlı onayı ve pilot | [Canlıya Geçiş](10-CANLIYA-GECIS.md) Bölüm 3.3; sorumluluk gönderen şirkette | Müşteri |
| Uyum metninin hukuki gözden geçirmesi | [UYUM](UYUM.md) taslak durumdadır | Müşteri |
