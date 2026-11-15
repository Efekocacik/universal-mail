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
   * şablonları kullanıcı arşivlemiş/silmiş olsa bile yeniden eklenmez. Sürüm 3 (Faz 5): yeni diller ve kategori
   * varyantları, yine yalnızca EKSİK olanlar.
   */
  since: 1 | 2 | 3;
  /** Faz 5: A/B denemesinin ikinci konusu (yalnızca ilk e-posta). */
  subjectB?: string;
}

export { INFO_ONLY_LANGUAGES, isInfoOnlyLanguage } from "./info-only";

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
  /*
   * Faz 5 (seed 3): yeni diller (ilk e-posta + bir takip) ve TR/EN kafe ve bar/pub varyantları (A/B için ikinci
   * konu). Kurallar Faz 3/4 ile aynı: Google değişkeni yok, `{{kisisel_giris}}` yok, takipte "Re:" yok. Almanca
   * şablonlar yalnızca bilgi amaçlıdır (`INFO_ONLY_LANGUAGES`): gönderimde kullanılamaz.
   */
  {
    name: "Vorstellung – erste E-Mail (DE)",
    language: "de",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Verbrauchsmaterial für Cafés und Restaurants",
    bodyText: `Guten Tag,

wir sind auf Ihren Betrieb in {{sehir}} aufmerksam geworden und möchten uns kurz vorstellen.

{{firma}} beliefert Cafés, Restaurants und ähnliche Betriebe mit täglichem Verbrauchsmaterial wie Servietten, Tischsets, Feuchttüchern und Einwegbesteck. Wir bieten passende Produktoptionen und eine regelmäßige Belieferung.

Bei Interesse senden wir Ihnen gern unseren Katalog und unsere Preise.

Mit freundlichen Grüßen
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Nachfass 1 – kurze Erinnerung (DE)",
    language: "de",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Kurze Erinnerung an unser Angebot",
    bodyText: `Guten Tag,

wir hatten Ihnen kürzlich im Namen von {{firma}} zum Thema Verbrauchsmaterial für die Gastronomie geschrieben.

Gern senden wir Ihnen Katalog und Preise für Servietten, Tischsets, Feuchttücher und Einwegbesteck. Antworten Sie dazu einfach auf diese E-Mail.

Falls kein Interesse besteht, können Sie sich über den Link unten abmelden.

Mit freundlichen Grüßen
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Présentation – premier e-mail (FR)",
    language: "fr",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Fournitures pour cafés et restaurants",
    bodyText: `Bonjour,

Nous avons remarqué votre établissement à {{sehir}} et souhaitions vous présenter notre entreprise.

{{firma}} fournit aux cafés, restaurants et établissements similaires des consommables du quotidien : serviettes, sets de table, lingettes humides et couverts jetables. Nous proposons des produits et des solutions d'approvisionnement adaptés à chaque établissement.

Si cela vous intéresse, nous serons heureux de vous transmettre notre catalogue et nos tarifs.

Cordialement,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Relance 1 – court rappel (FR)",
    language: "fr",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Petit rappel concernant notre offre",
    bodyText: `Bonjour,

Nous vous avons récemment écrit de la part de {{firma}} au sujet de l'approvisionnement en consommables pour cafés et restaurants.

Nous pouvons vous envoyer notre catalogue et nos tarifs pour les serviettes, sets de table, lingettes et couverts jetables. Il vous suffit de répondre à cet e-mail.

Si cela ne vous concerne pas, vous pouvez vous désinscrire grâce au lien ci-dessous.

Cordialement,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Presentación – primer correo (ES)",
    language: "es",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Suministros para cafeterías y restaurantes",
    bodyText: `Hola:

Hemos conocido su negocio en {{sehir}} y queríamos presentarle nuestra empresa.

En {{firma}} suministramos a cafeterías, restaurantes y negocios similares consumibles de uso diario como servilletas, manteles individuales de papel, toallitas húmedas y cubiertos desechables. Ofrecemos opciones de producto y soluciones de suministro adaptadas a cada negocio.

Si le interesa, con gusto le enviaremos nuestro catálogo y nuestros precios.

Saludos cordiales,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Seguimiento 1 – breve recordatorio (ES)",
    language: "es",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Un breve recordatorio sobre nuestra oferta",
    bodyText: `Hola:

Hace poco le escribimos desde {{firma}} sobre el suministro de consumibles para cafeterías y restaurantes.

Podemos enviarle nuestro catálogo y los precios de servilletas, manteles individuales, toallitas húmedas y cubiertos desechables. Si le resulta útil, basta con responder a este correo.

Si no le interesa, puede darse de baja con el enlace de abajo.

Saludos cordiales,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Presentazione – prima e-mail (IT)",
    language: "it",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Forniture per bar e ristoranti",
    bodyText: `Buongiorno,

abbiamo notato la vostra attività a {{sehir}} e desideriamo presentarvi la nostra azienda.

{{firma}} fornisce a bar, ristoranti e attività simili materiali di consumo quotidiano come tovaglioli, tovagliette di carta, salviette umidificate e posate monouso. Offriamo prodotti e soluzioni di fornitura adatti alle esigenze di ogni attività.

Se siete interessati, saremo lieti di inviarvi il nostro catalogo e il listino prezzi.

Cordiali saluti,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Promemoria 1 – breve sollecito (IT)",
    language: "it",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Un breve promemoria sulla nostra offerta",
    bodyText: `Buongiorno,

di recente vi abbiamo scritto da parte di {{firma}} riguardo alla fornitura di materiali di consumo per bar e ristoranti.

Possiamo inviarvi catalogo e prezzi di tovaglioli, tovagliette, salviette umidificate e posate monouso. Se vi interessa, è sufficiente rispondere a questa e-mail.

Se non siete interessati, potete annullare l'iscrizione con il link qui sotto.

Cordiali saluti,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Kennismaking – eerste e-mail (NL)",
    language: "nl",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Verbruiksartikelen voor cafés en restaurants",
    bodyText: `Goedendag,

Wij kwamen uw zaak in {{sehir}} tegen en willen ons graag kort voorstellen.

{{firma}} levert cafés, restaurants en vergelijkbare zaken dagelijkse verbruiksartikelen, zoals servetten, placemats, vochtige doekjes en wegwerpbestek. Wij bieden productopties en leveringsoplossingen die passen bij de behoeften van elke zaak.

Als u interesse heeft, sturen wij u graag onze catalogus en prijzen.

Met vriendelijke groet,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Opvolging 1 – korte herinnering (NL)",
    language: "nl",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Een korte herinnering aan ons aanbod",
    bodyText: `Goedendag,

Wij schreven u onlangs namens {{firma}} over de levering van verbruiksartikelen voor cafés en restaurants.

Wij sturen u graag onze catalogus en prijzen voor servetten, placemats, vochtige doekjes en wegwerpbestek. Antwoord gewoon op deze e-mail.

Is dit niet relevant voor u? Dan kunt u zich afmelden via de link hieronder.

Met vriendelijke groet,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Apresentação – primeiro e-mail (PT)",
    language: "pt",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Fornecimento para cafés e restaurantes",
    bodyText: `Olá,

Encontrámos o seu estabelecimento em {{sehir}} e gostaríamos de apresentar a nossa empresa.

A {{firma}} fornece a cafés, restaurantes e estabelecimentos semelhantes consumíveis do dia a dia, como guardanapos, toalhetes de mesa em papel, toalhitas húmidas e talheres descartáveis. Oferecemos opções de produtos e soluções de fornecimento adaptadas às necessidades de cada negócio.

Se tiver interesse, teremos todo o gosto em partilhar o nosso catálogo e os nossos preços.

Com os melhores cumprimentos,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Seguimento 1 – breve lembrete (PT)",
    language: "pt",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Um breve lembrete sobre a nossa proposta",
    bodyText: `Olá,

Escrevemos-lhe recentemente em nome da {{firma}} sobre o fornecimento de consumíveis para cafés e restaurantes.

Podemos enviar-lhe o nosso catálogo e os preços de guardanapos, toalhetes de mesa, toalhitas húmidas e talheres descartáveis. Se for útil, basta responder a este e-mail.

Se não tiver interesse, pode cancelar a subscrição através da ligação abaixo.

Com os melhores cumprimentos,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Przedstawienie – pierwszy e-mail (PL)",
    language: "pl",
    categoryKey: null,
    kind: "initial",
    since: 3,
    subject: "Artykuły jednorazowe dla kawiarni i restauracji",
    bodyText: `Dzień dobry,

Natrafiliśmy na Państwa lokal w mieście {{sehir}} i chcielibyśmy przedstawić naszą firmę.

{{firma}} dostarcza kawiarniom, restauracjom i podobnym lokalom codzienne artykuły eksploatacyjne, takie jak serwetki, podkładki papierowe, chusteczki nawilżane i sztućce jednorazowe. Oferujemy produkty i rozwiązania dostaw dopasowane do potrzeb każdego lokalu.

W razie zainteresowania chętnie prześlemy nasz katalog i cennik.

Z poważaniem,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Przypomnienie 1 – krótka wiadomość (PL)",
    language: "pl",
    categoryKey: null,
    kind: "followup",
    since: 3,
    subject: "Krótkie przypomnienie o naszej ofercie",
    bodyText: `Dzień dobry,

Niedawno pisaliśmy do Państwa w imieniu {{firma}} w sprawie dostaw artykułów eksploatacyjnych dla kawiarni i restauracji.

Chętnie prześlemy katalog i cennik serwetek, podkładek, chusteczek nawilżanych i sztućców jednorazowych. Wystarczy odpowiedzieć na tę wiadomość.

Jeśli nie są Państwo zainteresowani, mogą Państwo zrezygnować z subskrypcji za pomocą linku poniżej.

Z poważaniem,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Kafeler için – ilk e-posta (TR)",
    language: "tr",
    categoryKey: "cafe",
    kind: "initial",
    since: 3,
    subject: "Kafeniz için peçete ve sarf malzemesi tedariki",
    subjectB: "{{sehir}} kafeleri için sarf malzemesi teklifi",
    bodyText: `Merhaba,

{{sehir}} bölgesindeki kafenizle iletişime geçmek istedik.

Biz {{firma}} olarak kafelere peçete, bardak altlığı, ıslak mendil, karıştırıcı çubuk ve tek kullanımlık çatal-bıçak gibi günlük sarf malzemelerinin tedarikini sağlıyoruz. Yoğun saatlerde stok sıkıntısı yaşamamanız için düzenli teslimat planı da sunuyoruz.

İlgilenmeniz durumunda kafelere özel ürün listemizi ve fiyatlarımızı paylaşmaktan memnuniyet duyarız.

İyi çalışmalar,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "Bar ve publar için – ilk e-posta (TR)",
    language: "tr",
    categoryKey: "pub",
    kind: "initial",
    since: 3,
    subject: "Bar ve publar için sarf malzemesi tedariki",
    subjectB: "İşletmeniz için peçete ve bardak altlığı teklifi",
    bodyText: `Merhaba,

{{sehir}} bölgesindeki işletmenizle iletişime geçmek istedik.

Biz {{firma}} olarak bar ve publara peçete, bardak altlığı, ıslak mendil ve tek kullanımlık servis ürünleri tedarik ediyoruz. Akşam yoğunluğunuza uygun, düzenli ve zamanında teslimat sağlıyoruz.

İlgilenirseniz ürün listemizi ve fiyatlarımızı sizinle paylaşabiliriz.

İyi çalışmalar,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "For cafés – first email (EN)",
    language: "en",
    categoryKey: "cafe",
    kind: "initial",
    since: 3,
    subject: "Napkins and consumables for your café",
    subjectB: "Consumables supply for cafés in {{sehir}}",
    bodyText: `Hello,

We came across your café in {{sehir}} and wanted to introduce our company.

At {{firma}}, we supply cafés with everyday consumables such as napkins, coasters, wet wipes, stirrers and disposable cutlery. We also offer a regular delivery plan so you don't run short during busy hours.

If you're interested, we'd be happy to share our café product list and pricing.

Best regards,
{{gonderen_ad}}
{{firma}}`,
  },
  {
    name: "For bars and pubs – first email (EN)",
    language: "en",
    categoryKey: "pub",
    kind: "initial",
    since: 3,
    subject: "Consumables supply for bars and pubs",
    subjectB: "Napkins and coasters for your venue",
    bodyText: `Hello,

We came across your venue in {{sehir}} and wanted to introduce our company.

At {{firma}}, we supply bars and pubs with napkins, coasters, wet wipes and disposable serving products, with regular deliveries that fit around your evening rush.

If that sounds useful, we'd be happy to share our product list and pricing.

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
