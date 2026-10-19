import * as cheerio from "cheerio/slim";
import type { ContactType, EmailSourceType } from "@/lib/db/schema";
import { isNoiseAddress, parseEmail } from "./address";

export interface ExtractedEmail {
  email: string;
  sourceType: EmailSourceType;
}

export interface ExtractedContact {
  type: ContactType;
  url: string;
}

export interface PageLink {
  href: string;
  text: string;
}

export interface ExtractedPage {
  emails: ExtractedEmail[];
  contacts: ExtractedContact[];
  links: PageLink[];
  /** Sayfada bir iletişim formu (mesaj alanlı) var mı? */
  hasContactForm: boolean;
  /** Görünür metin uzunluğu; çok kısaysa sayfa büyük olasılıkla JavaScript ile oluşturuluyor. */
  textLength: number;
}

/** Aynı adres birden çok yerde geçerse en güvenilir kaynak türü saklanır. */
const SOURCE_RANK: Record<EmailSourceType, number> = {
  mailto: 0,
  jsonld: 1,
  cfemail: 2,
  text: 3,
  obfuscated: 4,
  external: 5,
  manual: 6,
};

/**
 * Düz metinde adres arama DOĞRUSAL zamanlıdır: önce '@' (veya "[at]" gibi işaretler) bulunur, sonra yalnızca çevresindeki
 * sınırlı pencere incelenir. Başı belirsiz düzenli ifadeler ("[a-z]+@…") uzun, '@' içermeyen metinde (sayfa 1 MB'a kadar,
 * içerik saldırgan olabilir) ikinci dereceden sürede çalışır; bu yüzden kullanılmaz.
 */
const LOCAL_CHAR = /[a-z0-9._%+'-]/i;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;
const MAX_MARKERS = 5000;
const DOMAIN_TAIL = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,24}/u;
const BRACKET_AT = /\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}/gi;
const BRACKET_DOMAIN =
  /^\s*([a-z0-9-]+(?:\s{0,3}(?:\[\s{0,3}dot\s{0,3}\]|\(\s{0,3}dot\s{0,3}\)|\{\s{0,3}dot\s{0,3}\}|\.)\s{0,3}[a-z0-9-]+){1,8})/i;
const UPPER_DOMAIN = /^([A-Za-z0-9-]+(?: DOT [A-Za-z0-9-]+){1,8})/;
const DOT_WORD = /\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}| DOT )\s*/gi;

/** `idx`'ten geriye doğru yerel kısım karakterlerini toplar (en çok 64). Aradaki boşluklar atlanabilir. */
function localBefore(text: string, idx: number, skipSpaces: boolean): string {
  let end = idx;
  if (skipSpaces) while (end > 0 && text[end - 1] === " ") end--;
  let start = end;
  while (start > 0 && end - start < MAX_LOCAL && LOCAL_CHAR.test(text[start - 1]!)) start--;
  // Yerel kısım sınırdan uzunsa (örn. çok uzun bir dize) adres değildir; kesilmiş parça adres sayılmaz.
  if (start > 0 && end - start >= MAX_LOCAL && LOCAL_CHAR.test(text[start - 1]!)) return "";
  return text.slice(start, end);
}

function scanText(text: string, found: Map<string, ExtractedEmail>): void {
  // Düz adresler: her '@' çevresinde sınırlı pencere
  let at = text.indexOf("@");
  let n = 0;
  while (at !== -1 && n++ < MAX_MARKERS) {
    const local = localBefore(text, at, false);
    if (local) {
      const tail = text.slice(at + 1, at + 1 + MAX_DOMAIN);
      const m = DOMAIN_TAIL.exec(tail);
      if (m) addEmail(found, `${local}@${m[0]}`, "text");
    }
    at = text.indexOf("@", at + 1);
  }
  // Köşeli/parantezli gizleme: "ad [at] alanadi [dot] com"
  n = 0;
  for (const m of text.matchAll(BRACKET_AT)) {
    if (n++ >= MAX_MARKERS) break;
    const local = localBefore(text, m.index, true);
    const d = BRACKET_DOMAIN.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 160));
    if (local && d)
      addEmail(found, `${local}@${d[1]!.replace(DOT_WORD, ".").replace(/\s+/g, "")}`, "obfuscated");
  }
  // Büyük harfli "ad AT alanadi DOT com" (küçük harfli sıradan cümleler adres sayılmasın diye yalnızca BÜYÜK harf)
  let up = text.indexOf(" AT ");
  n = 0;
  while (up !== -1 && n++ < MAX_MARKERS) {
    const local = localBefore(text, up, false);
    const d = UPPER_DOMAIN.exec(text.slice(up + 4, up + 4 + 160));
    if (local && d) addEmail(found, `${local}@${d[1]!.replace(DOT_WORD, ".")}`, "obfuscated");
    up = text.indexOf(" AT ", up + 1);
  }
}

function addEmail(
  map: Map<string, ExtractedEmail>,
  raw: string,
  sourceType: EmailSourceType,
): void {
  const parsed = parseEmail(raw);
  if (!parsed || isNoiseAddress(parsed)) return;
  const existing = map.get(parsed.email);
  if (!existing || SOURCE_RANK[sourceType] < SOURCE_RANK[existing.sourceType])
    map.set(parsed.email, { email: parsed.email, sourceType });
}

/** Cloudflare "e-posta koruması": ilk bayt anahtar, sonrakiler XOR ile şifreli onaltılık metin. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function mailtoAddresses(href: string): string[] {
  const rest = href.replace(/^mailto:/i, "");
  const addr = rest.split("?")[0] ?? "";
  let decoded = addr;
  try {
    decoded = decodeURIComponent(addr);
  } catch {
    /* bozuk kodlama: olduğu gibi kullanılır */
  }
  return decoded
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function walkJsonLd(node: unknown, found: string[], sameAs: string[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, found, sameAs, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase() === "email" && typeof value === "string")
      found.push(value.replace(/^mailto:/i, ""));
    else if (key === "sameAs") {
      for (const v of Array.isArray(value) ? value : [value])
        if (typeof v === "string") sameAs.push(v);
    } else walkJsonLd(value, found, sameAs, depth + 1);
  }
}

const SOCIAL_RULES: { type: ContactType; test: (u: URL) => string | null }[] = [
  {
    type: "instagram",
    test: (u) => {
      if (!/(^|\.)instagram\.com$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      if (
        seg.length !== 1 ||
        ["p", "reel", "reels", "explore", "accounts", "stories", "tv"].includes(seg[0]!)
      )
        return null;
      return `https://www.instagram.com/${seg[0]}/`;
    },
  },
  {
    type: "facebook",
    test: (u) => {
      if (!/(^|\.)(facebook\.com|fb\.com)$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      if (u.pathname.startsWith("/profile.php") && u.searchParams.get("id"))
        return `https://www.facebook.com/profile.php?id=${u.searchParams.get("id")}`;
      if (seg.length === 0) return null;
      const first = seg[0]!.toLowerCase();
      if (
        [
          "sharer",
          "sharer.php",
          "share",
          "share.php",
          "dialog",
          "plugins",
          "tr",
          "login",
          "login.php",
          "policies",
          "help",
          "events",
          "groups",
          "watch",
          "hashtag",
          "photo",
          "photo.php",
          "permalink.php",
          "story.php",
          "l.php",
        ].includes(first)
      )
        return null;
      return `https://www.facebook.com/${seg.slice(0, first === "pages" ? 3 : 1).join("/")}`;
    },
  },
  {
    type: "linkedin",
    test: (u) => {
      if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg.length < 2 || !["company", "in", "school"].includes(seg[0]!)) return null;
      return `https://www.linkedin.com/${seg[0]}/${seg[1]}/`;
    },
  },
  {
    type: "twitter",
    test: (u) => {
      if (!/(^|\.)(twitter\.com|x\.com)$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      if (
        seg.length !== 1 ||
        ["intent", "share", "home", "i", "search", "hashtag", "login"].includes(
          seg[0]!.toLowerCase(),
        )
      )
        return null;
      return `https://x.com/${seg[0]}`;
    },
  },
  {
    type: "tiktok",
    test: (u) => {
      if (!/(^|\.)tiktok\.com$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      return seg.length === 1 && seg[0]!.startsWith("@") && seg[0]!.length > 2
        ? `https://www.tiktok.com/${seg[0]}`
        : null;
    },
  },
  {
    type: "youtube",
    test: (u) => {
      if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
      const seg = u.pathname.split("/").filter(Boolean);
      if (seg.length === 1 && seg[0]!.startsWith("@")) return `https://www.youtube.com/${seg[0]}`;
      if (seg.length >= 2 && ["channel", "c", "user"].includes(seg[0]!))
        return `https://www.youtube.com/${seg[0]}/${seg[1]}`;
      return null;
    },
  },
];

export function socialContact(href: string): ExtractedContact | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  for (const rule of SOCIAL_RULES) {
    const url = rule.test(u);
    if (url) return { type: rule.type, url };
  }
  return null;
}

function looksLikeContactForm($: cheerio.CheerioAPI): boolean {
  let found = false;
  $("form").each((_, form) => {
    const f = $(form);
    const hint =
      `${f.attr("id") ?? ""} ${f.attr("class") ?? ""} ${f.attr("action") ?? ""} ${f.attr("role") ?? ""}`.toLowerCase();
    if (/search|newsletter|subscribe|login|signin|sign-in|register|cart|checkout|coupon/.test(hint))
      return;
    const hasMessage = f.find("textarea").length > 0;
    const hasEmail = f.find('input[type="email"], input[name*="mail" i]').length > 0;
    const textInputs = f.find('input[type="text"], input:not([type])').length;
    if (hasMessage && (hasEmail || textInputs >= 1)) found = true;
  });
  return found;
}

/** Tek bir HTML sayfasından e-posta adaylarını, sosyal bağlantıları ve sayfa bağlantılarını çıkarır. */
export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const emails = new Map<string, ExtractedEmail>();
  const contacts = new Map<string, ExtractedContact>();
  const links: PageLink[] = [];

  const abs = (href: string): string | null => {
    try {
      const u = new URL(href, pageUrl);
      u.hash = "";
      return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
    } catch {
      return null;
    }
  };
  const addContact = (c: ExtractedContact | null) => {
    if (c) contacts.set(`${c.type}|${c.url}`, c);
  };

  // 1) JSON-LD (schema.org): email ve sameAs alanları
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const found: string[] = [];
      const sameAs: string[] = [];
      walkJsonLd(JSON.parse(raw), found, sameAs);
      for (const e of found) addEmail(emails, e, "jsonld");
      for (const s of sameAs) addContact(socialContact(s));
    } catch {
      /* geçersiz JSON-LD yok sayılır */
    }
  });

  // 2) Bağlantılar: mailto:, Cloudflare koruması, sosyal ağlar, sayfa bağlantıları
  $("a[href]").each((_, el) => {
    const a = $(el);
    const href = (a.attr("href") ?? "").trim();
    if (!href) return;
    if (/^mailto:/i.test(href)) {
      for (const addr of mailtoAddresses(href)) addEmail(emails, addr, "mailto");
      return;
    }
    const cdn = href.match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
    if (cdn) {
      const decoded = decodeCfEmail(cdn[1]!);
      if (decoded) addEmail(emails, decoded, "cfemail");
      return;
    }
    const full = abs(href);
    if (!full) return;
    addContact(socialContact(full));
    links.push({ href: full, text: a.text().replace(/\s+/g, " ").trim().slice(0, 120) });
  });
  $("[data-cfemail]").each((_, el) => {
    const decoded = decodeCfEmail(($(el).attr("data-cfemail") ?? "").trim());
    if (decoded) addEmail(emails, decoded, "cfemail");
  });

  // 3) Görünür metin: düz adresler ve gizlenmiş biçimler
  $("script, style, noscript, template").remove();
  // Bitişik öğelerin metni birleşmesin ("info@cafe.com" + "Opening hours" → "info@cafe.comOpening").
  $(
    "br, p, div, li, ul, ol, td, th, tr, table, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, address, a, button, label, dt, dd, blockquote",
  ).each((_, el) => {
    $(el).before(" ").after(" ");
  });
  const text = $.root().text().replace(/\s+/g, " ");
  scanText(text, emails);

  return {
    emails: [...emails.values()],
    contacts: [...contacts.values()],
    links,
    hasContactForm: looksLikeContactForm($),
    textLength: text.length,
  };
}
