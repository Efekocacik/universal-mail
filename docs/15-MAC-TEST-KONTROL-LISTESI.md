# Efe'nin Mac'inde gerçek kurulum testi: kontrol listesi

Amaç: müşteriye teslim edilecek **aynı dosyayı** gerçek bir Mac'te, müşterinin yapacağı adımlarla denemek. CI başarısı
bu testin yerine geçmez (CI yalnızca derler ve paketlenmiş uygulamanın duman testini yapar; Gatekeeper, Anahtarlık,
gerçek Gmail ve gerçek Mac davranışını sınamaz). Özel test sürümü, geliştirici ayarı veya terminalden veritabanı
değişikliği KULLANILMAZ. Gerçek müşteri verisi kullanılmaz; yalnızca ekibin kendi test adresleri.

## 0. Ön koşullar (testten önce hazır olmalı)

- [ ] Test edilecek dosya, **taslak Release**'ten tarayıcıyla indirilmiş (docs/PAKETLEME.md "Teslimat süreci").
- [ ] Mac bilgileri kaydedildi: işlemci (Apple menüsü → Bu Mac Hakkında → Çip), macOS sürümü. İşlemci Apple Silicon
      değilse test başlamaz (paket yalnızca arm64).
- [ ] Temiz bir kullanıcı hesabı veya `~/Library/Application Support/Universal Mail` bulunmuyor.
- [ ] İmza durumu biliniyor: imzalı + notarize mi, imzasız mı (imza kararı test paketinden önce verilmiş olmalı).
- [ ] Test Gmail hesabı ve Google Cloud OAuth istemcisi (Masaüstü uygulaması; External + In production) hazır.
- [ ] Ekibe ait 2–3 **genel işletme adresi** (`info@`, `sales@`; gmail.com ve kişi adlı adresler uygun sayılmaz).
- [ ] Cloudflare Worker dağıtıldı ve çıkış adresi hazır (yalnızca kampanya testi için; kendime test için gerekmez).
- [ ] Ülke aktivasyonu yolu karara bağlandı (uygulama içi aktivasyon Efe onayını bekliyor; onaylanmadan canlı
      kampanya adımları yapılamaz).

## 1. Dosya ve kurulum

- [ ] İndirilen dosyanın SHA-256 değeri (`shasum -a 256 <dosya>`) Release'teki değerle aynı. Değer ve dosya adı kayda yazıldı.
- [ ] DMG: açılır, uygulama Uygulamalar'a sürüklenir. (ZIP alternatifi de ayrıca denenir: çift tıkla aç, sürükle.)
- [ ] İlk açılış: Gatekeeper davranışı kaydedildi (uyarı metni, "Yine de Aç" yolu çalışıyor mu; ekran görüntüsü).
      Güvenlik uyarısı gizlenmedi, `xattr` kullanılmadı.
- [ ] Anahtarlık izni istemi göründü mü; "Her Zaman İzin Ver" sonrası sorun yok.
- [ ] Uygulama pencere açıyor, Node/kaynak kod/terminal gerekmedi.

## 2. İlk kurulum ve veriler

- [ ] Kurulum sihirbazı: kullanım onayı, firma bilgileri tamamlandı.
- [ ] API anahtarı ve OAuth bilgileri yalnızca uygulama içinden girildi; bir daha gösterilmiyor.
- [ ] Uygulamayı kapat → yeniden aç: ayarlar, firma bilgileri ve gizli bilgiler korunuyor (ana anahtar çözülüyor).
- [ ] Mac'i uyut/uyandır, uygulamayı arka plana al: işlerin devam ettiği görülüyor.
- [ ] Veri klasörü (`~/Library/Application Support/Universal Mail`) dışında müşteri/anahtar dosyası paket içinde yok.

## 3. Google ve işletme listesi (isteğe bağlı kaynak)

- [ ] Places anahtarı "Anahtarı test et" başarılı; küçük bir tarama (kota/bütçe düşük) liste ve haritada görünüyor.

## 4. Gmail ve test gönderimleri

- [ ] **Test modu önce:** Ayarlar → Test modu açık ve izinli adresler yazıldı; üstte test modu bandı görünüyor.
- [ ] Gmail OAuth: tarayıcıda Google izni verildi; kutu "bağlı".
- [ ] "Kendime test gönder": onay penceresi → ileti **yalnızca kutunun kendi adresine** geldi (gelen kutusunda görüldü).
- [ ] Test modu açıkken izinsiz bir alıcıya kampanya iletisi gitmiyor (bekletilir).
- [ ] Gevşetme (adres ekleme/kapatma) onay istiyor ve çalışan kampanyayı duraklatıyor.

## 5. Canlı kampanya (ülke aktivasyonu ve çıkış uç noktası hazırsa)

- [ ] Hazırlık ekranı: Gmail, DNS, çıkış uç noktası ve çekme işi "tamam".
- [ ] Ülke kilidi açık olmadan hiçbir iletinin gitmediği doğrulandı (varsayılan davranış).
- [ ] Ülke aktivasyonundan sonra yalnızca izinli test alıcılarına kampanya gönderimi; ileti gönderim penceresinde,
      sınırların içinde gidiyor.
- [ ] İletideki çıkış bağlantısı HTTPS Worker adresine gidiyor; tıklanınca alıcı suppression'a giriyor ve uygulamaya iniyor.
- [ ] Yanıt/gelen kutusu (okuma izni verildiyse): yanıt takibi çalışıyor; otomatik suppression kapalı (başlık güveni kapalı).

## 6. Dayanıklılık

- [ ] Yedek al / geri yükle çalışıyor.
- [ ] Uygulamayı yeniden başlat: veriler ve bağlı Gmail durumu korunuyor.
- [ ] Hata durumları: Gmail yetkisi kaldırılınca "Yeniden bağlanmalı" uyarısı ve ertelenen gönderim.

## 7. Test kaydı (her çalıştırmada doldurulur)

Tarih, test eden, Mac çipi ve macOS sürümü, dosya adı ve SHA-256, imza durumu, geçen/kalan maddeler, ekran
görüntüleri (gizli alan ve tam alıcı adresi olmadan). Tek bir madde bile kalıyorsa dosya müşteriye verilmez.
