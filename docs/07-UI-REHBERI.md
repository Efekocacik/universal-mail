# Arayüz Rehberi (Kullanılabilirlik ve Görsel Dil)

Amaç: kullanıcı (ihracat sorumlusu; teknik değil) **hatırlamak zorunda kalmadan** işini bulsun, **ne olacağını eylemden önce** görsün, **yanlış tıklamanın bedelini** ödemesin; ekran sade ve şık olsun. Bu belge, yeni ekran eklerken de uyulacak kurallardır. Dayanak: Nielsen'in 10 kullanılabilirlik ilkesi, WCAG 2.1 AA.

## 1. Renk dili (tek anlam, tek renk)

| Renk | Anlam | Nerede kullanılır |
|---|---|---|
| **Yeşil** (`primary`, `success`) | Olumlu, ilerleten eylem | Kaydet, Onayla, Başlat, Devam, Gönder, Ekle; başarı bildirimi |
| **Kırmızı** (`destructive`) | Geri alınamaz eylem ve hata | Sil, Kaldır, İptal et (kampanya), Verileri sil; hata iletisi, geçersiz alan |
| **Gri / çerçeveli** (`outline`, `ghost`) | İkincil, nötr | Vazgeç, Kapat, Geri, Düzenle, Yenile, Filtre |
| **Sarı** (`warning`) | Dikkat, geri alınabilir risk | Bütçe yaklaşıyor, eksik bilgi uyarısı |
| **Mavi** (`info`) | Bilgi | İpucu, "temas kuruldu" |
| Mor / yeşil / sarı / gri noktalar | Yenilik düzeyi (rozet ve harita) | Yalnızca yenilik göstergesinde |

Kurallar:
- Bir ekranda **tek bir** dolu yeşil ana eylem olur. Diğerleri çerçeveli/gri.
- Kırmızı **yalnızca** silme/kaldırma/hata içindir; süs olarak kullanılmaz. Yeşil de uyarı için kullanılmaz.
- Renk tek başına anlam taşımaz: her durumda metin veya simge de vardır (renk körlüğü).

## 2. Düğmeler

| Bileşen | Ne zaman |
|---|---|
| `<Button>` (varsayılan yeşil) / `variant="success"` | Ana olumlu eylem |
| `variant="destructive"` | **Yalnızca onay penceresindeki** silme onayı |
| `variant="dangerOutline"` | Sayfadaki "Sil / Kaldır" düğmesi (tıklayınca `ConfirmDialog` açılır) |
| `variant="dangerGhost"` | Satır içi küçük sil simgesi (`aria-label` zorunlu, yanında tooltip) |
| `variant="outline"` | İkincil eylem (Vazgeç, Düzenle, Yenile) |
| `variant="ghost"` | Üçüncül (Kapat, Listeye dön) |
| `loading` özelliği | İstek sürerken kullanılır; düğmeyi kilitler (çift tıklama olmaz) ve dönen simge gösterir |

Etiket sözlüğü (aynı eylem her yerde aynı adla): **Kaydet**, **Vazgeç** (Cancel), **Sil**, **Kaldır** (listeden çıkarma), **Ekle**, **Başlat**, **Devam**, **Geri**, **Kapat**, **Yenile**, **Dışa aktar**. Eylemler fiil olur ("Kaydet", "Taramayı başlat"); "Tamam/Evet/Hayır" gibi belirsiz etiket kullanılmaz.

## 3. Kalıplar

- **Silme/geri alınamaz eylem:** her zaman `ConfirmDialog tone="danger"`. Başlık eylemi söyler ("Bu e-posta silinsin mi?"), açıklama sonucu söyler ("Geri alınamaz."), onay düğmesi kırmızı ve eylemin adını taşır ("Sil"), varsayılan odak **Vazgeç**'tedir. Başarı sonrası toast ile bildirilir.
- **Önemli ama zararsız onay** (kampanyayı başlat): `ConfirmDialog tone="success"`, ne olacağını özetler.
- **Kaydetme:** alan değişince değil, **Kaydet**'e basınca ya da alandan çıkınca (kısa alanlarda) kaydedilir; sonuç yeşil toast "Kaydedildi". Hata kırmızı ve nedenini söyler.
- **Yükleniyor:** iskelet (`Skeleton`) kullanılır, sayfa zıplamaz; uzun işlerde ilerleme ve "ne yapılıyor" metni gösterilir.
- **Boş durum:** `EmptyState`: ne olduğu + tek net eylem ("İlk taramayı başlat").
- **Hata:** ne oldu + ne yapılabilir. Teknik ifade ve kod gösterilmez. Düzeltilebiliyorsa düğme verilir ("Yeniden dene").
- **Toast:** yalnızca eylem sonucu (başarı yeşil, hata kırmızı); kalıcı bilgi için sayfa içi mesaj.
- **Yardım:** karmaşık alanda `HelpTip` (?) ile tek cümle; uzun açıklama gizli (açılır) olur. Kullanıcı hatırlamak zorunda kalmasın diye seçenekler görünür tutulur (açılır listelerde sayaçlar, son seçimler).

## 4. Yerleşim

- Sayfa: `PageHeader` (başlık + tek cümle açıklama + sağda ana eylem), altında içerik. Genişlik sınırlı (`max-w-5xl`), kenar boşluğu `p-6` (dar ekranda `p-4`).
- Bölümler `Card`/`Section` ile gruplanır; aralık ölçeği 4 / 8 / 12 / 16 / 24 px.
- Gezinme: üst çubukta 4 sabit öğe (Keşif, Taramalar, Kampanyalar, Ayarlar); etiketler dar ekranda da simgeyle birlikte okunur. Mevcut konum her zaman belli (`aria-current`).
- Kampanya alanı: **Şablonlar** ve **Uyum** (ülke politikası, engel listesi) üst çubukta ayrı öğe değildir; sayfa içi alt gezinmeyle (Kampanyalar · Şablonlar · Uyum) ulaşılır ve üst çubukta "Kampanyalar" etkin görünür.
- Dokunma/tıklama hedefi en az 32 px (liste satırları 44+).
- Kaydırma: `um-scroll` sınıfı (ince çubuk, yerleşim kayması yok, taşma dışarı sızmaz). Sabit başlıklar `sticky`.

## 5. Hareket

- Geçişler 150–180 ms, yumuşak (`ease-out`); büyük/dikkat dağıtıcı animasyon yok. `prefers-reduced-motion` açıkken hareket kapanır.
- Dialog, açılır listeler ve toast giriş animasyonu kısa; sayfa girişinde `um-enter`.
- Düğmeye basma geri bildirimi (hafif küçülme) ve hover gölgesi vardır.

## 6. Erişilebilirlik ve klavye

- Odak halkası her zaman görünür; `Esc` her pencereyi/paneli kapatır, `Enter` ana eylemi çalıştırır, J/K liste gezinmesi.
- Her form alanının görünür etiketi vardır; hata alanı `aria-invalid` + metin.
- Kontrast: metin ≥ 4,5:1; `muted-foreground` küçük metinde de bu oranı korur.
- Simge-only düğmelerde `aria-label` ve tooltip.

## 7. Dil

Türkçe, kısa, sade ve saygılı; "siz" hitabı. İçinde `API`, `SKU`, `FieldMask` gibi terimler geçen metin kullanıcıya gösterilmez (tooltip/gelişmiş bölümde olabilir).

## 8. Yeni ekran kontrol listesi

1. Tek yeşil ana eylem var mı? Silme kırmızı ve onaylı mı?
2. Boş, yükleniyor, hata, başarı durumları tasarlandı mı?
3. Klavye ile baştan sona kullanılabiliyor mu? Odak sırası mantıklı mı?
4. Etiketler sözlükle uyumlu mu? Bir yeni kullanıcı ne olacağını eylemden önce anlıyor mu?
5. Dar pencerede (800 px) bozulma yok mu?
