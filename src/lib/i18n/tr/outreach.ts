/**
 * Paket E (gönderim, kampanya, takip adımları, posta kutusu sınırları) için yeni Türkçe anahtarlar.
 * Yalnızca E düzenler; karşılığı `en/outreach.ts`.
 */
export const outreach = {
  /* Posta kutusu günlük sınırı (Faz 4, hata c) */
  "mbx.empty": "Henüz posta kutusu yok. Aşağıdan Gmail adresinizi ekleyin.",
  "mbx.limits.edit": "Günlük sınır",
  "mbx.limits.title": "{label}: günlük gönderim sınırı",
  "mbx.limits.desc":
    "Bu kutudan bir günde en çok kaç e-posta gideceğini ve yeni kutunun her hafta ne kadar artacağını belirleyin.",
  "mbx.limits.dailyCap": "Günlük en fazla e-posta",
  "mbx.limits.dailyCap.hint": "1 ile {max} arasında bir sayı.",
  "mbx.limits.dailyCap.hintConsumer":
    "Kişisel Gmail için 1 ile {max} arasında bir sayı. Google kişisel hesaplarda daha düşük sınır uygular.",
  "mbx.limits.warmupStep": "Haftalık artış (ısınma)",
  "mbx.limits.warmupStep.hint":
    "Yeni kutu ilk hafta günde {base} e-postayla başlar; her hafta bu kadar artar (0 ile {max} arası). 0 girerseniz artış olmaz.",
  "mbx.limits.preview":
    "Bugün en çok {today} · bir hafta sonra {week} · yaklaşık {weeks} hafta sonra günde {target} e-postaya ulaşır.",
  "mbx.limits.preview.reached": "Bugün en çok {today} e-posta; kutu üst sınırına ulaştı.",
  "mbx.limits.preview.flat":
    "Bugün en çok {today} e-posta. Haftalık artış 0 olduğu için bu sayı artmaz.",
  "mbx.limits.consumerWarning":
    "Kişisel Gmail'de günde {risk} üstü gönderim hesabın Google tarafından kısıtlanma riskini artırır. En çok {max} girilebilir.",
  "mbx.limits.rules":
    "Sınırlar her e-postadan önce yeniden denetlenir: iki e-posta arasında en az 90 saniye beklenir ve hiçbir kutu günde {max} e-postayı geçmez. Günler UTC'ye göre (TSİ 03:00) yenilenir.",
  "mbx.limits.save": "Kaydet",
  "mbx.limits.saved": "Günlük sınır kaydedildi.",
  "mbx.limits.conflict":
    "Bu kutu başka bir yerde değiştirildi. Güncel değerler yüklendi; yeniden kontrol edip kaydedin.",
  "mbx.limits.error.integer": "Tam sayı girin.",
  "mbx.limits.error.min": "En az {min} olmalı.",
  "mbx.limits.error.aboveMax": "Bu kutu için en çok {max} olabilir.",
  /* Sihirbaz: posta kutusu tavanı, yerel taslak, takip */ "wizard.capAboveMailbox":
    "Seçili posta kutusu bugün en çok {n} e-posta gönderebilir (ısınma). Kutu ısındıkça bu sayı artar; gönderimde küçük olan uygulanır.",
  "wizard.capAboveMailboxMax":
    "Seçili posta kutusu günde en çok {n} e-posta gönderebilir; kampanya sınırına ulaşılamaz. Kutunun sınırını Ayarlar → Posta kutuları bölümünden görebilirsiniz.",
  "wizard.draft.offer":
    "Bu kampanyada kaydedilmemiş değişiklikleriniz bulundu ({at}). Geri yüklemek ister misiniz?",
  "wizard.draft.restore": "Geri yükle",
  "wizard.draft.discard": "Sil",
  "wizard.draft.restored":
    "Kaydedilmemiş değişiklikler geri yüklendi. Saklamak için “Kaydet”e basın.",
  "wizard.steps.noFollowupV2":
    "Henüz takip şablonu yok; kampanya tek e-postalık çalışır. Şablonlar sayfasından bir takip şablonu ekleyebilirsiniz.",
  "queue.reevaluate.closed":
    "{n} alıcı hariç tutuldu. Kampanya başladığı için gönderim listesi sabitlendi; bu alıcılar burada yeniden denetlenemez. Gerekçe giderildiyse onları yeni bir kampanyaya ekleyin.",
  "reason.inbound_review_pending":
    "Bu kişiden gelen yanıt incelemede; karar verilene kadar takip e-postası gönderilmez",
  "queue.reviewHold.go": "İncelemeye git",
  /* Şablon düzenleyici: takip konusu (9d) */ "tplEditor.reuseSubject":
    "İlk e-postanın konusunu kullan (Re: …)",
  "tplEditor.reuseSubject.hint":
    "Önerilir. Takip e-postası ilk e-postayla aynı konuşmada görünür; alıcı onu “Re: <ilk konu>” olarak görür.",
  "tplEditor.subject.reuseHint":
    "Bu takipte alıcı ilk e-postanın konusunu görür. Buradaki konu yalnızca ilk konu bulunamazsa kullanılır.",
  /* Başlatma özeti: takip adımları (9c) */ "preflight.step.group": "Önizlenecek adım",
  "preflight.step.initial": "İlk e-posta",
  "preflight.step.followup": "{n}. adım · +{days} gün",
  "preflight.step.errors": "Bu adım bu alıcıya gönderilemez: {reasons}. Şablonu düzeltin.",
  "preflight.check.followups":
    "Takiplerle birlikte en çok {total} e-posta. Son takip ilk e-postadan en az {after} gün sonra gider; tamamı yaklaşık {days} gün sürer (yanıt verenlere takip gitmez).",
  "preflight.advisory.followup_missing_variables":
    "Önizlenen {n} alıcının takip e-postasında eksik bilgi var. Gönderimde bu kişilerin takibi durur; şablonu veya işletme bilgisini tamamlayın.",
  "preflight.advisory.followup_compose_error":
    "Önizlenen {n} alıcının takip e-postası hazırlanamadı. Takip şablonunu açıp sorunu düzeltin; aksi hâlde takip gönderilmez.",
} as const;
