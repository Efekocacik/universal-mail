import { normalizeHost } from "./address";
import type { PageLink } from "./extract";

/** Ülke koduna göre sayfa dili tahmini (yalnızca aday sayfa sıralaması için). */
export function languageForCountry(cc: string | null | undefined): string {
  switch ((cc ?? "").toUpperCase()) {
    case "DE":
    case "AT":
    case "CH":
    case "LI":
      return "de";
    case "FR":
    case "BE":
    case "LU":
    case "MC":
      return "fr";
    case "ES":
      return "es";
    case "IT":
    case "SM":
      return "it";
    case "NL":
      return "nl";
    case "PT":
      return "pt";
    case "PL":
      return "pl";
    case "TR":
      return "tr";
    default:
      return "en";
  }
}

const PATHS: Record<string, string[]> = {
  en: ["/contact", "/contact-us", "/contactus", "/about", "/about-us", "/find-us", "/get-in-touch"],
  de: ["/impressum", "/kontakt", "/ueber-uns", "/über-uns", "/anfahrt", "/datenschutz"],
  fr: [
    "/contact",
    "/nous-contacter",
    "/contactez-nous",
    "/mentions-legales",
    "/a-propos",
    "/qui-sommes-nous",
  ],
  es: ["/contacto", "/contactenos", "/aviso-legal", "/sobre-nosotros", "/quienes-somos"],
  it: ["/contatti", "/contattaci", "/chi-siamo", "/note-legali", "/dove-siamo"],
  nl: ["/contact", "/over-ons", "/colofon", "/privacy"],
  pt: ["/contacto", "/contactos", "/contato", "/sobre-nos", "/quem-somos"],
  pl: ["/kontakt", "/o-nas", "/polityka-prywatnosci"],
  tr: ["/iletisim", "/bize-ulasin", "/hakkimizda", "/iletisim-bilgileri"],
};

/** Yedek aday sayfalar: önce sayfa dilindekiler, sonra İngilizce ve diğer yaygın biçimler. */
export function fallbackPaths(lang: string): string[] {
  const order = [lang, "en", "de", "fr", "es", "it", "nl"].filter((l, i, a) => a.indexOf(l) === i);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of order) {
    for (const p of PATHS[l] ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

const STRONG =
  /(contact|kontakt|contacto|contatt|contactez|nous-contacter|impressum|mentions[-_ ]l[ée]gales|iletisim|iletişim|bize ula[sş]|get[-_ ]in[-_ ]touch|reach us|find us|anfahrt|colofon|aviso[-_ ]legal|note[-_ ]legali)/i;
const WEAK =
  /(about|[uü]ber[-_ ]uns|[àa][-_ ]propos|qui[-_ ]sommes|sobre|chi[-_ ]siamo|over[-_ ]ons|sobre[-_ ]nos|o[-_ ]nas|hakk[ıi]m[ıi]zda|team|visit|location|standort|ubicaci|dove)/i;

/**
 * Ana sayfadaki bağlantılardan iletişim/kurumsal sayfaları seçer ve puanlar. Yalnızca aynı siteye giden
 * bağlantılar alınır; dosya, e-posta ve oturum sayfaları atlanır. En yüksek puanlılar önce gelir.
 */
export function pickContactLinks(links: PageLink[], siteHost: string, limit = 6): string[] {
  const host = normalizeHost(siteHost);
  const scored = new Map<string, number>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (normalizeHost(u.hostname) !== host) continue;
    if (/\.(?:pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)$/i.test(u.pathname)) continue;
    if (
      /(login|signin|cart|checkout|account|wp-admin|basket|tag\/|category\/|\/blog\/|\/news\/)/i.test(
        u.pathname,
      )
    )
      continue;
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* bozuk kodlama: olduğu gibi */
    }
    const hay = `${path} ${l.text}`;
    let score = 0;
    if (STRONG.test(hay)) score = 10;
    else if (WEAK.test(hay)) score = 4;
    if (score === 0) continue;
    if (STRONG.test(l.text)) score += 2;
    if (u.pathname.split("/").filter(Boolean).length <= 2) score += 1;
    u.hash = "";
    const key = u.toString();
    scored.set(key, Math.max(scored.get(key) ?? 0, score));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}
