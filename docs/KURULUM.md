# Universal Mail — Kurulum Rehberi

Bu rehber Universal Mail'in bir Mac'e veya Windows bilgisayara **sıfırdan** kurulmasını, güncellenmesini ve
kaldırılmasını anlatır. Teknik bilgi, Node.js veya terminal gerekmez. Hedef: kurulum dosyasını indirmekten ilk taramaya
kadar **30 dakika** ([kontrol listesi](#7-30-dakikalık-kurulum-kontrol-listesi)).

Kurulumdan sonraki kullanım için: [Kullanım Kılavuzu](KULLANIM.md).

## İçindekiler

- [1. Başlamadan önce](#1-başlamadan-önce)
- [2. macOS'e kurulum](#2-macose-kurulum)
- [3. Windows'a kurulum](#3-windowsa-kurulum)
- [4. Uygulamanın ilk açılışı](#4-uygulamanın-ilk-açılışı)
- [5. Güncelleme](#5-güncelleme)
- [6. Kaldırma](#6-kaldırma)
- [7. 30 dakikalık kurulum kontrol listesi](#7-30-dakikalık-kurulum-kontrol-listesi)

---

## 1. Başlamadan önce

**Bilgisayar:**

| | macOS | Windows |
| --- | --- | --- |
| Sürüm | Apple Silicon (M1, M2, M3, M4…) işlemcili Mac, güncel macOS | Windows 10 veya 11, 64 bit |
| Disk | En az 1 GB boş yer (veriler büyüdükçe artar) | En az 1 GB boş yer |
| Yetki | Normal kullanıcı yeterli | Normal kullanıcı yeterli (yönetici parolası istenmez) |

Intel işlemcili Mac'ler için şu an kurulum dosyası üretilmiyor. Mac'inizin işlemcisini **Apple menüsü → Bu Mac
Hakkında** penceresinde "Çip: Apple M…" satırından görebilirsiniz.

**Kurulum dosyası:** Size verilen **GitHub Release** bağlantısını açın. Sayfanın altındaki **Assets** (Dosyalar)
bölümünde iki dosya vardır:

| Dosya | Bilgisayar |
| --- | --- |
| `Universal-Mail-<sürüm>-mac-arm64.dmg` | Mac |
| `Universal-Mail-<sürüm>-win-x64.exe` | Windows |

Kendi bilgisayarınıza uygun dosyaya tıklayıp indirin. Dosyayı yalnızca size verilen bağlantıdan indirin; başkasının
gönderdiği bir kopyayı kurmayın.

**Gerçek kullanım için hazır olsun (demo için gerekmez):**

- Şirketin Google Cloud hesabından alınmış **Places API anahtarı** (ve isteğe bağlı Maps JavaScript API anahtarı)
- Gönderim yapılacak **Gmail adresi** ve Google Cloud'da oluşturulmuş **OAuth istemci kimliği ve sırrı**
- Şirketin ticari unvanı, adresi, vergi/sicil numarası, telefonu ve ihracat sorumlusunun adı

Bunların nasıl hazırlanacağı: [Faz 0 Kılavuzu](04-FAZ0-KILAVUZU.md). Anahtarlar hazır değilse kurulumu **Demo
modu** ile tamamlayıp anahtarları sonra Ayarlar'dan girebilirsiniz.

> **İşletim sistemi uyarıları hakkında:** Uygulama şu an dijital imza (Apple / Microsoft sertifikası) taşımıyor. Bu
> yüzden ilk açılışta macOS ve Windows "bu uygulamayı tanımıyorum" türünden bir uyarı gösterir. Bu beklenen bir
> durumdur; aşağıdaki numaralı adımlarla bir kez onaylarsınız, sonraki açılışlarda uyarı çıkmaz. Uyarı pencerelerinin
> görünümü işletim sistemi sürümüne göre biraz değişebilir; düğme adları aşağıda yazıldığı gibidir.

---

## 2. macOS'e kurulum

### 2.1 Dosyayı açın

1. İndirilenler klasöründeki `Universal-Mail-<sürüm>-mac-arm64.dmg` dosyasına çift tıklayın.
2. Açılan pencerede **Universal Mail** simgesini yanındaki **Applications (Uygulamalar)** klasörüne sürükleyin.
3. Kopyalama bitince pencereyi kapatın. Masaüstünde veya Finder'ın kenar çubuğunda "Universal Mail" diski görünüyorsa
   yanındaki **⏏** (çıkar) simgesine basın.

### 2.2 Uygulamayı ilk kez açın

1. **Finder → Uygulamalar** klasörünü açın.
2. **Universal Mail**'e **sağ tıklayın** (veya Control tuşuna basılı tutarak tıklayın) ve menüden **Aç**'ı seçin.
3. Çıkan uyarıda **Aç** düğmesi varsa basın. Uygulama açılır; 2.3'ü atlayabilirsiniz.

### 2.3 Açılış güvenlik uyarısı

Yeni macOS sürümlerinde uyarı penceresinde **Aç** düğmesi bulunmaz, yalnızca **Bitti** veya **Çöp Sepeti'ne Taşı**
vardır. Bu durumda:

1. Uyarıda **Bitti**'ye basın (**Çöp Sepeti'ne Taşı**'ya basmayın).
2. **Apple menüsü → Sistem Ayarları**'nı açın.
3. Sol listeden **Gizlilik ve Güvenlik**'i seçin.
4. Sağ tarafta aşağı, **Güvenlik** bölümüne inin. "Universal Mail, tanınmış bir geliştiriciden olmadığı için engellendi"
   yazısının yanındaki **Yine de Aç** düğmesine basın.
5. Mac giriş parolanızı (veya Touch ID) isterse girin.
6. Uygulamayı yeniden açın (Uygulamalar → Universal Mail). Çıkan son uyarıda **Yine de Aç**'a basın.

Bu onay bir kez verilir. Sonraki açılışlarda Universal Mail doğrudan açılır.

### 2.4 Anahtarlık izni

İlk açılışta (veya ilk anahtar kaydında) macOS, **"Universal Mail Safe Storage"** anahtarlık öğesine erişim izni
isteyebilir. Mac giriş parolanızı yazıp **Her Zaman İzin Ver**'i seçin. Uygulama API anahtarlarınızı ve Gmail
bağlantınızı bu kayıtla şifreler.

### 2.5 Kolay erişim

Uygulama açıkken Dock'taki simgesine sağ tıklayıp **Seçenekler → Dock'ta Tut**'u seçin. Kampanyalar ve çıkış talepleri
yalnızca uygulama açıkken işlendiği için Ayarlar → Görünüm ve dil → **Bilgisayar açılınca başlat**'ı da açabilirsiniz.

---

## 3. Windows'a kurulum

### 3.1 Kurulum dosyasını çalıştırın

1. İndirilenler klasöründeki `Universal-Mail-<sürüm>-win-x64.exe` dosyasına çift tıklayın.
2. SmartScreen uyarısı çıkarsa 3.3'teki adımları izleyin, sonra buraya dönün.

### 3.2 Kurulum sihirbazı

1. Dil Türkçe seçili gelir. **Tamam** veya **İleri**'ye basın.
2. Kurulum yeri olarak önerilen klasörü değiştirmeden **Yükle**'ye basın. (Yönetici parolası istenmez; uygulama
   yalnızca sizin kullanıcı hesabınıza kurulur.)
3. Kurulum bitince **Universal Mail'i çalıştır** işaretliyken **Son**'a basın. Uygulama açılır.

Masaüstünde ve Başlat menüsünde **Universal Mail** kısayolu oluşur.

### 3.3 SmartScreen uyarısı

İlk çalıştırmada mavi bir **"Windows kişisel bilgisayarınızı korudu"** penceresi çıkabilir:

1. Penceredeki **Ek bilgi** bağlantısına tıklayın.
2. Altta beliren **Yine de çalıştır** düğmesine basın.
3. "Bu uygulamanın cihazınızda değişiklik yapmasına izin vermek istiyor musunuz?" sorusu çıkarsa **Evet**'e basın.

Virüs programınız dosyayı engellerse, dosyanın size verilen GitHub Release bağlantısından indirildiğinden emin olun ve
virüs programında dosyaya izin verin.

### 3.4 Windows güvenlik duvarı

Uygulama yalnızca kendi bilgisayarınız içinde (`127.0.0.1`) çalışan bir iç sunucu kullanır. Windows Güvenlik Duvarı
bir izin sorarsa **İptal**'i veya yalnızca **Özel ağlar**'ı seçebilirsiniz; uygulamanın çalışması için ağ izni
gerekmez.

---

## 4. Uygulamanın ilk açılışı

Uygulama ilk açıldığında kurulum sihirbazı başlar. Adımlar ve ekran görüntüleri
[Kullanım Kılavuzu → Kurulum sihirbazı](KULLANIM.md#11-kurulum-sihirbazı-ilk-açılış) bölümündedir. Özetle:

1. **Onay:** kullanım şartlarını kabul edin.
2. **Firma:** gönderen firma bilgilerini girin.
3. **Pazarlar:** hedef ülkeleri seçin.
4. **Google:** gerçek kullanım için Places API anahtarını yapıştırıp **Anahtarı test et**; anahtar yoksa **Demo
   modu**.
5. **Bütçe:** aylık Google bütçesini girin.
6. **Başla:** **Kurulumu tamamla**.

Ardından **Gösterge paneli → Kurulumu tamamlayın** kartı kalan adımları (ilk tarama, Gmail bağlantısı, test e-postası,
çıkış sunucusu, yedek parolası) sırayla gösterir.

Verileriniz şu klasörde tutulur (uygulamada **Yardım → Veri klasörünü aç**):

| Sistem | Veri klasörü |
| --- | --- |
| macOS | `~/Library/Application Support/Universal Mail` |
| Windows | `%APPDATA%\Universal Mail` |

---

## 5. Güncelleme

Yeni sürüm, eskisinin **üzerine kurulur**; verileriniz, ayarlarınız, anahtarlarınız ve Gmail bağlantınız korunur.

1. Güncellemeden önce **Ayarlar → Yedekler → Şimdi yedekle** ile bir yedek alın (önerilir).
2. Universal Mail'i kapatın. Mac'te menüden **Universal Mail → Çık** (veya ⌘Q); Windows'ta pencereyi kapatın.
3. Yeni sürümün kurulum dosyasını aynı GitHub Release sayfasından indirin.
4. Kurun:
   - **macOS:** `.dmg` dosyasını açıp **Universal Mail**'i **Applications** klasörüne sürükleyin. "Aynı adlı öğe var"
     sorusunda **Değiştir**'i seçin.
   - **Windows:** `.exe` dosyasını çalıştırıp kurulum adımlarını izleyin. Eski sürüm kendiliğinden değiştirilir;
     verilerin silinmesi **sorulmaz**.
5. Uygulamayı açın. İlk açılışta (gerekirse) güvenlik uyarısını [2.3](#23-açılış-güvenlik-uyarısı) veya
   [3.3](#33-smartscreen-uyarısı)'teki gibi bir kez daha onaylayın; anahtarlık izni sorulursa **Her Zaman İzin Ver**.

Yeni sürüm veritabanını güncellemesi gerekiyorsa bunu açılışta kendiliğinden yapar ve öncesinde otomatik bir yedek
alır. Bir sorun olursa **"Veritabanı güncellenemedi"** penceresi çıkar: önce **Yeniden dene**; olmazsa **Güncelleme
öncesi yedeğe dön** (hiçbir dosya silinmez) ve destekle iletişime geçin. Ayrıntı:
[Kullanım Kılavuzu → Sorun giderme](KULLANIM.md#71-uygulama-açılmıyor-macos).

---

## 6. Kaldırma

### 6.1 Windows

1. **Başlat → Ayarlar → Uygulamalar → Yüklü uygulamalar**'ı açın.
2. **Universal Mail**'i bulun, yanındaki **⋯** menüsünden **Kaldır**'ı seçin ve onaylayın.
3. Kaldırıcı **"Verilerinizi de silmek istiyor musunuz?"** diye sorar:
   - **Hayır** (varsayılan): uygulama kaldırılır, verileriniz `%APPDATA%\Universal Mail` klasöründe kalır. Uygulamayı
     yeniden kurarsanız her şey kaldığı yerden devam eder.
   - **Evet**: bu klasör de silinir (işletme listesi, kampanyalar, ayarlar, anahtarlar ve bu klasördeki yedekler). Geri
     alınamaz. Başka bir klasöre (ör. harici diske) aldığınız yedeklere dokunulmaz.

### 6.2 macOS

**Verilerle birlikte kaldırmak için** (bilgisayarı devrederken önerilir):

1. Uygulamada **Ayarlar → Yedekler → Tüm verilerimi sil** ile verileri silin (ayrıntı:
   [Kullanım Kılavuzu → Tüm verilerimi sil](KULLANIM.md#52-tüm-verilerimi-sil)) ve uygulamayı kapatıp açarak silmeyi
   tamamlayın.
2. Uygulamadan çıkın (**⌘Q**).
3. **Finder → Uygulamalar**'da **Universal Mail**'i Çöp Sepeti'ne sürükleyin ve Çöp Sepeti'ni boşaltın.
4. İsteğe bağlı: **Anahtar Zinciri Erişimi** uygulamasını açın, "Universal Mail Safe Storage" kaydını arayıp silin.

**Verileri saklayarak kaldırmak için:** yalnızca 2. ve 3. adımı yapın. Veriler
`~/Library/Application Support/Universal Mail` klasöründe kalır; yeniden kurarsanız kaldığı yerden devam eder.

---

## 7. 30 dakikalık kurulum kontrol listesi

Temiz bir bilgisayarda, anahtarlar önceden hazırsa:

| Süre | Adım | Tamam |
| --- | --- | --- |
| 0–5 dk | GitHub Release sayfasından doğru dosyayı indir (Mac: `mac-arm64.dmg`, Windows: `win-x64.exe`) | ☐ |
| 5–10 dk | Kur ([2](#2-macose-kurulum) / [3](#3-windowsa-kurulum)); güvenlik uyarısını bir kez onayla; anahtarlık iznini ver | ☐ |
| 10–15 dk | Kurulum sihirbazı: onay, firma bilgileri, hedef pazarlar, Google anahtarı (**Anahtarı test et** → "Anahtar çalışıyor"), bütçe | ☐ |
| 15–20 dk | İlk tarama: Keşif → Yeni tarama → bir şehir, bir-iki kategori → maliyet "ücretsiz kota içinde" → **Taramayı başlat** | ☐ |
| 20–25 dk | Tarama bitince listede ve haritada işletmeler görünüyor; birkaç işletmede **E-posta bul** | ☐ |
| 25–30 dk | **Ayarlar → Yedekler**: yedek parolası belirle, **Şimdi yedekle**; parolayı güvenli yere yaz | ☐ |

Gmail bağlantısı, çıkış sunucusu (Cloudflare Worker) ve ilk test e-postası ayrı bir oturumda yapılabilir; adımları
[Kullanım Kılavuzu → Ayarlar](KULLANIM.md#3-ayarlar) ve [Teslim Listesi](TESLIM.md)'nde.

Takılırsanız: [Kullanım Kılavuzu → Sorun giderme](KULLANIM.md#7-sorun-giderme).
