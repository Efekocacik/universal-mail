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
}

export const BUILTIN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    name: "Tanıtım – ilk e-posta (TR)",
    language: "tr",
    categoryKey: null,
    kind: "initial",
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
    subject: "Supply solutions for cafés and restaurants",
    bodyText: `Hello,

We came across your business in {{sehir}} and wanted to introduce our company.

At {{firma}}, we supply cafés, restaurants and similar businesses with everyday consumables, including napkins, paper placemats, wet wipes and disposable cutlery. We offer product options and supply solutions tailored to the needs of each business.

If you're interested, we'd be happy to share our product catalogue and pricing information.

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
