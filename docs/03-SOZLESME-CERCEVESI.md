# Sözleşme Çerçevesi (avukat için taslak madde listesi)

> **Bu belge hukuki metin veya hukuki tavsiye değildir.** Geliştirici ile müşteri şirket arasındaki yazılım teslimi için sözleşmede yer alması düşünülen konuların kontrol listesidir. Bir yazılım/bilişim avukatına götürülüp resmi sözleşmeye dönüştürülmelidir. Vergi ve fatura konuları için muhasebeciye danışılmalıdır.

## Durum
- **Geliştirici:** yazılımı yazar ve teslim eder.
- **Müşteri şirket:** yazılımı satın alır, kendi bilgisayarında çalıştırır, yurt dışı dağıtım ağını büyütmek için hedef işletmelere B2B e-posta gönderir. Fatura müşteri şirkete kesilir.

## 1. Taraflar ve tanımlar
- Tarafların ticari unvanı, adresi, vergi numarası, yetkili imza sahipleri.
- Tanımlar: "Yazılım", "Müşteri Verisi", "Kampanya", "Alıcı", "Üçüncü Taraf Servisler" (Google, e-posta sağlayıcısı, şirket sicili API'leri).

## 2. Kapsam ve teslim
- Teslim edilecek işlevler: `docs/01-SRS.md` MVP kabul kriterleri (Bölüm 13) ekte referans.
- Faz bazlı teslim takvimi (`docs/02-YOL-HARITASI.md`) ve her faz sonunda onay.
- Kapsam dışı işler (örn. WhatsApp, çoklu kullanıcı, bulut sunucu) ve değişiklik talebi usulü.
- Kabul testi: müşterinin onay verme süresi ve itiraz usulü.

## 3. Ücret ve fatura
- Toplam bedel, faz bazlı ödeme planı, fatura kesilecek şirket, ödeme vadesi.
- Vergi durumu (KDV vb.) muhasebeci ile netleştirilir.
- Üçüncü taraf maliyetleri (Google API, Workspace, alan adı, e-posta bulucu servisler) **müşteriye aittir** ve bedele dahil değildir.

## 4. Fikri mülkiyet ve lisans
Karar verilecek: kaynak kod **devredilecek mi**, yoksa müşteriye **kullanım lisansı** mı verilecek?
- Seçenek A: Lisans (tek şirket, tek kurulum, devredilemez, kaynak kod geliştiricide). Güncellemeler ve yeniden satış hakkı geliştiricide kalır.
- Seçenek B: Devir (kaynak kod ve haklar müşteriye geçer). Geliştirici aynı kodu başkasına satamaz.
- Üçüncü taraf açık kaynak bileşenlerin lisansları ayrı kalır.

## 5. Kullanım amacı ve yasak kullanımlar
- Yazılım yalnızca **müşterinin kendi ürünlerinin B2B tanıtımı** için kullanılabilir.
- Yasak: bireylere (tüketicilere) gönderim, üçüncü taraf adına gönderim, liste satışı, yanıltıcı konu/gönderen bilgisi, uyum kurallarını (ülke politikası, çıkış bağlantısı, temas sınırları) devre dışı bırakma girişimi, uygulamanın kod seviyesinde değiştirilerek bu kuralların kaldırılması.
- Müşteri, ilk açılış kullanım onayını (SRS FR-SET-08) yetkili kişi olarak kabul eder.

## 6. Sorumluluk dağılımı
- E-postaların göndereni, içeriği ve alıcı seçimi **müşterinin** sorumluluğundadır; müşteri kişisel veri sorumlusudur.
- Müşteri, yazılımın kullanımından doğan üçüncü taraf talepleri (alıcı şikâyeti, düzenleyici kurum yaptırımı, Google ile uyuşmazlık) bakımından geliştiriciyi **tazmin eder** (kapsamı avukat belirler).
- Geliştiricinin sorumluluğu: yazılımın sözleşmedeki şekilde çalışması; toplam sorumluluk sınırı (örn. ödenen bedel) belirlenir.
- Dolaylı zararlar, kâr kaybı, itibar kaybı için sorumluluk sınırlaması.

## 7. Garanti reddi
Taahhüt edilmeyenler: bulunacak işletme/e-posta sayısı, e-postaların teslim edilebilirliği (spam klasörüne düşme dahil), yanıt oranı, satış veya distribütörlük sonucu, Google veya diğer servislerin kuralları/fiyatları değiştirmeyeceği, her ülkede mevzuat uyumunun garanti edilmesi.

## 8. Üçüncü taraf servisler
- Google Maps Platform şartları müşteri ile Google arasındadır; müşteri kendi hesabında kabul eder.
- Servisin fiyatı, kotası veya şartları değişirse yazılımı uyarlama yükümlülüğü yalnızca **bakım dönemi** boyunca ve makul çabayla geçerlidir.
- Google, e-posta sağlayıcısı veya başka bir servis müşterinin hesabını kısıtlarsa geliştirici sorumlu değildir.

## 9. Veri ve gizlilik
- Yazılım veri toplamaz, geliştiriciye göndermez (telemetri yok).
- Destek sırasında geliştirici veriye erişirse: yalnızca müşterinin yazılı izniyle, ekran paylaşımı yoluyla, kaydedilmeden.
- Geliştirici müşterinin ticari bilgilerini (hedef ülkeler, ürünler, lead sayıları) gizli tutar.
- Veri saklama süresi, silme talepleri ve yedekleme müşterinin sorumluluğundadır.

## 10. Bakım ve destek
- Ücretsiz hata düzeltme süresi (örn. teslimden itibaren 3 ay) ve kapsamı.
- Sonrası için opsiyonel aylık bakım bedeli: Google/API değişikliklerine uyum, güvenlik güncellemeleri.
- Yanıt süresi hedefi (iş günü), destek kanalı.

## 11. Süre ve fesih
- Sözleşme süresi, fesih koşulları, fesihte ödenmiş bedellerin durumu, lisansın sona ermesi (Seçenek A ise).

## 12. Uygulanacak hukuk ve uyuşmazlık
- Uygulanacak hukuk (Türk hukuku), yetkili mahkeme/tahkim.

---

## Ek: İlk açılış kullanım onayı (uygulama içi metin taslağı)

> **Kullanım Şartları Onayı**
>
> 1. Bu yazılımı yalnızca **şirketimin kendi ürünlerini işletmelere (B2B)** tanıtmak için kullanacağım.
> 2. Kişisel e-posta adreslerine ve bireylere gönderim yapmayacağım.
> 3. Gönderen olarak e-postaların içeriğinden, alıcı seçiminden ve ilgili ülkelerin mevzuatına uygunluktan şirketimin sorumlu olduğunu kabul ediyorum.
> 4. Yazılımın uyum ayarlarını (ülke politikası, çıkış bağlantısı, temas sınırları, engel listesi) devre dışı bırakmaya çalışmayacağım.
> 5. Alıcıların çıkış ve silme taleplerini derhal uygulayacağım.
> 6. Google Maps Platform ve e-posta sağlayıcımın kullanım şartlarını kendi hesabımda kabul ettiğimi biliyorum.
>
> Onaylayan ad-soyad: ______   Şirket: ______   Tarih: ______   [ ] Okudum, kabul ediyorum
