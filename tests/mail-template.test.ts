import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, textToHtml } from "@/lib/mail/builtin-templates";
import { checkContent } from "@/lib/mail/content-check";
import {
  buildFooter,
  DEMO_UNSUBSCRIBE_BASE,
  FooterError,
  isSafeLiveUnsubscribeUrl,
  type SenderProfile,
} from "@/lib/mail/footer";
import { htmlToText, sanitizeEmailHtml } from "@/lib/mail/html";
import { pickTemplateLanguage, SUPPORTED_LANGUAGES, suggestLanguage } from "@/lib/mail/language";
import {
  headerSafe,
  parseTemplateText,
  renderTemplate,
  TemplateRenderError,
  validateTemplate,
  type TemplateIssueCode,
} from "@/lib/mail/template-engine";

/** Saf modüller: veritabanı ve ağ yok. */

const PROFILE: SenderProfile = {
  legalName: "Örnek Dış Ticaret A.Ş.",
  address: "Örnek Mah. 1, İstanbul",
  taxId: "1234567890",
  phone: "+90 212 000 00 00",
  contactName: "Ayşe Yılmaz",
};

const LS = String.fromCharCode(0x2028);

function codes(issues: { code: string }[]): string[] {
  return issues.map((i) => i.code).sort();
}

function draft(over: Partial<Parameters<typeof validateTemplate>[0]> = {}) {
  return {
    name: "Deneme",
    language: "tr",
    kind: "initial",
    subject: "Kafe ve restoranlar için tedarik",
    bodyHtml: "<p>Merhaba, {{sehir|bölgenizdeki}} işletmenize ulaşmak istedik.</p>",
    ...over,
  };
}

/* ------------------------------------------------------------------------------------------------ */

describe("şablon ayrıştırma ve doğrulama", () => {
  it("hazır şablonlar doğrulamadan uyarısız ve anlamı değişmeden geçer", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const html = textToHtml(t.bodyText);
      const v = validateTemplate({ ...t, bodyHtml: html });
      expect(v.errors, t.name).toEqual([]);
      expect(v.warnings, t.name).toEqual([]);
      // Yalnızca kaçış biçimi farklı olabilir (&#39; → '); metin aynıdır.
      expect(htmlToText(v.sanitizedHtml), t.name).toBe(htmlToText(html));
      expect(htmlToText(v.sanitizedHtml), t.name).toBe(t.bodyText.replace(/\n\n+/g, "\n\n"));
    }
  });

  it("değişkenleri ve yedek metinleri ayrıştırır", () => {
    expect(parseTemplateText("A {{ sehir }} B {{firma|Firmamız}}", "body")).toEqual({
      tokens: [
        { type: "text", value: "A " },
        { type: "var", name: "sehir", fallback: null },
        { type: "text", value: " B " },
        { type: "var", name: "firma", fallback: "Firmamız" },
      ],
      errors: [],
    });
  });

  it.each<[string, TemplateIssueCode]>([
    ["{{bilinmeyen}}", "unknown_variable"],
    ["{{Sehir}}", "unknown_variable"],
    ["{{acilis_tarihi}}", "unsupported_variable"],
    ["{{kisisel_giris}}", "unsupported_variable"],
    ["{{sehir", "unclosed_variable"],
    ["{{sehir {{firma}}", "unclosed_variable"],
    ["sehir}}", "stray_braces"],
    ["{{}}", "empty_variable"],
    ["{{ | yedek }}", "empty_variable"],
    ["{{sehir|}}", "invalid_fallback"],
    ["{{sehir|<b>x</b>}}", "invalid_fallback"],
    [`{{sehir|${"x".repeat(81)}}}`, "invalid_fallback"],
  ])("gövdede %s → %s", (body, code) => {
    const v = validateTemplate(draft({ bodyHtml: `<p>Merhaba ${body}</p>` }));
    expect(v.ok).toBe(false);
    expect(codes(v.errors)).toContain(code);
  });

  it("konu ve meta alan kuralları", () => {
    expect(codes(validateTemplate(draft({ subject: "  " })).errors)).toContain("required");
    expect(codes(validateTemplate(draft({ subject: "a\nBcc: x@y.example" })).errors)).toContain(
      "subject_newline",
    );
    expect(codes(validateTemplate(draft({ subject: "x".repeat(151) })).errors)).toContain(
      "too_long",
    );
    expect(codes(validateTemplate(draft({ subject: "{{acilis_tarihi}}" })).errors)).toContain(
      "unsupported_variable",
    );
    expect(codes(validateTemplate(draft({ language: "xx" })).errors)).toEqual(["invalid_language"]);
    expect(codes(validateTemplate(draft({ kind: "reminder" })).errors)).toEqual(["invalid_kind"]);
    expect(codes(validateTemplate(draft({ name: "" })).errors)).toEqual(["required"]);
  });

  it("değişken yalnızca metin içinde kullanılabilir (etiket/özellik içinde değil)", () => {
    const v = validateTemplate(
      draft({ bodyHtml: '<p><a href="{{cikis_linki}}">çıkış</a> metin</p>' }),
    );
    expect(codes(v.errors)).toContain("variable_in_tag");
  });

  it("temizlemeden sonra boş kalan gövde reddedilir; temizlenen öğeler uyarı olarak raporlanır", () => {
    expect(
      codes(validateTemplate(draft({ bodyHtml: "<script>alert(1)</script>" })).errors),
    ).toContain("required");
    const v = validateTemplate(
      draft({
        bodyHtml:
          '<p style="color:red" onclick="x()">Merhaba</p><img src="https://t.example/p.gif">',
      }),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([
      { field: "body", code: "html_sanitized", detail: "img,p[onclick],p[style]" },
    ]);
    expect(v.sanitizedHtml).toBe("<p>Merhaba</p>");
  });

  it("gövde boyut sınırı", () => {
    const v = validateTemplate(draft({ bodyHtml: `<p>${"a".repeat(50_001)}</p>` }));
    expect(codes(v.errors)).toContain("too_long");
  });

  it("girdi nesnesi değiştirilmez", () => {
    const input = draft({ bodyHtml: '<p onclick="x()">Merhaba</p>' });
    const copy = structuredClone(input);
    validateTemplate(input);
    expect(input).toEqual(copy);
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("değişken doldurma", () => {
  const tpl = {
    subject: "{{kategori}} işletmeleri için teklif",
    bodyHtml: "<p>Merhaba {{isletme_adi}}</p><p>{{sehir|bölgenizdeki}} işletmenize</p>",
  };

  it("değerleri yerleştirir; HTML'de kaçışlar, konuda tek satıra indirir", () => {
    const r = renderTemplate(tpl, {
      kategori: "Kafe",
      isletme_adi: '<script>alert("x")</script> & Co',
      sehir: "London",
    });
    expect(r.subject).toBe("Kafe işletmeleri için teklif");
    expect(r.html).toContain('&lt;script&gt;alert("x")&lt;/script&gt; &amp; Co');
    expect(r.html).not.toContain("<script");
    expect(r.text).toContain('<script>alert("x")</script> & Co');
    expect(r.missing).toEqual([]);
  });

  it("konuya başlık enjeksiyonu yapılamaz (CR/LF ve Unicode satır ayırıcıları tek boşluk olur)", () => {
    const r = renderTemplate(tpl, {
      kategori: `Kafe\r\nBcc: saldirgan@x.example${LS}X-Header: 1`,
      isletme_adi: "A",
      sehir: "B",
    });
    expect(r.subject).toBe("Kafe Bcc: saldirgan@x.example X-Header: 1 işletmeleri için teklif");
    expect(/[\r\n]/.test(r.subject)).toBe(false);
    expect(r.subject.includes(LS)).toBe(false);
    expect(headerSafe(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`)).toBe("a b c");
  });

  it("boş/boşluk değer yedek metinle dolar; yedek yoksa eksik sayılır ve uydurulmaz", () => {
    const r = renderTemplate(tpl, { kategori: "Kafe", isletme_adi: "   ", sehir: null });
    expect(r.usedFallback).toEqual(["sehir"]);
    expect(r.missing).toEqual(["isletme_adi"]);
    expect(r.html).toBe("<p>Merhaba </p><p>bölgenizdeki işletmenize</p>");
  });

  it("ön izlemede eksik değişken görünür işaretlenir", () => {
    const r = renderTemplate(tpl, { kategori: null }, { markMissing: true });
    expect(r.subject).toBe("[eksik: kategori] işletmeleri için teklif");
    expect(r.html).toContain("<strong>[eksik: isletme_adi]</strong>");
    expect(r.missing.sort()).toEqual(["isletme_adi", "kategori"]);
  });

  it("geçersiz şablon doldurulmaz", () => {
    expect(() =>
      renderTemplate({ subject: "x", bodyHtml: "<p>{{acilis_tarihi}}</p>" }, {}),
    ).toThrow(TemplateRenderError);
    expect(() => renderTemplate({ subject: "a\nb", bodyHtml: "<p>x</p>" }, {})).toThrow(
      TemplateRenderError,
    );
  });

  it("Türkçe karakterler ve kesme işareti bozulmaz", () => {
    const r = renderTemplate(
      { subject: "Çağrı", bodyHtml: "<p>İyi günler, {{sehir}}'deki işletmeniz</p>" },
      { sehir: "İzmir" },
    );
    expect(r.text).toBe("İyi günler, İzmir'deki işletmeniz");
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("HTML güvenliği", () => {
  it("tehlikeli öğeleri siler, bilinmeyenleri açar, güvenli bağlantıları korur", () => {
    const r = sanitizeEmailHtml(
      [
        '<p style="display:none" onclick="x()">Gizli?</p>',
        "<script>alert(1)</script><style>p{}</style>",
        '<iframe src="https://x.example"></iframe>',
        '<img src="https://t.example/pixel.gif">',
        '<form><input name="a"></form>',
        '<a href="javascript:alert(1)">kötü</a>',
        '<a href=" JAVASCRIPT:alert(1)">kötü2</a>',
        '<a href="https://site.example/a?b=1&amp;c=2" target="_blank">site</a>',
        '<a href="mailto:info@site.example">posta</a>',
        "<custom>iç <b>kalın</b></custom><!-- yorum -->",
        "<svg><script>alert(2)</script></svg>",
      ].join(""),
    );
    expect(r.html).not.toMatch(
      /script|style|iframe|img|form|input|javascript|onclick|svg|custom|yorum/i,
    );
    expect(r.html).toContain("<p>Gizli?</p>");
    expect(r.html).toContain('<a href="https://site.example/a?b=1&amp;c=2">site</a>');
    expect(r.html).toContain('<a href="mailto:info@site.example">posta</a>');
    expect(r.html).toContain("<a>kötü</a>");
    expect(r.html).toContain("iç <b>kalın</b>");
    expect(r.removed).toEqual(
      expect.arrayContaining([
        "script",
        "style",
        "iframe",
        "img",
        "form",
        "custom",
        "svg",
        "a[href]",
        "a[target]",
        "p[style]",
        "p[onclick]",
      ]),
    );
  });

  it("şablon değişkenleri ve Türkçe metin temizlemeden sağlam çıkar", () => {
    const html = "<p>Şehir: {{sehir|bölgenizdeki}} – İğdır &amp; Çorum</p>";
    expect(sanitizeEmailHtml(html).html).toBe(html);
  });

  it("düz metin: paragraflar, satır sonu, liste ve bağlantı", () => {
    const text = htmlToText(
      '<p>Merhaba,<br>dünya &amp; ötesi</p><ul><li>bir</li><li>iki</li></ul><p><a href="https://a.example">site</a> <a href="https://b.example">https://b.example</a></p>',
    );
    expect(text).toBe(
      "Merhaba,\ndünya & ötesi\n\n- bir\n- iki\n\nsite (https://a.example) https://b.example",
    );
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("zorunlu alt bilgi", () => {
  it("profil eksikse üretilmez; bilgi uydurulmaz", () => {
    for (const profile of [
      null,
      undefined,
      {},
      { ...PROFILE, taxId: "  " },
      { ...PROFILE, address: "" },
    ]) {
      expect(() => buildFooter({ profile, language: "tr", mode: "demo" })).toThrow(FooterError);
    }
    try {
      buildFooter({ profile: { ...PROFILE, phone: "" }, language: "tr", mode: "demo" });
    } catch (e) {
      expect((e as FooterError).kind).toBe("sender_profile_incomplete");
      expect((e as FooterError).message).toContain("phone");
    }
  });

  it("demo: açıkça DEMO işaretlidir ve çıkış bağlantısı örnek (.invalid) adrestir", () => {
    const f = buildFooter({ profile: PROFILE, language: "tr", mode: "demo" });
    expect(f.html).toContain("[DEMO]");
    expect(f.text).toContain("[DEMO]");
    expect(f.unsubscribeUrl.startsWith(DEMO_UNSUBSCRIBE_BASE)).toBe(true);
    expect(new URL(f.unsubscribeUrl).hostname.endsWith(".invalid")).toBe(true);
    for (const v of Object.values(PROFILE).filter((x) => x !== PROFILE.contactName)) {
      expect(f.text).toContain(v);
    }
    // Demo modunda gerçek görünen bir bağlantı verilse bile örnek bağlantı kullanılır.
    const g = buildFooter({
      profile: PROFILE,
      language: "en",
      mode: "demo",
      unsubscribeUrl: "https://optout.firma.com/u/1",
    });
    expect(g.unsubscribeUrl.startsWith(DEMO_UNSUBSCRIBE_BASE)).toBe(true);
    expect(g.text).toContain("[DEMO]");
  });

  it("live: güvenli gerçek çıkış bağlantısı olmadan üretilmez", () => {
    for (const url of [
      undefined,
      null,
      "",
      "http://optout.firma.com/u",
      "https://unsubscribe.invalid/x",
      "https://optout.example/u",
      "https://localhost/u",
      "https://192.168.1.10/u",
      "https://user:pass@optout.firma.com/u",
      "https://optout.firma.com:8443/u",
      "javascript:alert(1)",
      "mailto:optout@firma.com",
    ]) {
      expect(isSafeLiveUnsubscribeUrl(url), String(url)).toBe(false);
      expect(() =>
        buildFooter({ profile: PROFILE, language: "tr", mode: "live", unsubscribeUrl: url }),
      ).toThrow(FooterError);
    }
    const f = buildFooter({
      profile: PROFILE,
      language: "tr",
      mode: "live",
      unsubscribeUrl: "https://optout.firma-iletisim.com/u/abc",
    });
    expect(f.html).not.toContain("[DEMO]");
    expect(f.unsubscribeUrl).toBe("https://optout.firma-iletisim.com/u/abc");
  });

  it("profil değerleri HTML'de kaçışlanır; dil TR/EN, diğerleri EN", () => {
    const f = buildFooter({
      profile: { ...PROFILE, legalName: "<b>X</b> & Y" },
      language: "de",
      mode: "demo",
    });
    expect(f.html).toContain("&lt;b&gt;X&lt;/b&gt; &amp; Y");
    expect(f.text).toContain("This commercial email was sent by <b>X</b> & Y.");
    expect(buildFooter({ profile: PROFILE, language: "tr", mode: "demo" }).text).toContain(
      "ticari tanıtım amacıyla",
    );
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("içerik denetimi", () => {
  it.each([
    "Re: teklif",
    "RE: teklif",
    "Fwd: teklif",
    "FW:teklif",
    "YNT: teklif",
    "İLT: teklif",
    "Re[2]: teklif",
    "AW: Angebot",
  ])("yanıltıcı önek engellenir: %s", (subject) => {
    expect(codes(checkContent({ subject, body: "metin" }).errors)).toEqual([
      "misleading_reply_prefix",
    ]);
  });

  it("olağan konu ve gövde temizdir", () => {
    const r = checkContent({
      subject: "Kafe ve restoranlar için sarf malzemesi tedarik teklifi",
      body: "Merhaba, freedom ve garantili ifadeleri tek başına uyarı değildir.",
    });
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it("riskli ifade, büyük harf, ünlem, uzun konu, kısaltılmış ve çok sayıda bağlantı uyarı verir", () => {
    const r = checkContent({
      subject: "ÜCRETSİZ NUMUNE KAZANDINIZ!! ".repeat(3),
      body: "Free sample, act now! Son şans. bit.ly/abc",
      links: ["https://a.example", "https://b.example", "https://c.example", "https://d.example"],
    });
    expect(r.errors).toEqual([]);
    const w = r.warnings.map((x) => `${x.where}:${x.code}${x.detail ? `:${x.detail}` : ""}`);
    expect(w).toEqual(
      expect.arrayContaining([
        "subject:risky_phrase:ücretsiz",
        "subject:risky_phrase:kazandınız",
        "body:risky_phrase:free",
        "body:risky_phrase:act now",
        "body:risky_phrase:son şans",
        "subject:excessive_exclamation",
        "subject:excessive_caps",
        "subject:subject_long",
        "body:shortened_url",
        "body:many_links:4",
      ]),
    );
  });
});

/* ------------------------------------------------------------------------------------------------ */

describe("dil önerisi", () => {
  it("ülkeye göre öneri; bilinmeyen ve boş ülke İngilizce", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["tr", "en", "de", "fr", "es", "it", "nl", "pt", "pl"]);
    expect(suggestLanguage("TR")).toBe("tr");
    expect(suggestLanguage("de")).toBe("de");
    expect(suggestLanguage("AT")).toBe("de");
    expect(suggestLanguage("BE")).toBe("fr");
    expect(suggestLanguage("GB")).toBe("en");
    expect(suggestLanguage("US")).toBe("en");
    expect(suggestLanguage(null)).toBe("en");
    expect(suggestLanguage("  es ")).toBe("es");
  });

  it("elde şablon yoksa rastgele dile düşülmez", () => {
    expect(pickTemplateLanguage("de", ["tr", "en"])).toBe("en");
    expect(pickTemplateLanguage("de", ["de", "en"])).toBe("de");
    expect(pickTemplateLanguage("de", ["tr"])).toBeNull();
  });
});
