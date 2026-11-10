# Faz 3 — Şablonlar, Kampanya, Gönderim, Uyum: Uygulama Notları

**Durum (10 Kasım 2026): Demo geliştirmeleri tamamlandı, Faz 3 canlı entegrasyon ve pilot bekliyor.** Faz 3'ün 14 geliştirme aşaması `feat/faz-3` dalında kodlandı ve **demo sağlayıcıyla** CI'da doğrulandı (son aşama: `b8627f5`, CI run 42726495692). **Faz 3 resmi olarak KAPANMADI:** gerçek Gmail/SMTP bağlantısı, gerçek gelen kutusu, genel HTTPS çıkış uç noktası, hukuki onaylar, canlı ülke politikaları ve pilot kabulü tamamlanmadı (Bölüm 6 ve 7). Gerçek e-posta gönderimi kodda **kapalıdır** ve bu belge o kapıyı açmaz.

> Bu belge yalnızca kod ve testlerle doğrulanmış olanı "yapıldı" diye yazar. Kısmi olan, simülasyonla çalışan veya gerçek hesap/hukuki onay isteyen her şey açıkça işaretlidir.

## 1. Ne yapıldı

Simgeler: ✔ yapıldı ve test edildi · ◐ kısmen (demo/simülasyon kapsamında) · ✘ yapılmadı.

| Kalem | Durum | Not |
|---|---|---|
| Veri modeli (`0002_faz3`) | ✔ | `mailboxes`, `templates`, `campaigns`, `campaign_steps`, `campaign_leads`, `messages`, `suppressions`, `country_policies` (Bölüm 3) |
| Ülke politikası tablosu ve uygunluk kontrolü | ✔ | Demo ve canlı kapsamlar ayrı; **canlı politikaların tamamı engelli ve kilitli**; demo politikası yalnızca sıkılaştırılabilir |
| Suppression (e-posta, alan adı, CSV, elle) | ✔ | Açık adres tutulmaz (özet + maskeli gösterim); çıkış/şikâyet/silme nedenleri sıradan işlemle kaldırılamaz |
| Suppression — otomatik kaynaklar (bounce, yanıt, çıkış) | ◐ | Kod ve testler var; kanal tasdiki yalnızca **demo simülasyonu** (Bölüm 5) |
| Gönderim uygunluğu ve temas sıklığı (SRS 5.6.1) | ✔ | Dizide en çok 3 ileti, takip arası ≥ 5 gün, 180 gün dinlenme, 30 gün kampanyalar arası, alan adı başına günde 1 ileti; yalnızca sıkılaştırılabilir |
| Kişisel posta alan adlarını hariç tutma; gönderen profili olmadan kilit | ✔ | |
| Şablon motoru, değişkenler, eksik veri uyarısı, dil bazlı şablon, canlı önizleme, TR/EN hazır şablonlar | ✔ | Yerleşik şablonlar salt okunur (kopyalanır); kampanyada kullanılan şablon kilitli; sürüm kilidi |
| İçerik kontrolü ve "kendime test gönder" | ◐ | Test yalnızca **demo kutusunun kendi adresine**; gerçek sağlayıcıya gitmez |
| Zorunlu alt bilgi motoru | ◐ | Unvan, adres, vergi/sicil numarası, telefon, çıkış bağlantısı otomatik eklenir. **TR için MERSİS alanı yok**; çıkış bağlantısı demo (`.invalid`) |
| MIME oluşturucu ve güvenli başlıklar | ✔ | `List-Unsubscribe` yalnızca güvenli HTTPS ile; `List-Unsubscribe-Post` yalnızca doğrulanmış uç noktada (**hiçbir zaman eklenmez**, uç nokta yok) |
| Gönderim servisi ve zamanlayıcı | ✔ | Tek adım/tur; günlük tavan (20 → 80), ısınma, 90–240 sn aralık, alıcı yerel saat penceresi (hafta içi 09–17), yeniden deneme ≤ 3, sonucu belirsiz ileti **asla** otomatik tekrarlanmaz. Yalnızca demo sağlayıcı |
| Kampanya yönetimi (taslak/hazır/başlat/duraklat/devam/iptal) | ✔ | Başlatma onay belirteci şablon sürümlerini ve firma profilini kapsar; ayrılmış gönderim duraklatmadan sonra tamamlanabilir (belgelendi, testli) |
| Kampanya sihirbazı, başlat öncesi özet ve ilk 5 önizleme | ✔ | |
| Şablon ve uyum ekranları | ✔ | Kampanyalar · Şablonlar · Uyum · Günlük alt gezinmesi (üst çubuk 4 sabit öğe) |
| Gelen ileti işleme (DSN, yanıt, çıkış, olumsuz) | ◐ | 4 katmanlı kanıt (Bölüm 5); **gerçek gelen kutusu yok**, demo gelen kutusu bellekte |
| Otomatik durdurma — kampanya düzeyi | ✔ | ≥ 20 alıcı, ≥ 2 doğrulanmış bounce'lu alıcı, ≥ %5 |
| Otomatik durdurma — posta kutusu düzeyi (SRS 5.6.1: %3 bounce) | ◐ | Bounce tarafı tam; **şikâyet oranı (%0,1) ölçülemiyor** (sağlayıcı verisi yok) ve öyle gösterilir |
| Gönderim günlüğü ve işlem kaydı (+ yalnızca maskeli CSV) | ✔ | |
| SPF/DKIM/DMARC denetimi | ◐ | Ekran ve kural değerlendirmesi testli; **demo kutusunda DNS sorgusu atılmaz**, gerçek alan adı hiç doğrulanmadı |
| Silme talebi (FR-CMPL-03) | ◐ | Akış, API ve ekran var; gerçek gönderim kayıtları ve engel özeti **hukuki değerlendirme bekliyor** |
| Canlı gönderime hazırlık ekranı | ✔ | Salt okunur; gerçek gönderimi açmaz |
| `docs/UYUM.md`, `docs/LIA.md` | ◐ | UYUM **taslak**; LIA yalnızca **iskelet**; ikisi de hukuk onayı bekliyor |
| Gmail OAuth, SMTP | ✘ | Yok (`getProvider` gerçek sağlayıcıda hata verir) |
| Gerçek gelen kutusu okuyucu | ✘ | Arayüz sözleşmesi (`InboxReader`) ve demo uygulaması var |
| Genel HTTPS tek tıklamalı çıkış uç noktası | ✘ | Yalnızca yerel demo çekirdeği (`/u/[token]`, alıcılar ulaşamaz) |
| Pilot kabulü (SRS Bölüm 13/6–8, günde ≤ 20) | ✘ | Başlamadı |

### Aşama aşama (commit)
1. `09837ae` tablolar (`0002_faz3`) · 2. `57618bd` politika/demo kutusu/şablon seed'leri · 3. `782e820` politika servisi · 4. `b0c44ef` suppression servisi · 5. `707c8eb` uygunluk ve temas sıklığı · 6. `3912076` şablon motoru ve alt bilgi · 7. `7889987` MIME · 8. `ade9095` FakeMailProvider ve gönderim servisi · 9. `d511b95` zamanlayıcı ve kuyruk · 10. `e9e9501` kampanya yönetimi · 11. `9f3c7e9` kampanya arayüzü · 12. `4b57312` şablon editörü, ülke politikası ve suppression yönetimi (CI 42699793397) · 13. `e3bf1c8` gelen ileti işleme, otomatik durdurma, günlük (CI 42717880446) · 14. `b8627f5` posta kutusu sağlığı, silme talebi, hazırlık ekranı (CI 42726495692).

**Testler:** Playwright 47 senaryo (CI yeşil; yeni 760/800 px yatay taşma senaryoları dahil). Yerel Vitest 900 test; Windows'ta dosya tabanlı testlerin ~150'si `libsql` dosyası kapandıktan sonra klasör silinemediği için (`EPERM`) düşer, ayrıca 3 test Windows'a özgüdür (POSIX izni, yol biçimi). **Linux CI belirleyicidir ve yeşildir.** Bu yerel düşmeler gizlenmedi ve test yapılandırması değiştirilmedi.

## 2. API uçları (Faz 3)

| Uç | Açıklama |
|---|---|
| `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/{id}`, `PUT …/steps`, `GET/POST …/leads`, `DELETE …/leads/{clId}`, `GET …/messages` | Kampanya oluşturma, adımlar, lead ekleme/çıkarma, kuyruk ve iletiler. Eşzamanlılık: monoton `updated_at` kilidi |
| `GET /api/campaigns/{id}/preflight`, `POST …/control` | Başlat öncesi özet ve onay belirteci; `ready/draft/start/pause/resume/cancel` (tek işlem + denetim kaydı) |
| `GET /api/campaigns/review` | Sonucu belirsiz (`unknown`) gönderimler |
| `GET/POST /api/templates`, `GET/PATCH …/{id}`, `POST …/{id}/archive`, `POST …/{id}/duplicate`, `POST …/preview` | Şablon yönetimi, sürüm kilidi, taslak önizleme |
| `GET/PATCH /api/compliance/policies` | Ülke politikaları (PATCH yalnızca **demo** ve yalnızca sıkılaştırır) |
| `GET/POST /api/compliance/suppressions`, `…/import`, `…/{id}/lift` | Engel listesi; kaldırma açık onay + gerekçe ister, korumalı nedenler kaldırılamaz |
| `GET/PATCH /api/compliance/auto-stop` | Kampanya düzeyi eşikler (yalnızca sıkılaştırma) |
| `GET/PATCH /api/compliance/mailbox-limits` | Posta kutusu düzeyi eşikler (yalnızca sıkılaştırma) |
| `GET /api/mailboxes`, `…/{id}/health`, `POST …/{id}/health/reenable` | Kutu listesi (salt okunur), sağlık görünümü, onaylı yeniden etkinleştirme |
| `POST /api/mailboxes/{id}/test-send`, `POST …/{id}/dns-check` | Kendime test (yalnızca demo), DNS denetimi (demo kutusunda sorgu yok) |
| `GET /api/inbox/review`, `POST …/{id}` | İnceleme kuyruğu ve kullanıcı kararı |
| `GET /api/mail-log`, `/export`, `GET /api/audit`, `/export` | Günlük ve işlem kaydı; CSV'de yalnızca maskeli adres, bilinmeyen parametre reddedilir |
| `GET/POST /api/compliance/erasure`, `POST …/preview` | Silme talebi (önizleme yalnızca sayı) |
| `GET /api/compliance/live-readiness` | Salt okunur hazırlık listesi |
| `GET /api/leads/{id}/campaigns` | Lead'in kampanyalardaki durumu (adres yok) |
| `POST /api/unsubscribe/{token}` | **Yalnızca demo** çıkış çekirdeği (GET işlem yapmaz) |
| `POST /api/dev/inbox` | Demo gelen kutusu simülatörü; `FAZ3_DEMO_INBOX_ENABLED` kapalıyken **404** |

## 3. Veri modeli (migrasyon `0002_faz3`, yalnızca yeni tablolar)

- `mailboxes` (`credentials_ref` yalnızca gizli depodaki kayıt adı; token/parola burada tutulmaz), `templates` (sürüm, `built_in`, arşiv), `campaigns`, `campaign_steps`, `campaign_leads` (alıcı adresi + özet; silme talebinde boşaltılır, `redacted_at`), `messages` (giden ve gelen; gövde saklanmaz, `body_sha256`, `peer_hash`/`peer_domain`, `redacted_at`), `suppressions` (e-posta özeti `sha256-v1`, maskeli adres), `country_policies` (`scope`: `live`/`demo`, kilit).
- Gönderim geçmişi olan lead/kampanya/şablon silinemez (`ON DELETE RESTRICT`).
- Yeni migrasyon eklenmedi (Aşama 13–14). Ayarlar tablosundaki iç anahtarlar (ayarlar API'si yazamaz): `seed.faz3`, `mail.autoStop`, `mail.mailboxLimits`, `mail.mailboxHalts`.
- İş türleri: `mail.send` (bayrak: `FAZ3_DEMO_SCHEDULER_ENABLED`), `inbox.sync` (bayrak: `FAZ3_DEMO_INBOX_ENABLED`). **İkisi de varsayılan kapalı**; yalnızca E2E sunucusunda (`e2e/serve.mjs`) açıktır.

## 4. Google verisi ve kişisel veri

- Google içeriği (işletme adı, açılış tarihi) iletinin gövdesinde/kalıcı kayıtta tutulmaz; konu satırı Google kaynaklı değişkenler maskelenmiş saklanır (`subject_logged`).
- Gelen ileti gövdesi ve gönderen adresi saklanmaz (özet ve alan adı).
- Dışa aktarmalarda adresler yalnızca maskelidir (`i***@alan.adı`); tam adres dışa aktarımı yoktur.

## 5. Kararlar ve SRS'den sapmalar

- **Gerçek gönderim kodda kapalı:** `LIVE_SENDING_ENABLED = false`; canlı kapsamın bütün politikaları engelli ve kilitli; kilit yalnızca hukuki onayla yeni yazılım sürümünde açılır. Hukuki onay durumları `src/lib/compliance/legal-status.ts` içinde **hepsi `false`** ve kullanıcı beyanıyla değişmez.
- **Sağlayıcı sözleşmesi:** `MailProvider` (sonuç `accepted`/`rejected`/`unknown`; `unknown` asla otomatik tekrarlanmaz) ve `InboxReader`. Yalnızca demo uygulamaları var. **Gmail API birincil (SRS), SMTP alternatif/ikincil; seçim kesinleşmedi** — SMTP zorunlu değilse eklenmeyebilir, eklenirse yeni paket (`nodemailer`) için önce onay gerekir.
- **Gelen iletiye güven (Aşama 13):** Message-ID eşleşmesi tek başına kanıt değildir. Otomatik etki (suppression, dizi durdurma, kampanya duraklatma) için L1 yapısal eşleşme (aynı kutu, kabul edilmiş kampanya iletisi, ≤ 30 gün), L2 alıcı bağı, L3 **iletinin dışından gelen** kanal tasdiki, L4 etki sınırları birlikte gerekir. Eksik kanıtlı ileti inceleme kuyruğuna düşer ve satıra kampanya bağlantısı yazılmaz. İletinin kendi `Authentication-Results` başlığı yok sayılır. Olumsuz/belirsiz yanıt hiçbir koşulda otomatik suppression üretmez. **Bu sürümdeki tasdik (`demo_simulated`) simülasyondur; gerçek SPF/DKIM/DMARC doğrulaması değildir.**
- **İki ayrı otomatik durdurma:** kampanya düzeyi (≥ 20 alıcı, ≥ 2 doğrulanmış bounce'lu alıcı, ≥ %5) ve SRS 5.6.1 posta kutusu düzeyi (son 30 gün, alıcı bazlı, **%3'ü kesin aşarsa**, örneklem < 50 ise "yetersiz veri" ama ≥ 3 doğrulanmış bounce yine durdurur). Pay/payda alıcı birimindedir; takip veya birden çok bounce iletisi alıcıyı bir kez sayar. İkisi de yalnızca sıkılaştırılabilir, geri gevşetme yoktur; posta kutusu durdurması açık onay + gerekçeyle kaldırılır ve oran hâlâ eşik üstündeyse reddedilir.
- **Şikâyet oranı ölçülemiyor:** Gmail geri bildirim döngüsü sağlamaz ve elle girilen şikâyet kayıtları bir posta kutusuna bağlanamaz; bu yüzden %0,1 kuralı "ölçülemiyor" gösterilir, "temiz" gösterilmez, elle girilenler orana katılmaz.
- **Silme talebi (Aşama 14):** Güvenle yapılanlar (adresi tutan `lead_emails`, demo/iletilmemiş ileti ve dizi kayıtları) temizlenir; gerçek posta kutusundan iletilmiş kayıtlar ve engel özeti **hukuki değerlendirme bekler** ve dokunulmaz. Yer tutucu `sha256("um-erased-v1:"+rastgele 128 bit)`: başka bir adresle eşleşmez, saklanmaz, kişi başına tektir. `peer_domain` korunur (alan adı günlük sınır dizini buna bağlıdır). "Yükümlülüğüm yok" beyanı onay yerine geçmez.
- **Takip adımları:** roadmap Faz 4'te yazar; altyapı (3 adımlı dizi) Faz 3'te çalışır, ek iş yok.
- **Çıkış bağlantısı:** yerel demo çekirdeği alıcılara ulaşamaz ve ara katman yazılımı harici POST'ları engeller; bu nedenle gerçek RFC 8058 tek tıklamalı çıkış **değildir**.

## 6. Kalan işler ve doğrulanmayanlar (sırayla)

1. **Faz 0 hesapları** (Bölüm 7) olmadan hiçbir gerçek entegrasyon doğrulanamaz.
2. **Gmail OAuth** (SMTP isteğe bağlı), posta kutusu yapılandırma ekranı, gizli depoya OAuth adları, gerçek test gönderimi.
3. **Gerçek gelen kutusu** ve sağlayıcının kanal tasdikini üretmesi; şikâyet verisi varsa %0,1 kuralının bağlanması.
4. **HTTPS çıkış uç noktası** (barındırma kararı sonrası) ve ancak ondan sonra `List-Unsubscribe-Post`.
5. **SPF/DKIM/DMARC** gerçek gönderim alan adında doğrulama.
6. **Hukuki onaylar** (Bölüm 7); canlı ülke kilidinin yeni sürümle açılması.
7. **SRS 13/6, 7, 8 canlı doğrulaması**, ardından **pilot** (ilk hafta günde ≤ 20).
8. Bu belgenin ve roadmap'in durumunu güncelleyip Faz 3'ü kapatmak.

Ayrıca (Faz 3 kapanışını **engellemeyen** açık işler): 320 px üst çubuk taşması (Electron `minWidth: 760`; 760/800 px'te taşma yok), yerel Windows `EPERM` test sorunu, TR için MERSİS alanı, `README.md` durum paragrafının güncellenmesi.

## 7. Şirketten beklenenler (kontrol listesi)

**Hesap, alan adı ve API**
- [ ] Google Workspace hesabı ve gönderim için ana markadan ayrı alan adı
- [ ] Google Cloud projesi (Workspace kuruluşuna ait) ve Gmail API için OAuth istemcisi ("Desktop app")
- [ ] (İsteğe bağlı) SMTP sağlayıcı bilgileri — SMTP kararı kesinleşmedi
- [ ] SPF, DKIM, DMARC DNS kayıtları ve DKIM seçici adı
- [ ] HTTPS çıkış uç noktası için genel erişilebilir barındırma kararı ve alan adı
- [ ] Gerçek firma profili: unvan, adres, vergi/sicil numarası, telefon, iletişim kişisi; TR için MERSİS
- [ ] Hedef ülke/ürün listesi, pilot bölge ve yetkilendirilmiş test alıcıları

**Faturalandırma**
- [ ] Google Cloud faturalandırma, bütçe uyarısı, günlük kota sınırları
- [ ] Workspace aboneliği ve alan adı satın alma

**Hukuki kararlar**
- [ ] LIA içeriği (`docs/LIA.md`) ve onayı
- [ ] `docs/UYUM.md` hukuk onayı
- [ ] Canlı ülke politikası kilidinin yazılı onayı (ülke bazında)
- [ ] Gerçek gönderim kayıtlarının silme talebinde işlenmesi
- [ ] Engel listesinde e-posta özetinin saklanma dayanağı
- [ ] Yedeklerde kalan eski verinin değerlendirmesi
- [ ] `docs/03-ANLASMA-NOTU.md` onayı (Faz 0)

## 8. Sonraki fazlara ekleme noktaları

- `src/lib/mail/provider/provider.ts` (`getProvider`) gerçek sağlayıcı bağdaştırıcısı için; `src/lib/mail/inbound/sync.ts` (`InboxReader`) ve `evidence.ts` (`Attestation`) gerçek tasdik sözleşmesi için.
- `src/lib/compliance/legal-status.ts` hukuki onay sabitleri (yalnızca onaylı sürümle değişir).
- Faz 4: zamanlanmış tarama, dashboard, TR/EN arayüz, koyu tema, bildirimler (bu belgenin kapsamı dışında).

## 9. Çalıştırma

- Varsayılan: gerçek gönderim kapalı; `FAZ3_DEMO_SCHEDULER_ENABLED` ve `FAZ3_DEMO_INBOX_ENABLED` tanımsız (kapalı). Demo kampanya gönderimi için yalnızca geçici/test veri klasöründe `FAZ3_DEMO_SCHEDULER_ENABLED=1` verilir.
- Testler: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npx playwright test`. Windows'ta Vitest için ASCII bir geçici klasör (`TMPDIR`/`TMP`/`TEMP`) kullanın.
- İlgili belgeler: [UYUM](UYUM.md) (taslak), [LIA](LIA.md) (iskelet), [UI Rehberi](07-UI-REHBERI.md).
