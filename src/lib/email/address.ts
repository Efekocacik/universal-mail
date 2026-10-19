import { domainToASCII } from "node:url";
import {
  CONSUMER_DOMAINS,
  DISPOSABLE_DOMAINS,
  FILE_LIKE_TLDS,
  GENERIC_LOCAL_PARTS,
  IGNORED_DOMAINS,
  PLACEHOLDER_LOCAL_PARTS,
} from "./lists";

export interface ParsedEmail {
  email: string;
  local: string;
  domain: string;
}

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * E-posta sözdizimi (RFC 5321/5322'nin pratik alt kümesi): küçük harfe çevirir, alan adını punycode yapar.
 * Tırnaklı yerel kısımlar, IP adresi alan adları ve yorumlar desteklenmez (işletme adresi olarak anlamsızdır).
 */
export function parseEmail(raw: string): ParsedEmail | null {
  const value = raw.trim().replace(/^<|>$/g, "").toLowerCase();
  if (value.length < 6 || value.length > 254) return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || value.indexOf("@") !== at) return null;
  const local = value.slice(0, at);
  const rawDomain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  const domain = domainToASCII(rawDomain);
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
  return { email: `${local}@${domain}`, local, domain };
}

/** `a.b.example.co.uk` → ["a.b.example.co.uk", "b.example.co.uk", "example.co.uk", "co.uk"] */
function parentDomains(domain: string): string[] {
  const parts = domain.split(".");
  return parts.map((_, i) => parts.slice(i).join(".")).slice(0, -1);
}

export function isDisposableDomain(domain: string): boolean {
  return parentDomains(domain).some((d) => DISPOSABLE_DOMAINS.has(d));
}

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domain);
}

/** Sitelerde görülen ama işletmeye ait olmayan veya anlamsız adresleri eler (görsel adı, yer tutucu, platform). */
export function isNoiseAddress(p: ParsedEmail): boolean {
  const tld = p.domain.split(".").pop()!;
  if (FILE_LIKE_TLDS.has(tld)) return true;
  if (parentDomains(p.domain).some((d) => IGNORED_DOMAINS.has(d))) return true;
  if (PLACEHOLDER_LOCAL_PARTS.has(p.local)) return true;
  if (/^[0-9a-f]{20,}$/.test(p.local)) return true; // izleme/özet kimlikleri
  if (/^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|bounce|bounces)\b/.test(p.local))
    return true;
  return false;
}

/** Yerel kısım genel (rol) adresi mi? `info`, `info.london`, `reservations2` gibi biçimleri de kapsar. */
export function isGenericLocal(local: string): boolean {
  if (GENERIC_LOCAL_PARTS.has(local)) return true;
  const stem = local.replace(/[0-9]+$/, "").replace(/[._-]+$/, "");
  if (GENERIC_LOCAL_PARTS.has(stem)) return true;
  const first = stem.split(/[._-]/)[0] ?? "";
  return first.length >= 3 && GENERIC_LOCAL_PARTS.has(first) && stem.split(/[._-]/).length <= 3;
}

/** Adresin türü: bireysel sağlayıcı (`consumer`), genel rol adresi (`generic`) veya kişiye ait (`personal`). */
export function classifyKind(p: ParsedEmail): "generic" | "personal" | "consumer" {
  if (isConsumerDomain(p.domain)) return "consumer";
  return isGenericLocal(p.local) ? "generic" : "personal";
}

/** `www.` önekini ve büyük/küçük harf farkını atar. */
export function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** E-posta alan adı, taranan sitenin alan adıyla aynı mı (ya da onun alt/üst alan adı mı)? */
export function domainMatchesSite(emailDomain: string, siteHost: string): boolean {
  const a = normalizeHost(emailDomain);
  const b = normalizeHost(siteHost);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
