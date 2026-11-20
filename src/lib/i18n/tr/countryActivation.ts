/**
 * Canlı ülke aktivasyonu metinleri: Ayarlar kartı, Electron yerel onay penceresi, devam onayı ve hata kodları
 * (`src/features/settings/live-country-card.tsx`, `electron/native-confirm.ts`,
 * `src/lib/compliance/live-country-activation.ts`). Karşılığı `en/countryActivation.ts`.
 */
export const countryActivation = {
  "nativeConfirm.cancel": "İptal",
  "nativeConfirm.checkbox": "Yukarıdaki bilgileri okudum; bu işlemi ben başlattım.",
  "nativeConfirm.mode.generic_only": "yalnızca genel işletme adresleri (generic_only)",
  "nativeConfirm.mode.allowed": "tüm uygun işletme adresleri (allowed)",
  "nativeConfirm.country.title": "Canlı ülke aktivasyonu onayı",
  "nativeConfirm.country.message": "Canlı gönderim için ülke kilidi açılacak.",
  "nativeConfirm.country.line.countries": "Ülkeler: {countries}",
  "nativeConfirm.country.line.mode": "Mod: {mode}",
  "nativeConfirm.country.line.rep": "Yetkili temsilci (beyan): {name}, {title}",
  "nativeConfirm.country.line.doc": "Onay belgesi (beyan): {ref}, tarih {date}",
  "nativeConfirm.country.line.sha": "Belge özeti (ilk 16): {sha}",
  "nativeConfirm.country.line.operator": "İşlemi yapan: {name}",
  "nativeConfirm.country.line.testMode": "Test modu AÇIK: gönderim yalnızca {n} izinli adrese",
  "nativeConfirm.country.line.running": "Şu an çalışan canlı kampanya: {n}",
  "nativeConfirm.country.disclaimer":
    "Bu kayıt, hukuki yetkinin doğrulandığı anlamına gelmez; uygulama belgeyi veya kişinin yetkisini doğrulayamaz. Yalnızca kimin, hangi belgeye dayanarak açtığı kaydedilir.",
  "nativeConfirm.country.confirm": "Onayla ve ülkeyi aç",

  "countryActivation.title": "Canlı ülke aktivasyonu",
  "countryActivation.desc":
    "Gerçek gönderim için bir ülkenin kilidi yalnızca burada, hukuki yetkilendirme kaydı ve bu bilgisayardaki yerel onay penceresiyle açılır. Varsayılan olarak tüm ülkeler kilitlidir.",
  "countryActivation.disclaimer":
    "Burada girilen kayıt, hukuki yetkinin doğrulandığı anlamına gelmez. Uygulama belgenin geçerliliğini veya kişinin yetkisini doğrulayamaz; yalnızca kimin hangi belgeye dayanarak açtığı denetim kaydına yazılır. Hukuki onay uygulama dışında alınmalıdır.",
  "countryActivation.noChannel":
    "Yerel onay yalnızca yüklü masaüstü uygulamasında çalışır. Bu ortamda aktivasyon yapılamaz.",
  "countryActivation.checks.title": "Aktivasyon ön koşulları",
  "countryActivation.check.live_flag": "Canlı gönderim kapısı (yazılım)",
  "countryActivation.check.consent": "Kullanım onayı verildi",
  "countryActivation.check.company_profile": "Firma profili tamam",
  "countryActivation.check.real_mailbox": "Bağlı gerçek (Gmail) kutu",
  "countryActivation.check.dns_auth": "DNS/gönderen doğrulaması",
  "countryActivation.check.https_unsubscribe": "Doğrulanmış HTTPS çıkış uç noktası",
  "countryActivation.check.event_delivery": "Çıkış taleplerinin çekilmesi sağlıklı",
  "countryActivation.check.legal_live_countries": "Canlı ülke politikası hukuki işareti (yazılım)",
  "countryActivation.check.test_mode": "Test modu açık ve izinli adres listesi dolu",
  "countryActivation.check.self_test":
    "Her gerçek kutuda, son bağlanmadan sonra ve 30 gün içinde başarılı “kendime test gönder”",
  "countryActivation.check.ok": "Tamam",
  "countryActivation.check.missing": "Eksik",
  "countryActivation.active.title": "Açık ülkeler",
  "countryActivation.active.none": "Şu an açık ülke yok: gerçek kampanya iletisi gönderilemez.",
  "countryActivation.active.row": "{code}: {mode}; onaylayan: {by}; referans: {ref}",
  "countryActivation.revoke": "Geri al (kilitle)",
  "countryActivation.revoke.title": "Ülkeyi yeniden kilitle",
  "countryActivation.revoke.body":
    "{code} yeniden engellenecek ve kilitlenecek. Çalışan canlı kampanyalar duraklatılır; sürdürmek için açık onay gerekir ve o ülkenin alıcıları sürdürmede kalıcı olarak dışlanır.",
  "countryActivation.revoke.confirm": "Kilitle ve kampanyaları duraklat",
  "countryActivation.revoked": "Ülke yeniden kilitlendi.",
  "countryActivation.revoked.paused": "{n} çalışan canlı kampanya duraklatıldı.",
  "countryActivation.form.title": "Yeni ülke aç",
  "countryActivation.form.countries": "Açılacak ülkeler",
  "countryActivation.form.mode": "Mod",
  "countryActivation.form.mode.generic_only": "Yalnızca genel işletme adresleri (önerilen)",
  "countryActivation.form.mode.allowed": "Tüm uygun işletme adresleri",
  "countryActivation.form.rep": "Yetkili temsilci adı soyadı",
  "countryActivation.form.repTitle": "Yetkili temsilci unvanı",
  "countryActivation.form.operator": "İşlemi yapan kişi (bu bilgisayardaki kullanıcı)",
  "countryActivation.form.docRef": "Onay belgesi referansı",
  "countryActivation.form.docDate": "Onay belgesi tarihi (YYYY-AA-GG)",
  "countryActivation.form.docSha": "Belge SHA-256 özeti (isteğe bağlı)",
  "countryActivation.form.attest": "Onay belgesindeki ülkeler ve mod, burada seçilenlerle aynıdır.",
  "countryActivation.form.check": "Kontrol et",
  "countryActivation.form.activate": "Aktive et (yerel onay penceresi açılır)",
  "countryActivation.form.waiting":
    "Yerel onay penceresi açıldı: bu uygulamanın penceresinde onaylayın veya iptal edin (en çok 2 dakika).",
  "countryActivation.form.activated": "Ülkeler açıldı.",
  "countryActivation.plan.ready": "Ön koşullar ve ülke durumu uygun; aktive edilebilir.",
  "countryActivation.plan.notReady": "Aktivasyon yapılamaz: eksik koşulları tamamlayın.",
  "countryActivation.warn.operator_differs_from_consent":
    "Uyarı: işlemi yapan kişi, kurulum onayını veren kişiden farklı. Kayda yazılacak.",
  "countryActivation.resume.revoked":
    "Bu kampanya, bir ülke yeniden kilitlendiği için duraklatıldı. Sürdürürseniz o ülkenin alıcıları kalıcı olarak dışlanır.",
  "campaign.pause.country_revoked":
    "Kampanya, bir canlı ülke yeniden kilitlendiği için duraklatıldı. Sürdürmek için açık onay gerekir.",
  "apiError.ACTIVATION_INVALID": "Geçersiz ülke, mod veya onay.",
  "apiError.ACTIVATION_LEGAL":
    "Hukuki yetkilendirme kaydı eksik veya geçersiz (temsilci, belge referansı, tarih ve kapsam beyanı zorunlu).",
  "apiError.ACTIVATION_PREREQUISITES": "Gönderim ön koşulları tamam değil.",
  "apiError.ACTIVATION_TEST_MODE":
    "İlk aktivasyon için test modu açık ve izinli adres listesi dolu olmalı.",
  "apiError.ACTIVATION_REFUSED": "Ülke açılamıyor veya geri alınamıyor.",
  "apiError.CONFIRM_UNAVAILABLE":
    "Yerel onay yalnızca yüklü masaüstü uygulamasında kullanılabilir.",
  "apiError.CONFIRM_DECLINED": "Yerel onay verilmedi.",
  "apiError.CONFIRM_TIMEOUT": "Yerel onay süresi doldu.",
} as const;
