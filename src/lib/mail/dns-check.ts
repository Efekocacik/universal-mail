import dns from "node:dns/promises";
import { normalizeDomain } from "@/lib/compliance/suppression";
import { isConsumerGmailDomain } from "./consumer-gmail";

/**
 * SPF / DKIM / DMARC denetimi (Aşama 13). YALNIZCA kullanıcı "Kontrol et"e bastığında çalışır; yalnızca genel DNS
 * TXT sorguları yapılır (NFR-01: gerekli DNS hizmetleri). Demo (`.invalid`) alan adı için hiçbir sorgu atılmaz.
 * Sonuç bilgilendiricidir; teslim edilebilirliği garanti etmez.
 *
 * SAĞLAYICI YÖNETİMLİ ALAN ADLARI: kişisel Gmail (`gmail.com`, `googlemail.com`) için kullanıcı SPF/DKIM/DMARC kaydı
 * ekleyemez ve eklemesi gerekmez; Google iletiyi kendi alan adıyla imzalar. Bu alan adları için HİÇBİR DNS sorgusu
 * atılmadan `mode: "managed"` döner. Workspace ve kendi alan adları katı kurala (üç denetim) tabidir.
 */

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckItem {
  status: CheckStatus;
  /** Kısa, makine okunur neden kodları (arayüz Türkçe metne çevirir). */
  codes: string[];
}

export interface DnsReport {
  /**
   * `demo`: demo kutusu/ayrılmış uzantı, sorgu yok. `checked`: gerçek DNS denetimi. `managed`: alan adının e-posta
   * kimlik doğrulaması sağlayıcı (Google) tarafından yönetilir; sorgu yok, kullanıcının yapacağı bir şey yok.
   */
  mode: "demo" | "checked" | "managed";
  domain: string | null;
  spf: CheckItem | null;
  dkim: CheckItem | null;
  dmarc: CheckItem | null;
}

export interface TxtResolver {
  resolveTxt(name: string): Promise<string[][]>;
}

const DNS_TIMEOUT_MS = 5_000;

export const systemResolver: TxtResolver = {
  async resolveTxt(name) {
    const r = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    return r.resolveTxt(name);
  },
};

const SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
export const isValidSelector = (s: string) => SELECTOR_RE.test(s);

async function txt(resolver: TxtResolver, name: string): Promise<string[] | "error"> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    return "error";
  }
}

export function evaluateSpf(records: string[]): CheckItem {
  const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) return { status: "fail", codes: ["spf_missing"] };
  if (spf.length > 1) return { status: "fail", codes: ["spf_multiple"] };
  const rec = spf[0]!.trim().toLowerCase();
  const terms = rec.split(/\s+/).slice(1);
  const codes: string[] = [];
  let status: CheckStatus = "pass";
  const lookups = terms.filter(
    (t) =>
      /^[+\-~?]?(include:|a(:|\/|$)|mx(:|\/|$)|ptr|exists:)/.test(t) || t.startsWith("redirect="),
  ).length;
  if (lookups > 10) {
    codes.push("spf_too_many_lookups");
    status = "fail";
  }
  const all = terms.find((t) => /^[+\-~?]?all$/.test(t));
  if (!all) {
    codes.push("spf_no_all");
    status = status === "fail" ? status : "warn";
  } else if (all === "+all" || all === "all") {
    codes.push("spf_allows_all");
    status = "fail";
  } else if (all === "?all") {
    codes.push("spf_neutral");
    status = status === "fail" ? status : "warn";
  } else if (all === "~all") {
    codes.push("spf_softfail");
  }
  if (codes.length === 0) codes.push("spf_ok");
  return { status, codes };
}

export function evaluateDmarc(records: string[]): CheckItem {
  const d = records.filter((r) => /^v=dmarc1\s*;/i.test(r.trim()) || /^v=dmarc1$/i.test(r.trim()));
  if (d.length === 0) return { status: "fail", codes: ["dmarc_missing"] };
  if (d.length > 1) return { status: "fail", codes: ["dmarc_multiple"] };
  const tags = new Map<string, string>();
  for (const part of d[0]!.split(";")) {
    const i = part.indexOf("=");
    if (i > 0)
      tags.set(
        part.slice(0, i).trim().toLowerCase(),
        part
          .slice(i + 1)
          .trim()
          .toLowerCase(),
      );
  }
  const p = tags.get("p");
  if (p === "reject" || p === "quarantine") {
    return { status: "pass", codes: [tags.has("rua") ? "dmarc_ok" : "dmarc_no_reports"] };
  }
  if (p === "none") return { status: "warn", codes: ["dmarc_monitor_only"] };
  return { status: "fail", codes: ["dmarc_invalid_policy"] };
}

export function evaluateDkim(records: string[]): CheckItem {
  const k = records.filter((r) => /v=dkim1/i.test(r));
  if (k.length === 0) return { status: "fail", codes: ["dkim_missing"] };
  const rec = k[0]!;
  const p = /(?:^|;)\s*p=([^;]*)/i.exec(rec)?.[1]?.trim() ?? "";
  if (p === "") return { status: "fail", codes: ["dkim_revoked"] };
  return { status: "pass", codes: ["dkim_ok"] };
}

export async function checkDomainAuth(
  rawDomain: string,
  opts: { selector?: string | null; resolver?: TxtResolver } = {},
): Promise<DnsReport> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) throw new Error("invalid_domain");
  const selector = opts.selector?.trim() || null;
  if (selector !== null && !isValidSelector(selector)) throw new Error("invalid_selector");
  if (
    domain.endsWith(".invalid") ||
    domain.endsWith(".example") ||
    domain.endsWith(".test") ||
    domain.endsWith(".localhost")
  ) {
    return { mode: "demo", domain, spf: null, dkim: null, dmarc: null };
  }
  // Kişisel Gmail: SPF/DKIM/DMARC Google'ın elindedir; ağ sorgusu yapılmaz, seçici yok sayılır.
  if (isConsumerGmailDomain(domain)) {
    return { mode: "managed", domain, spf: null, dkim: null, dmarc: null };
  }
  const resolver = opts.resolver ?? systemResolver;

  const [spfRecs, dmarcRecs, dkimRecs] = await Promise.all([
    txt(resolver, domain),
    txt(resolver, `_dmarc.${domain}`),
    selector ? txt(resolver, `${selector}._domainkey.${domain}`) : Promise.resolve(null),
  ]);
  const wrap = (r: string[] | "error", f: (x: string[]) => CheckItem): CheckItem =>
    r === "error" ? { status: "warn", codes: ["dns_error"] } : f(r);
  return {
    mode: "checked",
    domain,
    spf: wrap(spfRecs, evaluateSpf),
    dmarc: wrap(dmarcRecs, evaluateDmarc),
    dkim: dkimRecs === null ? null : wrap(dkimRecs, evaluateDkim),
  };
}
