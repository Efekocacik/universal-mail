/**
 * Paket A (Faz 5): yapay zekâ kartı, maliyet notu, kişisel giriş paneli, harici e-posta (Snov) kartı ve `apiError.AI_*` / `INTRO_*` / `EXTERNAL_*`. Hunter anahtarları base.ts'te kalır. P0 başlattı; sonrasında yalnızca A düzenler.
 * Karşılığı `en/ai.ts`.
 */
export const ai = {
  "ai.settings.title": "Yapay zekâ ile kişisel giriş",
  "ai.settings.desc":
    "Claude, her işletme için kısa bir giriş cümlesi taslağı yazar. Hiçbir cümle sizin onayınız olmadan kullanılmaz.",
  "ai.intro.title": "Kişisel giriş",
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
