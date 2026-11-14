/**
 * Paket A (Faz 5): yapay zekâ kartı, maliyet notu, kişisel giriş paneli, harici e-posta (Snov) kartı ve `apiError.AI_*` / `INTRO_*` / `EXTERNAL_*`. Hunter anahtarları base.ts'te kalır. P0 başlattı; sonrasında yalnızca A düzenler.
 * Karşılığı `en/ai.ts`.
 */
export const ai = {
  "ai.settings.title": "Yapay zekâ ile kişisel giriş",
  "ai.settings.desc":
    "Claude, her işletme için kısa bir giriş cümlesi taslağı yazar. Hiçbir cümle sizin onayınız olmadan kullanılmaz.",
  "ai.intro.title": "Kişisel giriş",
  "ai.settings.enable": "Kişisel giriş taslakları üret",
  "ai.settings.enable.hint":
    'Açıkken lead ayrıntısında "Oluştur" düğmesi görünür. Taslaklar siz onaylayana kadar hiçbir e-postada kullanılmaz.',
  "ai.settings.model": "Model",
  "ai.settings.model.opus": "Claude Opus 5.5 (önerilen)",
  "ai.settings.model.haiku": "Claude Haiku 5.5 (çok daha ucuz)",
  "ai.settings.model.hint": "Model değişikliği yalnızca bundan sonra üretilen girişleri etkiler.",
  "ai.settings.costNote":
    "Her giriş Claude API'ye bir istek gönderir: seçili modelle giriş başına yaklaşık {cost}. Ücreti Anthropic hesabınızdan ödersiniz; Google bütçe sınırına sayılmaz.",
  "ai.settings.privacy":
    "Claude'a yalnızca görünen ad, şehir, kategori ve işletmenin kendi ana sayfasındaki görünür metin gider. Google verisi, e-posta adresleri, telefonlar ve notlar asla gönderilmez.",
  "ai.settings.demoNote":
    "Demo kipi: girişler örnek kalıplardan üretilir; Claude'a istek gitmez, anahtar ve ücret gerekmez.",
  "ai.settings.confirm.title": "Yapay zekâ girişleri açılsın mı?",
  "ai.settings.confirm.ok": "Maliyeti anladım, aç",
  "ai.settings.ackedAt": "Maliyet notunu {date} tarihinde onayladınız.",
  "ai.settings.key.help":
    "console.anthropic.com → API Keys bölümünden alınır. Anahtar bu bilgisayarda şifreli saklanır.",
  "ai.settings.test": "Anahtarı dene",
  "ai.settings.test.ok": "Anahtar geçerli; {model} kullanılabilir.",
  "ai.settings.test.demo": "Demo kipi: anahtar denenmedi, ağa çıkılmadı.",
  "ai.settings.usage.title": "Bu ayki kullanım ({month})",
  "ai.settings.usage.requests": "İstek",
  "ai.settings.usage.tokens": "Belirteç (giriş / çıkış)",
  "ai.settings.usage.cost": "Tahmini maliyet",
  "ai.intro.help":
    "Şablondaki kisisel_giris değişkeninin değeri. E-postada yalnızca onayladığınız metin kullanılır; onaylı metin yoksa yedek metin kullanılır veya ileti gönderilmez.",
  "ai.intro.language": "Giriş dili",
  "ai.intro.generate": "Oluştur",
  "ai.intro.regenerate": "Yeniden oluştur",
  "ai.intro.disabled": "Yapay zekâ girişleri kapalı.",
  "ai.intro.enableLink": "Ayarlar'da aç",
  "ai.intro.empty": 'Bu dil için henüz giriş yok. "Oluştur" ile bir taslak hazırlayın.',
  "ai.intro.status.draft": "Onay bekliyor",
  "ai.intro.status.approved": "Onaylandı",
  "ai.intro.status.rejected": "Reddedildi",
  "ai.intro.textLabel": "Giriş metni",
  "ai.intro.textHint":
    "1–2 cümle, en çok 300 karakter; bağlantı, e-posta, telefon, yıl veya yüzde içermemeli.",
  "ai.intro.chars": "{n}/300 karakter",
  "ai.intro.save": "Değişikliği kaydet",
  "ai.intro.approve": "Onayla",
  "ai.intro.reject": "Reddet",
  "ai.intro.never": "Onaylamadığınız hiçbir metin gönderilmez.",
  "ai.intro.meta": "{model} · tahmini {cost}",
  "ai.intro.meta.demo": "Demo metni · ücretsiz",
  "ai.intro.toast.generated": "Taslak hazır. Okuyun, gerekirse düzeltin ve onaylayın.",
  "ai.intro.toast.approved": "Giriş onaylandı; bu dildeki e-postalarda kullanılacak.",
  "ai.intro.toast.rejected": "Giriş reddedildi.",
  "ai.intro.toast.saved": "Değişiklik kaydedildi. Kullanılması için yeniden onaylayın.",
  "ai.external.title": "Harici servisle e-posta bul (Hunter veya Snov)",
  "ai.external.help":
    "Varsayılan kapalıdır. Açıkken, web sitesinde adres bulunamayan işletmelerin yalnızca alan adı seçtiğiniz servise gönderilir; her arama o servisin kotasından düşer. Bulunan adresler aynı doğrulamadan ve engelleme listesinden geçer (alan adı başına en çok 5 adres). Aramada onay penceresinden ayrıca seçmeniz gerekir.",
  "ai.external.provider": "Servis",
  "ai.external.provider.hunter": "Hunter.io",
  "ai.external.provider.snov": "Snov.io",
  "ai.external.snovId.help":
    "snov.io → Account settings → API bölümündeki User ID (istemci kimliği).",
  "ai.external.snovSecret.help":
    "Aynı bölümdeki API Secret (istemci sırrı). Bu bilgisayarda şifreli saklanır.",
  "ai.external.demoNote":
    "Demo kipi: servise istek gitmez; yalnızca .example alan adları için örnek adres döner.",
  "ai.external.resetDate": "Kota yenilenme tarihi: {date}",
  "ai.external.demoQuota": "Demo kipi: örnek kota {n} (ağa çıkılmadı).",
  "apiError.AI_DISABLED": "Yapay zekâ girişi kapalı. Ayarlar → Yapay zekâ bölümünden açın.",
  "apiError.AI_KEY_MISSING":
    "Claude API anahtarı girilmemiş. Ayarlar → Yapay zekâ bölümüne ekleyin.",
  "apiError.AI_COST_ACK_REQUIRED": "Önce maliyet notunu onaylayın (Ayarlar → Yapay zekâ).",
  "apiError.AI_NO_CONTEXT":
    "Bu işletme için yeterli bilgi yok. Önce ad, şehir veya kategori ekleyin.",
  "apiError.AI_AUTH": "Claude API anahtarı reddedildi. Anahtarı kontrol edip yeniden girin.",
  "apiError.AI_RATE_LIMITED":
    "Claude şu an çok fazla istek alıyor. Bir dakika sonra yeniden deneyin.",
  "apiError.AI_UPSTREAM": "Claude'a şu an ulaşılamıyor. Biraz sonra yeniden deneyin.",
  "apiError.AI_REFUSED": "Claude bu işletme için giriş yazmadı. Metni kendiniz yazabilirsiniz.",
  "apiError.AI_TRUNCATED": "Claude'un yanıtı yarıda kesildi. Yeniden deneyin.",
  "apiError.AI_OUTPUT_INVALID":
    "Üretilen metin kurallara uymadı (1–2 cümle, bağlantı veya rakam yok). Yeniden deneyin veya kendiniz yazın.",
  "apiError.INTRO_TEXT_INVALID":
    "Giriş metni 1–2 cümle olmalı; bağlantı, e-posta, telefon, rakam veya {{ }} içermemeli.",
  "apiError.EXTERNAL_KEY_MISSING":
    "Harici e-posta servisi için anahtar girilmemiş. Ayarlar → E-posta bulma bölümüne ekleyin.",
  "apiError.EXTERNAL_AUTH":
    "Harici e-posta servisi anahtarı reddetti. Anahtarı kontrol edip yeniden girin.",
  "apiError.EXTERNAL_QUOTA":
    "Harici e-posta servisinin aylık kotası doldu. Kota yenilenince yeniden deneyin.",
  "apiError.EXTERNAL_RATE":
    "Harici e-posta servisi çok fazla istek aldı. Bir dakika sonra yeniden deneyin.",
  "apiError.EXTERNAL_NETWORK":
    "Harici e-posta servisine ulaşılamıyor. İnternet bağlantınızı kontrol edip yeniden deneyin.",
} as const;
