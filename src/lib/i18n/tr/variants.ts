/**
 * Paket T (Faz 5): DE bilgi rozeti, A/B konu, kategori varyantları, kampanya istatistikleri, açılma izleme kartı ve şablon hata metinleri. P0 başlattı; sonrasında yalnızca T düzenler.
 * Karşılığı `en/variants.ts`.
 */
export const variants = {
  "tracking.settings.title": "Açılma izleme",
  "tracking.settings.desc":
    "Demo kampanyalarda iletilerin açılıp açılmadığını yaklaşık olarak gösterir. Varsayılan olarak kapalıdır.",
  "tracking.settings.help":
    "İletiye görünmez küçük bir görsel eklenir; alıcının e-posta programı onu yüklediğinde ileti açılmış sayılır. Görselleri engelleyen programlar açılmayı göstermez, bu yüzden sayı yaklaşıktır.",
  "tracking.toggle": "Açılma izlemeyi kullan",
  "tracking.toggle.hint":
    "Demo kampanya iletilerine görünmez bir izleme görseli eklenir ve açılmalar yaklaşık olarak sayılır.",
  "tracking.state.on": "Açık · {at} tarihinde onaylandı",
  "tracking.state.off": "Kapalı",
  "tracking.legal":
    "Hukuki not: açılma izleme, alıcının cihazından bilgi okunması sayılabilir. AB'de ve birçok ülkede açık rıza gerektirebilir. Kullanmadan önce kendi hukuki değerlendirmenizi yapın.",
  "tracking.demoOnly":
    "Bu sürümde yalnızca demo kampanyalarda çalışır. Gerçek iletilere izleme görseli eklenmez; bunun için ileride genel erişimli aktarıcı desteği gerekir.",
  "tracking.confirm.title": "Açılma izleme açılsın mı?",
  "tracking.confirm.body":
    "Açılma verisi kesin değildir (görsel engelleme, otomatik ön yükleme). Yalnızca demo kampanyalarda kullanılır; istediğiniz an kapatabilirsiniz.",
  "tracking.confirm.ok": "Anladım, aç",

  "tpl.infoOnly": "Yalnızca bilgi amaçlı, gönderim engelli",
  "tpl.infoOnly.hint":
    "Almanca şablonlar örnek olarak durur: Almanya, Avusturya ve İsviçre'ye soğuk e-posta gönderimi ülke kurallarıyla kapalıdır.",
  "tpl.abBadge": "A/B konu",
  "tpl.categoryBadge": "Kategori: {name}",
  "tplField.subjectB": "Konu B",
  "tplEditor.subjectB": "Konu B (A/B denemesi, isteğe bağlı)",
  "tplEditor.subjectB.hint":
    "Doldurursanız kampanyadaki alıcıların yarısı bu konuyu alır. Hangi konunun daha çok yanıt aldığını kampanya ayrıntısında görürsünüz.",
  "tplEditor.infoOnly":
    "Bu dildeki şablonlar yalnızca bilgi amaçlıdır ve kampanyada kullanılamaz (ülke kuralları gönderimi engeller).",
  "tplEditor.category":
    "Kategori varyantı: kampanyada {name} işletmelerine bu şablon gider, diğerlerine genel şablon.",
  "tplPreview.variant": "Önizlenen konu",
  "tplPreview.variant.a": "Konu A",
  "tplPreview.variant.b": "Konu B",
  "composeError.template_info_only": "Şablon yalnızca bilgi amaçlı; gönderimde kullanılamaz",

  "wizard.steps.infoOnly": "{lang}: yalnızca bilgi amaçlı, gönderim engelli",
  "wizard.steps.noUsable":
    "{lang}: kullanılabilir genel ilk e-posta şablonu yok (arşivlenmiş olabilir). Şablonlar sayfasından bir şablon ekleyin.",
  "wizard.steps.ab": "{lang}: A/B konu denemesi açık. Alıcılar iki konuya dönüşümlü dağıtılır.",
  "wizard.variants.title": "Kategori varyantları (ilk e-posta)",
  "wizard.variants.help":
    "İşaretli kategorideki işletmelere o kategoriye özel şablon gider, diğerlerine yukarıdaki şablon. Uygun varyantlar önerilir; istemediğinizin işaretini kaldırın.",
  "wizard.variants.none": "Seçili dillerde kategoriye özel şablon yok.",
  "wizard.variants.use": "{lang} · {category} işletmelerine ayrı şablon",
  "wizard.variants.template": "{lang} {category} varyant şablonu",
  "wizard.variants.stale":
    "{step} · {lang} · {category}: varyant şablonu arşivlenmiş veya artık uygun değil. Kaydettiğinizde bu varyant kaldırılır.",
  "wizard.variants.followupKept":
    "Takip adımları için tanımlı kategori varyantları korunur. Hepsini kampanya ayrıntısında görebilirsiniz.",
  "campaign.stepVariant": "{category} → {template}",
  "campaign.stepVariants": "Kategori varyantları",

  "campaignStats.title": "Konu denemesi ve açılmalar",
  "campaignStats.ab.title": "A/B konu denemesi (ilk e-posta)",
  "campaignStats.ab.none":
    "Bu kampanyada A/B konu denemesi yok. Denemek için ilk e-posta şablonuna bir B konusu ekleyin.",
  "campaignStats.col.variant": "Konu",
  "campaignStats.col.sent": "Gönderilen",
  "campaignStats.col.replied": "Yanıt",
  "campaignStats.col.replyRate": "Yanıt oranı",
  "campaignStats.col.opened": "Açılma",
  "campaignStats.variant.a": "Konu A",
  "campaignStats.variant.b": "Konu B",
  "campaignStats.opens.title": "Açılmalar",
  "campaignStats.opens.off":
    "Açılma izleme kapalı. İsterseniz Ayarlar → Açılma izleme bölümünden açabilirsiniz.",
  "campaignStats.opens.value": "{opened} / {sent} ileti açıldı",
  "campaignStats.opens.disclaimer":
    "Açılma verisi kesin değildir (görsel engelleme, otomatik ön yükleme).",
  "campaignStats.opens.demoOnly":
    "Bu sürümde açılmalar yalnızca demo kampanyalarda benzetimle sayılır; gerçek iletilere izleme eklenmez.",
  "campaignStats.openSettings": "Ayarlara git",

  "apiError.TEMPLATE_INFO_ONLY":
    "Bu şablon yalnızca bilgi amaçlıdır ve gönderimde kullanılamaz. Başka bir şablon seçin.",
  "apiError.TEMPLATE_NO_VARIANT_B": "Bu şablonun B konusu yok. Önce şablona bir B konusu ekleyin.",
  "apiError.CATEGORY_TEMPLATE_MISMATCH":
    "Kategori şablonunun dili veya türü adımla uyuşmuyor. Aynı dilde ve türde bir şablon seçin.",
} as const;
