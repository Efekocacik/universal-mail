# Meşru Menfaat Değerlendirmesi (LIA) — İSKELET

> **Durum: DOLDURULMADI — şirket ve hukuk tarafından tamamlanıp onaylanmadı.** Bu dosya yalnızca yapıyı sunar. `[DOLDURULACAK]` işaretli hiçbir alan varsayımla doldurulmamıştır ve bu belge tamamlanana kadar canlı gönderim için **dayanak sayılamaz** (kayıt: `src/lib/compliance/legal-status.ts` → `lia: false`). Hukuki görüş değildir.
>
> SRS 8.4: Meşru menfaatin kullanılacağı durumlarda gerekli değerlendirme yapılır ve LIA kaydı `docs/` klasöründe tutulur.

## 1. Kimlikler

| Alan | Değer |
|---|---|
| Gönderen / veri sorumlusu (ticari unvan) | `[DOLDURULACAK]` |
| Adres, vergi/sicil numarası | `[DOLDURULACAK]` |
| Veri koruma sorumlusu veya iletişim kişisi | `[DOLDURULACAK]` |
| Değerlendirmeyi yapan / onaylayan | `[DOLDURULACAK]` |
| Tarih ve sürüm | `[DOLDURULACAK]` |

## 2. Amaç testi

- İşlemenin amacı nedir? `[DOLDURULACAK]` (Uygulamanın teknik amacı: yeni açılan işletmelere kontrollü B2B tanıtım iletişimi.)
- Bu amaç meşru mudur? Kimin yararına? `[DOLDURULACAK]`

## 3. Gereklilik testi

- Amaca daha az müdahaleci yolla ulaşılabilir mi? `[DOLDURULACAK]`
- İşlenen veri kategorileri (uygulamanın fiilen tuttukları): işletme adı ve konumu (Google kaynaklı alanlar kalıcı saklanmaz), web sitesinden bulunan e-posta adresi ve kaynağı, doğrulama sonucu, gönderim kayıtları (maskeli konu, durum), engel listesi (e-posta özeti). Gerekli/gereksiz değerlendirmesi: `[DOLDURULACAK]`
- Kişiye ait (`ad.soyad@…`) ve genel (`info@…`) adresler için ayrı değerlendirme: `[DOLDURULACAK]`

## 4. Denge testi

| Soru | Değerlendirme |
|---|---|
| İlgili kişilerin makul beklentisi nedir? | `[DOLDURULACAK]` |
| Kişilerin hak ve özgürlüklerine etkisi? | `[DOLDURULACAK]` |
| Hedef ülkeye göre farklılıklar (bkz. SRS Bölüm 8.2) | `[DOLDURULACAK]` |
| Hassas veya kırılgan gruplar var mı? | `[DOLDURULACAK]` |

## 5. Güvenceler (uygulamada **teknik olarak mevcut** olanlar — hukuki yeterlilik değerlendirilmedi)

- Engel listesi, çıkış/itiraz/şikâyet kayıtlarının kaldırılamaması; temas sıklığı sınırları; ülke politikası kilidi.
- Gönderen kimliğinin ve çıkış yönteminin otomatik eklenmesi.
- Silme talebi akışı ve 72 saatlik operasyonel hedef (hukuki yanıt sürelerinin yerine geçmez).
- Maskeli dışa aktarma; kullanım telemetrisi yok; veriler yerelde.
- Açık hukuki sorular: gönderilmiş ileti kayıtlarının saklanması/silinmesi, engel listesinde e-posta özetinin saklanması, yedeklerde kalan eski veriler. `[DOLDURULACAK]`

## 6. Sonuç ve karar

- Sonuç (meşru menfaat dayanak olarak kullanılabilir mi, hangi ülkeler/koşullar için): `[DOLDURULACAK]`
- Gözden geçirme tarihi: `[DOLDURULACAK]`
- Onay: `[DOLDURULACAK]`
