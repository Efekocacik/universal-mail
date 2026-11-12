/**
 * Hazır başlangıç şablonları (SRS FR-TPL-08, Ek A/B'den uyarlanmıştır).
 *
 * Ek A/B'den bilinçli farklar:
 *  - `{{isletme_adi}}` kullanılmaz: işletme adı Google içeriğidir ve kalıcı saklanmaz; hazır şablon Google verisine
 *    bağlı kalmadan her lead için eksiksiz çıkmalıdır. Kullanıcı isterse kendi şablonuna ekleyebilir.
 *  - `{{kisisel_giris}}` kullanılmaz (yapay zekâ ile giriş Faz 5'tir, varsayılan kapalıdır).
 *  - Adres, telefon, sicil/vergi bilgisi ve çıkış bağlantısı gövdede yer almaz: zorunlu alt bilgi olarak gönderimde
 *    sistem tarafından eklenir ve kullanıcı tarafından kaldırılamaz (FR-TPL-06, FR-CMPL-08).
 */
export interface BuiltInTemplate {
  name: string;
  language: string;
  categoryKey: string | null;
  kind: "initial" | "followup";
  subject: string;
  bodyText: string;
  /**
   * Şablonun eklendiği seed sürümü (`seed.ts`). Sürüm 2 (Faz 4) yalnızca eksik takip şablonlarını ekler; sürüm 1
   * şablonları kullanıcı arşivlemiş/silmiş olsa bile yeniden eklenmez.
   */
  since: 1 | 2;
}

export const BUILTIN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    name: "Tanıtım – ilk e-posta (TR)",
    language: "tr",
    categoryKey: null,
    kind: "initial",
    since: 1,
    subject: "Kafe ve restoranlar için sarf malzemesi tedarik teklifi",
    bodyText: `Merhaba,

{{sehir}} bölgesindeki işletmenizle iletişime geçmek istedik.

Biz {{firma}} olarak kafe, restoran ve benzeri işletmelere peçete, amerikan servis, ıslak mendil ve tek kullanımlık çatal-bıçak gibi günlük sarf malzemelerinin tedarikini sağlıyoruz. İşletmelerin ihtiyaçlarına uygun ürün seçenekleri ve düzenli tedarik çözümleri sunuyoruz.

İlgilenmeniz durumunda ürün kataloğumuzu ve fiyat bilgilerimizi sizinle paylaşmaktan memnuniyet duyarız.

İyi çalışmalar,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Introduction – first email (EN)",
    language: "en",
    categoryKey: null,
    kind: "initial",
    since: 1,
    subject: "Supply solutions for cafés and restaurants",
    bodyText: `Hello,

We came across your business in {{sehir}} and wanted to introduce our company.

At {{firma}}, we supply cafés, restaurants and similar businesses with everyday consumables, including napkins, paper placemats, wet wipes and disposable cutlery. We offer product options and supply solutions tailored to the needs of each business.

If you're interested, we'd be happy to share our product catalogue and pricing information.

Best regards,
{{gonderen_ad}}
{{firma}}`,
  },
  /*
   * Faz 4 (9b) takip şablonları. Kurallar: Google değişkeni yok, "Re:" öneki yok (konu devamını gönderim tarafı
   * `followup_reuse_subject` ile kendisi yapar), en çok ~80 kelime, saygılı ve çıkışı kolay bir ton. Çıkış bağlantısı
   * zorunlu alt bilgide her zaman yer alır.
   */
  {
    name: "Takip 1 – kısa hatırlatma (TR)",
    language: "tr",
    categoryKey: null,
    kind: "followup",
    since: 2,
    subject: "Sarf malzemesi teklifimizle ilgili kısa bir hatırlatma",
    bodyText: `Merhaba,

Kısa süre önce {{firma}} olarak kafe ve restoranlar için sarf malzemesi tedarikiyle ilgili size yazmıştık.

Peçete, amerikan servis, ıslak mendil ve tek kullanımlık çatal-bıçak ihtiyaçlarınız için ürün kataloğumuzu ve fiyatlarımızı paylaşabiliriz. İlgilenirseniz bu e-postayı yanıtlamanız yeterli.

İlginizi çekmiyorsa sorun değil; alttaki bağlantıyla listeden çıkabilirsiniz.

İyi çalışmalar,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Takip 2 – son nazik not (TR)",
    language: "tr",
    categoryKey: null,
    kind: "followup",
    since: 2,
    subject: "Son bir not: sarf malzemesi tedariki",
    bodyText: `Merhaba,

Daha önce sarf malzemesi tedarikiyle ilgili size yazmıştık. Bu konuda size göndereceğimiz son e-posta bu.

İleride peçete, ıslak mendil veya tek kullanımlık ürünlere ihtiyacınız olursa bu e-postayı yanıtlayarak bize her zaman ulaşabilirsiniz.

Zaman ayırdığınız için teşekkür ederiz.

İyi çalışmalar,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Follow-up 1 – short reminder (EN)",
    language: "en",
    categoryKey: null,
    kind: "followup",
    since: 2,
    subject: "A quick reminder about our supply offer",
    bodyText: `Hello,

We recently wrote to you from {{firma}} about supplying cafés and restaurants with everyday consumables.

We'd be glad to share our catalogue and prices for napkins, paper placemats, wet wipes and disposable cutlery. If that sounds useful, simply reply to this email.

If it's not relevant to you, no problem; you can unsubscribe with the link below.

Best regards,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Follow-up 2 – final note (EN)",
    language: "en",
    categoryKey: null,
    kind: "followup",
    since: 2,
    subject: "One last note about consumables supply",
    bodyText: `Hello,

We wrote to you earlier about consumables supply. This is the last email we will send you on this topic.

If you ever need napkins, wet wipes or disposable products in the future, you can always reach us by replying to this email.

Thank you for your time.

Best regards,
{{gonderen_ad}}
{{firma}}`,
  },
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Düz metni basit HTML'e çevirir: boş satır → paragraf, tek satır sonu → `<br>`. Değişkenler korunur. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("\n");
}
