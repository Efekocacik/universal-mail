/**
 * İçerik denetimi (SRS FR-TPL-07, 8.3). Kural tabanlıdır ve spam olarak değerlendirilmemeyi GARANTİ ETMEZ.
 *
 *  - Hata (gönderimi engeller): yanıltıcı yanıt/iletme öneki ("Re:", "Fwd:", "YNT:"...): ileti daha önceki bir
 *    yazışmanın parçasıymış gibi gösterilemez (yanıltıcı konu ve gizlenmiş ticari nitelik).
 *  - Uyarı: riskli/abartılı ifadeler, aşırı büyük harf veya ünlem, uzun konu, kısaltılmış bağlantı, çok bağlantı.
 * Gizli metin (stil, görsel) zaten HTML temizlemede silinir.
 */

export type ContentIssueCode =
  | "misleading_reply_prefix"
  | "risky_phrase"
  | "excessive_caps"
  | "excessive_exclamation"
  | "subject_long"
  | "shortened_url"
  | "many_links";

export interface ContentIssue {
  code: ContentIssueCode;
  where: "subject" | "body";
  detail?: string;
}

export interface ContentCheckResult {
  errors: ContentIssue[];
  warnings: ContentIssue[];
}

const REPLY_PREFIX = /^\s*(?:re|fw|fwd|aw|wg|tr|ynt|ilt|cevap|rv|sv|vs|r|i)\s*(?:\[\d+\])?\s*:/i;

const RISKY: readonly string[] = [
  // TR
  "ücretsiz",
  "bedava",
  "garanti",
  "kazandınız",
  "tebrikler",
  "acil",
  "son şans",
  "hemen tıkla",
  "hemen tıklayın",
  "kaçırmayın",
  "sınırlı süre",
  "%100",
  "risksiz",
  "para iade",
  // EN
  "free",
  "guarantee",
  "winner",
  "congratulations",
  "act now",
  "urgent",
  "limited time",
  "click here",
  "risk-free",
  "risk free",
  "no obligation",
  "100%",
  "cash",
  "!!!",
];

const SHORTENERS =
  /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly)\b/i;

function lower(s: string): string {
  return s.toLocaleLowerCase("tr");
}

function capsRatio(s: string): { letters: number; ratio: number } {
  const letters = [...s].filter((c) => c.toLocaleLowerCase("tr") !== c.toLocaleUpperCase("tr"));
  if (letters.length === 0) return { letters: 0, ratio: 0 };
  const upper = letters.filter(
    (c) => c === c.toLocaleUpperCase("tr") && c !== c.toLocaleLowerCase("tr"),
  );
  return { letters: letters.length, ratio: upper.length / letters.length };
}

function wordMatch(text: string, phrase: string): boolean {
  if (/^\W/.test(phrase) || /\W$/.test(phrase)) return text.includes(phrase);
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * `body` düz metindir (HTML'den üretilmiş). `links` gövdedeki bağlantı adresleri. Denetim değişkenler doldurulmadan
 * önce (şablon) veya sonra (ön izleme) çalıştırılabilir.
 */
export function checkContent(input: {
  subject: string;
  body: string;
  links?: readonly string[];
}): ContentCheckResult {
  const errors: ContentIssue[] = [];
  const warnings: ContentIssue[] = [];

  // Türkçe büyük harfler ("İLT:") için önce Türkçe kurallarla küçük harfe çevrilir.
  if (REPLY_PREFIX.test(lower(input.subject)))
    errors.push({ code: "misleading_reply_prefix", where: "subject" });

  for (const [where, text] of [
    ["subject", input.subject],
    ["body", input.body],
  ] as const) {
    const l = lower(text);
    for (const p of RISKY) {
      if (wordMatch(l, lower(p))) warnings.push({ code: "risky_phrase", where, detail: p });
    }
    const exclamations = (text.match(/!/g) ?? []).length;
    if (exclamations >= (where === "subject" ? 2 : 4)) {
      warnings.push({ code: "excessive_exclamation", where });
    }
  }

  const caps = capsRatio(input.subject);
  if (caps.letters >= 8 && caps.ratio > 0.6)
    warnings.push({ code: "excessive_caps", where: "subject" });
  const bodyCaps = capsRatio(input.body);
  if (bodyCaps.letters >= 40 && bodyCaps.ratio > 0.5)
    warnings.push({ code: "excessive_caps", where: "body" });
  if (input.subject.length > 78) warnings.push({ code: "subject_long", where: "subject" });

  const links = input.links ?? [];
  if ([...links, input.body].some((s) => SHORTENERS.test(s))) {
    warnings.push({ code: "shortened_url", where: "body" });
  }
  if (links.length > 3)
    warnings.push({ code: "many_links", where: "body", detail: String(links.length) });

  return { errors, warnings };
}
