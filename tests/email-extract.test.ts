import { domainToASCII } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyKind,
  domainMatchesSite,
  isDisposableDomain,
  isGenericLocal,
  parseEmail,
} from "@/lib/email/address";
import { matchesPattern } from "@/lib/email/robots";
import { fallbackPaths, languageForCountry, pickContactLinks } from "@/lib/email/candidates";
import { decodeCfEmail, extractPage, socialContact } from "@/lib/email/extract";

const URL0 = "https://www.example-cafe.test/";

const emailsOf = (html: string, url = URL0) =>
  extractPage(html, url)
    .emails.map((e) => `${e.email}:${e.sourceType}`)
    .sort();

/** cfemail kodlayıcı (test yardımcısı): anahtar bayt + XOR */
function cf(email: string, key = 0x42): string {
  return (
    key.toString(16).padStart(2, "0") +
    [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Sentetik site örnekleri: gerçek işletme sitelerinde sık görülen kalıplar (mailto, düz metin, JSON-LD, Cloudflare
 * koruması, gizlenmiş yazım, yer tutucular, platform gürültüsü). Gerçek sitelerin kopyası DEĞİLDİR.
 */
const FIXTURES: { name: string; html: string; url?: string; expect: string[] }[] = [
  {
    name: "01 altbilgide mailto",
    html: `<footer><a href="mailto:hello@bean-and-leaf.test">Email us</a></footer>`,
    expect: ["hello@bean-and-leaf.test:mailto"],
  },
  {
    name: "02 mailto sorgu parametreleriyle ve büyük harfle",
    html: `<a href="MAILTO:Bookings@The-Anchor-Pub.test?subject=Table%20booking&body=Hi">Book</a>`,
    expect: ["bookings@the-anchor-pub.test:mailto"],
  },
  {
    name: "03 düz metin iletişim paragrafı",
    html: `<p>Questions? Write to <strong>info@riverside-bistro.test</strong> or call us.</p>`,
    expect: ["info@riverside-bistro.test:text"],
  },
  {
    name: "04 birden çok adres",
    html: `<p>General: info@oak-hotel.test — Events: events@oak-hotel.test — Manager: sarah.jones@oak-hotel.test</p>`,
    expect: [
      "events@oak-hotel.test:text",
      "info@oak-hotel.test:text",
      "sarah.jones@oak-hotel.test:text",
    ],
  },
  {
    name: "05 JSON-LD LocalBusiness e-postası",
    html: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Bean","email":"contact@bean-roasters.test","sameAs":["https://www.instagram.com/beanroasters/"]}</script>`,
    expect: ["contact@bean-roasters.test:jsonld"],
  },
  {
    name: "06 JSON-LD @graph içinde iç içe contactPoint",
    html: `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Restaurant","contactPoint":[{"@type":"ContactPoint","email":"mailto:reservations@la-table.test"}]}]}</script>`,
    expect: ["reservations@la-table.test:jsonld"],
  },
  {
    name: "07 Cloudflare data-cfemail",
    html: `<a href="/cdn-cgi/l/email-protection"><span class="__cf_email__" data-cfemail="${cf("info@cloudy-cafe.test")}">[email&#160;protected]</span></a>`,
    expect: ["info@cloudy-cafe.test:cfemail"],
  },
  {
    name: "08 Cloudflare bağlantı biçimi",
    html: `<a href="/cdn-cgi/l/email-protection#${cf("team@cloud-office.test", 0x17)}">contact</a>`,
    expect: ["team@cloud-office.test:cfemail"],
  },
  {
    name: "09 [at] [dot] gizleme",
    html: `<p>Mail: owner [at] sunny-hostel [dot] test</p>`,
    expect: ["owner@sunny-hostel.test:obfuscated"],
  },
  {
    name: "10 (at) gizleme",
    html: `<p>contact(at)little-deli.test</p>`,
    expect: ["contact@little-deli.test:obfuscated"],
  },
  {
    name: "11 BÜYÜK harfli AT / DOT gizleme",
    html: `<p>Write: kontakt AT gasthof-sonne DOT test</p>`,
    expect: ["kontakt@gasthof-sonne.test:obfuscated"],
  },
  {
    name: "12 sıradan cümledeki 'at' adres sayılmaz",
    html: `<p>Come and see us at cafe.london any day, or meet at pub.com at nine.</p>`,
    expect: [],
  },
  {
    name: "13 görsel dosya adları adres sayılmaz",
    html: `<img src="logo@2x.png"><p>Our files: header@3x.jpg and sprite@2x.svg</p>`,
    expect: [],
  },
  {
    name: "14 yer tutucular elenir",
    html: `<input placeholder="your@email.com"><p>e.g. name@example.com or john.doe@mycompany-test.test</p>`,
    expect: [],
  },
  {
    name: "15 Sentry / Wix izleme adresleri elenir",
    html: `<script>var dsn="https://0123456789abcdef0123456789abcdef@sentry.wixpress.com/1";</script><p>0123456789abcdef0123456789abcdef@o123.ingest.sentry.io</p>`,
    expect: [],
  },
  {
    name: "16 Almanca Impressum",
    html: `<h1>Impressum</h1><p>Gasthaus Adler, Hauptstr. 1<br>Telefon: +49 30 123456<br>E-Mail: kontakt@gasthaus-adler.test</p>`,
    expect: ["kontakt@gasthaus-adler.test:text"],
  },
  {
    name: "17 Fransızca yasal bildirimler",
    html: `<h2>Mentions légales</h2><p>Courriel : contact@brasserie-du-port.test</p>`,
    expect: ["contact@brasserie-du-port.test:text"],
  },
  {
    name: "18 %40 ile kodlanmış mailto",
    html: `<a href="mailto:hola%40casa-paco.test">Escríbenos</a>`,
    expect: ["hola@casa-paco.test:mailto"],
  },
  {
    name: "19 virgülle ayrılmış çoklu mailto",
    html: `<a href="mailto:bar@lounge-nine.test, events@lounge-nine.test?subject=Hi">Contact</a>`,
    expect: ["bar@lounge-nine.test:mailto", "events@lounge-nine.test:mailto"],
  },
  {
    name: "20 noreply ve adres olmayan metin elenir",
    html: `<p>Automated mails come from no-reply@system-mailer.test; do not reply. Price: 5@2x</p>`,
    expect: [],
  },
  {
    name: "21 yalnızca <script> içindeki adres yok sayılır",
    html: `<script>const support = "ghost@only-in-script.test";</script><p>Nothing here</p>`,
    expect: [],
  },
  {
    name: "22 IDN alan adı punycode'a çevrilir",
    html: `<p>info@café-müller.test</p>`,
    expect: [`info@${domainToASCII("café-müller.test")}:text`],
  },
  {
    name: "23 aynı adres iki yerde: mailto kazanır",
    html: `<p>info@double-listed.test</p><a href="mailto:info@double-listed.test">mail</a>`,
    expect: ["info@double-listed.test:mailto"],
  },
  {
    name: "24 bozuk JSON-LD sayfayı bozmaz",
    html: `<script type="application/ld+json">{ not json </script><p>hello@still-works.test</p>`,
    expect: ["hello@still-works.test:text"],
  },
  {
    name: "25 İtalyanca sayfa",
    html: `<p>Per prenotazioni: prenotazioni@trattoria-bella.test | Tel. 02 1234567</p>`,
    expect: ["prenotazioni@trattoria-bella.test:text"],
  },
];

describe("e-posta çıkarma (sentetik site örnekleri)", () => {
  it.each(FIXTURES)("$name", ({ html, url, expect: want }) => {
    expect(emailsOf(html, url)).toEqual([...want].sort());
  });

  it("en az 20 örnek vardır", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  it("Cloudflare kodunu doğru çözer; bozuk girdide null döner", () => {
    expect(decodeCfEmail(cf("a@b.co", 0x7f))).toBe("a@b.co");
    expect(decodeCfEmail("zz")).toBeNull();
    expect(decodeCfEmail("abc")).toBeNull();
  });
});

describe("sosyal bağlantılar ve iletişim formu", () => {
  it("profil bağlantılarını alır; paylaşım/gönderi/intent bağlantılarını atar", () => {
    const html = `
      <a href="https://www.instagram.com/beanroasters/?hl=en">ig</a>
      <a href="https://instagram.com/p/ABC123/">post</a>
      <a href="https://www.facebook.com/beanroasters">fb</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="https://www.facebook.com/profile.php?id=1000123">fb2</a>
      <a href="https://www.linkedin.com/company/bean-roasters/">in</a>
      <a href="https://twitter.com/intent/tweet?text=x">tweet</a>
      <a href="https://x.com/beanroasters">x</a>
      <a href="https://www.tiktok.com/@beanroasters">tt</a>
      <a href="https://www.youtube.com/@beanroasters">yt</a>
      <a href="https://example.org/">other</a>`;
    const types = extractPage(html, URL0)
      .contacts.map((c) => `${c.type}:${c.url}`)
      .sort();
    expect(types).toEqual(
      [
        "facebook:https://www.facebook.com/beanroasters",
        "facebook:https://www.facebook.com/profile.php?id=1000123",
        "instagram:https://www.instagram.com/beanroasters/",
        "linkedin:https://www.linkedin.com/company/bean-roasters/",
        "tiktok:https://www.tiktok.com/@beanroasters",
        "twitter:https://x.com/beanroasters",
        "youtube:https://www.youtube.com/@beanroasters",
      ].sort(),
    );
    expect(socialContact("javascript:alert(1)")).toBeNull();
    expect(socialContact("not a url")).toBeNull();
  });

  it("sameAs bağlantıları da alınır", () => {
    const html = `<script type="application/ld+json">{"@type":"Restaurant","sameAs":["https://www.facebook.com/lataverna","https://www.tripadvisor.com/x"]}</script>`;
    expect(extractPage(html, URL0).contacts).toEqual([
      { type: "facebook", url: "https://www.facebook.com/lataverna" },
    ]);
  });

  it("mesaj alanlı formu iletişim formu sayar; bülten, arama ve giriş formlarını saymaz", () => {
    const contact = `<form action="/send"><input type="text" name="name"><input type="email" name="email"><textarea name="msg"></textarea></form>`;
    const newsletter = `<form class="newsletter"><input type="email"><textarea></textarea></form>`;
    const search = `<form role="search"><input type="text" name="q"></form>`;
    const login = `<form action="/login"><input type="email"><input type="password"></form>`;
    expect(extractPage(contact, URL0).hasContactForm).toBe(true);
    expect(extractPage(newsletter, URL0).hasContactForm).toBe(false);
    expect(extractPage(search, URL0).hasContactForm).toBe(false);
    expect(extractPage(login, URL0).hasContactForm).toBe(false);
  });

  it("görünür metin çok kısaysa (JavaScript ile oluşan site) textLength küçük kalır", () => {
    const spa = `<div id="root"></div><script src="/app.js"></script>`;
    expect(extractPage(spa, URL0).textLength).toBeLessThan(50);
  });
});

describe("e-posta sözdizimi ve sınıflandırma", () => {
  it("geçerli adresleri normalleştirir", () => {
    expect(parseEmail("  Info@Example-Cafe.TEST ")?.email).toBe("info@example-cafe.test");
    expect(parseEmail("<a.b+tag@sub.domain.co.uk>")?.domain).toBe("sub.domain.co.uk");
    expect(parseEmail("ünal@kafe.test")).toBeNull(); // yerel kısımda ASCII dışı: desteklenmez
  });

  it.each([
    "plain",
    "a@b",
    "a@@b.com",
    "a b@c.com",
    ".a@b.com",
    "a.@b.com",
    "a..b@c.com",
    "a@-b.com",
    "a@b-.com",
    "a@b.c",
    "a@1.2.3.4",
    "a@[1.2.3.4]",
    `${"x".repeat(65)}@b.com`,
    `a@${"x".repeat(64)}.com`,
  ])("geçersiz: %s", (raw) => {
    expect(parseEmail(raw)).toBeNull();
  });

  it("tür: genel / kişisel / bireysel sağlayıcı", () => {
    const k = (s: string) => classifyKind(parseEmail(s)!);
    expect(k("info@cafe.test")).toBe("generic");
    expect(k("Reservations@cafe.test")).toBe("generic");
    expect(k("kontakt@gasthaus.test")).toBe("generic");
    expect(k("info.london@cafe.test")).toBe("generic");
    expect(k("reservations2@cafe.test")).toBe("generic");
    expect(k("sarah.jones@cafe.test")).toBe("personal");
    expect(k("marco@trattoria.test")).toBe("personal");
    expect(k("annecafe@gmail.com")).toBe("consumer");
    expect(isGenericLocal("teamwork")).toBe(false);
  });

  it("alan adı siteyle eşleşmesi: www ve alt alan adı toleranslı", () => {
    expect(domainMatchesSite("cafe.test", "www.cafe.test")).toBe(true);
    expect(domainMatchesSite("mail.cafe.test", "cafe.test")).toBe(true);
    expect(domainMatchesSite("agency.test", "cafe.test")).toBe(false);
  });

  it("tek kullanımlık alan adları alt alan adlarıyla birlikte yakalanır", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("x.mailinator.com")).toBe(true);
    expect(isDisposableDomain("gmail.com")).toBe(false);
  });
});

describe("aday sayfalar", () => {
  it("ülkeye göre dil seçer", () => {
    expect(languageForCountry("DE")).toBe("de");
    expect(languageForCountry("fr")).toBe("fr");
    expect(languageForCountry("GB")).toBe("en");
    expect(languageForCountry(null)).toBe("en");
  });

  it("yedek yollar önce sayfa dilindedir ve yinelenmez", () => {
    const de = fallbackPaths("de");
    expect(de[0]).toBe("/impressum");
    expect(new Set(de).size).toBe(de.length);
    expect(fallbackPaths("fr")).toContain("/mentions-legales");
    expect(fallbackPaths("nl")[0]).toBe("/contact");
  });

  it("ana sayfa bağlantılarından iletişim sayfalarını puanlayıp seçer; dış ve alakasız bağlantıları atar", () => {
    const links = [
      { href: "https://www.cafe.test/menu", text: "Menu" },
      { href: "https://www.cafe.test/contact-us", text: "Contact us" },
      { href: "https://www.cafe.test/about", text: "Our story" },
      { href: "https://cafe.test/impressum", text: "Impressum" },
      { href: "https://other.test/contact", text: "Contact" },
      { href: "https://www.cafe.test/wp-admin/contact", text: "Contact" },
      { href: "https://www.cafe.test/files/contact.pdf", text: "Contact PDF" },
      { href: "https://www.cafe.test/blog/contact-the-barista", text: "Blog" },
    ];
    expect(pickContactLinks(links, "cafe.test")).toEqual([
      "https://www.cafe.test/contact-us",
      "https://cafe.test/impressum",
      "https://www.cafe.test/about",
    ]);
  });
});

describe("saldırgan içerik (hizmet engelleme) dayanıklılığı", () => {
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("'@' içermeyen 900 KB'lık uzun dize doğrusal sürede taranır", () => {
    const html = `<p>${"a".repeat(900_000)}</p>`;
    let out: ReturnType<typeof extractPage> | undefined;
    expect(time(() => (out = extractPage(html, URL0)))).toBeLessThan(1500);
    expect(out!.emails).toEqual([]);
  });

  it("çok sayıda '@', '[at]' ve ' AT ' işareti sınırlıdır ve hızlı bitirir", () => {
    for (const piece of ["x@", "x [at] ", "x AT "]) {
      const html = `<p>${piece.repeat(120_000)}</p>`;
      expect(time(() => extractPage(html, URL0))).toBeLessThan(2000);
    }
  });

  it("sınırdan uzun yerel kısım kesilip adres sayılmaz", () => {
    expect(emailsOf(`<p>${"q".repeat(120)}@long-local.test</p>`)).toEqual([]);
    expect(emailsOf(`<p>${"q".repeat(64)}@long-local.test</p>`)).toHaveLength(1);
  });

  it("robots.txt desenleri: iç içe '*' üstel geri izlemeye yol açmaz", () => {
    const evil = "/a" + "*a".repeat(40) + "*b";
    const path = "/" + "a".repeat(3000);
    expect(time(() => matchesPattern(evil, path))).toBeLessThan(500);
    expect(matchesPattern(evil, path)).toBe(false);
  });

  it("robots.txt desen eşleştirme doğruluğu", () => {
    const cases: [string, string, boolean][] = [
      ["/", "/anything", true],
      ["/contact", "/contact-us", true],
      ["/contact", "/about", false],
      ["/*.pdf$", "/a/b/menu.pdf", true],
      ["/*.pdf$", "/menu.pdf?x=1", false],
      ["/*.pdf", "/menu.pdf?x=1", true],
      ["/a*b*c", "/aXXbYYc", true],
      ["/a*b*c", "/aXXbYY", false],
      ["/private/", "/private", false],
      ["", "/x", true],
      ["/$", "/", true],
      ["/$", "/x", false],
      ["*/tmp", "/a/tmp", true],
    ];
    for (const [pattern, path, want] of cases)
      expect(matchesPattern(pattern, path), `${pattern} vs ${path}`).toBe(want);
  });
});
