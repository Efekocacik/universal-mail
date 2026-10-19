import dns from "node:dns";
import type { VerifyStatus } from "@/lib/db/schema";
import { isConsumerDomain, isDisposableDomain, parseEmail } from "./address";

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** DNS çözümleyici arayüzü (testlerde ve demo modunda sahtesi kullanılır). */
export interface Resolver {
  resolveMx(host: string): Promise<MxRecord[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}

export function createSystemResolver(timeoutMs = 4000): Resolver {
  const r = new dns.promises.Resolver({ timeout: timeoutMs, tries: 2 });
  return {
    resolveMx: (h) => r.resolveMx(h),
    resolve4: (h) => r.resolve4(h),
    resolve6: (h) => r.resolve6(h),
  };
}

export interface VerifyResult {
  status: VerifyStatus;
  /** ok_mx | ok_a | syntax | disposable | null_mx | no_mx | consumer_domain | dns_timeout | dns_error */
  reason: string;
}

const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN", "ENOENT"]);
const TRANSIENT = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "ESERVFAIL",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ECANCELLED",
]);

const code = (e: unknown): string => String((e as { code?: unknown })?.code ?? "");

/**
 * Doğrulama sırası (SRS 4.5): sözdizimi → tek kullanımlık alan adı → bireysel sağlayıcı → MX kaydı.
 * Sonuç, adresin etkin olduğunu veya iletinin teslim edileceğini GARANTİ ETMEZ. Geçici DNS hatalarında adres
 * `unverified` kalır (yanlışlıkla geçersiz sayılmaz). SMTP denemesi bilerek yapılmaz (IP itibarı ve kullanım koşulları).
 */
export async function verifyEmail(
  raw: string,
  resolver: Resolver,
  mxCache?: Map<string, VerifyResult>,
): Promise<VerifyResult> {
  const parsed = parseEmail(raw);
  if (!parsed) return { status: "invalid", reason: "syntax" };
  if (isDisposableDomain(parsed.domain)) return { status: "invalid", reason: "disposable" };

  const cached = mxCache?.get(parsed.domain);
  const domainResult = cached ?? (await checkDomain(parsed.domain, resolver));
  if (!cached && domainResult.reason !== "dns_timeout" && domainResult.reason !== "dns_error")
    mxCache?.set(parsed.domain, domainResult);

  if (domainResult.status === "verified" && isConsumerDomain(parsed.domain))
    return { status: "unverified", reason: "consumer_domain" };
  return domainResult;
}

async function checkDomain(domain: string, resolver: Resolver): Promise<VerifyResult> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length > 0) {
      // RFC 7505 "null MX": tek kayıt, öncelik 0, ana bilgisayar boş → bu alan e-posta kabul etmez.
      if (
        mx.length === 1 &&
        (mx[0]!.exchange === "" || mx[0]!.exchange === ".") &&
        mx[0]!.priority === 0
      )
        return { status: "invalid", reason: "null_mx" };
      return { status: "verified", reason: "ok_mx" };
    }
  } catch (e) {
    if (TRANSIENT.has(code(e))) return { status: "unverified", reason: "dns_timeout" };
    if (!NO_ANSWER.has(code(e))) return { status: "unverified", reason: "dns_error" };
  }
  // MX yoksa RFC 5321 gereği alan adının A/AAAA kaydi "örtük MX" sayılır.
  for (const fn of [resolver.resolve4, resolver.resolve6]) {
    try {
      const addrs = await fn.call(resolver, domain);
      if (addrs.length > 0) return { status: "verified", reason: "ok_a" };
    } catch (e) {
      if (TRANSIENT.has(code(e))) return { status: "unverified", reason: "dns_timeout" };
      if (!NO_ANSWER.has(code(e))) return { status: "unverified", reason: "dns_error" };
    }
  }
  return { status: "invalid", reason: "no_mx" };
}
