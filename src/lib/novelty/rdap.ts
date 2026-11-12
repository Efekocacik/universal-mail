import { parse } from "tldts";
import { FetchError, safeFetch, type FetchFn } from "@/lib/email/safe-fetch";
import type { DomainRegistrationStatus } from "@/lib/db/schema";

/**
 * RDAP ile alan adı kayıt tarihi (Faz 4, madde 4; SRS 4.2 "alan adı yaşı" sinyali).
 *
 * - Yalnızca KAYITLI ALAN ADI (ör. `firma.co.uk`) herkese açık RDAP sunucusuna gönderilir; işletme adı, e-posta, kişi
 *   verisi gönderilmez. Yanıttan yalnızca `registration` olay tarihi okunur; ham yanıt saklanmaz.
 * - Sunucu, IANA önyükleme dosyasından TLD'ye göre seçilir (RFC 9224): https://data.iana.org/rdap/dns.json
 * - Ağ isteği `safeFetch` ile yapılır (iç ağ engeli, zaman aşımı, boyut sınırı); yalnızca https tabanları kabul edilir.
 */
export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const RDAP_USER_AGENT = "UniversalMail-RDAP/1.0 (+https://www.rfc-editor.org/rfc/rfc9083)";
export const RDAP_BODY_TYPES = /^application\/(?:rdap\+)?json/i;
export const RDAP_TIMEOUT_MS = 8_000;
/** Önyükleme dosyası bu kadar günden eskiyse yenilenir. */
export const BOOTSTRAP_MAX_AGE_DAYS = 30;
const DAY = 86_400_000;

/** Ad sunucusu başına yeniden deneme / yeniden denetim aralıkları. */
export const RECHECK_MS: Record<DomainRegistrationStatus, number> = {
  pending: 0,
  ok: 365 * DAY, // kayıt tarihi değişmez; yıllık doğrulama yeter
  no_date: 180 * DAY,
  not_found: 90 * DAY,
  unsupported_tld: 90 * DAY,
  rate_limited: DAY,
  error: DAY,
};

export interface RdapBootstrap {
  fetchedAt: number;
  publication: string;
  /** TLD (küçük harf, punycode) → https RDAP tabanı ("/" ile biter). */
  map: Record<string, string>;
}

/**
 * Web sitesi sunucu adından kayıtlı alan adı (Public Suffix List, tldts). IP adresi ve geçersiz adlar `null`.
 * Demo `.example` adları da alan adı döndürür (demo RDAP bunları yanıtlar; gerçek RDAP "desteklenmeyen TLD" der).
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const r = parse(host.trim().toLowerCase().replace(/\.$/, ""), { allowPrivateDomains: false });
  if (r.isIp || !r.domain) return null;
  const d = r.domain.toLowerCase();
  return d.length >= 3 && d.length <= 253 ? d : null;
}

export function tldOf(domain: string): string {
  return domain.slice(domain.lastIndexOf(".") + 1);
}

/** IANA önyükleme JSON'unu haritaya çevirir (yalnızca https tabanları; TLD ve adres uzunlukları sınırlı). */
export function parseBootstrap(raw: unknown, now: number): RdapBootstrap | null {
  const j = raw as { publication?: unknown; services?: unknown };
  if (!j || !Array.isArray(j.services)) return null;
  const map: Record<string, string> = {};
  for (const svc of j.services) {
    if (!Array.isArray(svc) || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
    const base = (svc[1] as unknown[]).find(
      (u): u is string => typeof u === "string" && /^https:\/\//i.test(u) && u.length <= 290,
    );
    if (!base) continue;
    const url = base.endsWith("/") ? base : `${base}/`;
    for (const tld of svc[0] as unknown[]) {
      if (typeof tld === "string" && tld.length > 0 && tld.length <= 63)
        map[tld.toLowerCase()] = url;
    }
  }
  if (Object.keys(map).length === 0) return null;
  return {
    fetchedAt: now,
    publication: typeof j.publication === "string" ? j.publication.slice(0, 64) : "",
    map,
  };
}

export function bootstrapFresh(b: RdapBootstrap | null, now: number): b is RdapBootstrap {
  return !!b && now - b.fetchedAt < BOOTSTRAP_MAX_AGE_DAYS * DAY;
}

export async function fetchBootstrap(
  now: number,
  fetchFn: FetchFn = safeFetch,
): Promise<RdapBootstrap | null> {
  const res = await fetchFn(RDAP_BOOTSTRAP_URL, {
    userAgent: RDAP_USER_AGENT,
    timeoutMs: 15_000,
    maxBytes: 512_000,
    maxRedirects: 2,
    accept: "application/json",
    bodyTypes: /^application\/json/i,
  });
  if (res.status !== 200 || !res.body) return null;
  try {
    return parseBootstrap(JSON.parse(res.body), now);
  } catch {
    return null;
  }
}

export interface RdapOutcome {
  status: DomainRegistrationStatus;
  registeredAt: number | null;
  rdapHost: string | null;
  /** Kısa hata kodu (en çok 64 karakter). */
  error: string | null;
  /** Yalnızca `rate_limited`: sunucunun `Retry-After` başlığından bekleme (ms); başlık yoksa/okunamazsa `null`. */
  retryAfterMs?: number | null;
}

/** 429 yanıtında `Retry-After` yoksa aynı RDAP sunucusuna bu kadar süre sorgu gönderilmez. */
export const RDAP_RATE_LIMIT_DEFAULT_MS = 15 * 60_000;
/** Sunucunun istediği bekleme bu aralığa sıkıştırılır (aşırı uzun/kısa değerler kuyruğu kilitlemesin). */
export const RDAP_RATE_LIMIT_MIN_MS = 60_000;
export const RDAP_RATE_LIMIT_MAX_MS = 6 * 3_600_000;

/** `Retry-After` (saniye ya da HTTP tarihi) → ms. Geçersizse `null`. */
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Hız sınırına takılan sunucu için bekleme süresi (ms): `Retry-After` ya da varsayılan, sınırlar içinde. */
export function rateLimitDelayMs(retryAfterMs: number | null | undefined): number {
  const ms = retryAfterMs ?? RDAP_RATE_LIMIT_DEFAULT_MS;
  return Math.min(RDAP_RATE_LIMIT_MAX_MS, Math.max(RDAP_RATE_LIMIT_MIN_MS, ms));
}

/** Alan adının sorgulanacağı RDAP sunucusu (önyüklemede uzantı yoksa `null`). */
export function rdapHostFor(domain: string, bootstrap: RdapBootstrap): string | null {
  const base = bootstrap.map[tldOf(domain)];
  return base ? new URL(base).hostname : null;
}

/** RDAP alan adı yanıtından kayıt tarihi (`events[].eventAction = "registration"`). */
export function registrationDate(raw: unknown): number | null {
  const events = (raw as { events?: unknown })?.events;
  if (!Array.isArray(events)) return null;
  for (const e of events) {
    const ev = e as { eventAction?: unknown; eventDate?: unknown };
    if (ev?.eventAction === "registration" && typeof ev.eventDate === "string") {
      const t = Date.parse(ev.eventDate);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/** Tek alan adı sorgusu. Ağ/sunucu hataları fırlatılmaz; sonuç durumu olarak döner. */
export async function lookupDomain(
  domain: string,
  bootstrap: RdapBootstrap,
  fetchFn: FetchFn = safeFetch,
  now: number = Date.now(),
): Promise<RdapOutcome> {
  const base = bootstrap.map[tldOf(domain)];
  if (!base) return { status: "unsupported_tld", registeredAt: null, rdapHost: null, error: null };
  const host = new URL(base).hostname;
  try {
    const res = await fetchFn(`${base}domain/${encodeURIComponent(domain)}`, {
      userAgent: RDAP_USER_AGENT,
      timeoutMs: RDAP_TIMEOUT_MS,
      maxBytes: 256_000,
      maxRedirects: 2,
      accept: "application/rdap+json, application/json;q=0.9",
      bodyTypes: RDAP_BODY_TYPES,
    });
    if (res.status === 404)
      return { status: "not_found", registeredAt: null, rdapHost: host, error: null };
    if (res.status === 429)
      return {
        status: "rate_limited",
        registeredAt: null,
        rdapHost: host,
        error: "http_429",
        retryAfterMs: parseRetryAfter(res.headers?.["retry-after"], now),
      };
    if (res.status !== 200 || !res.body)
      return { status: "error", registeredAt: null, rdapHost: host, error: `http_${res.status}` };
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      return { status: "error", registeredAt: null, rdapHost: host, error: "bad_json" };
    }
    const at = registrationDate(body);
    return at === null
      ? { status: "no_date", registeredAt: null, rdapHost: host, error: null }
      : { status: "ok", registeredAt: at, rdapHost: host, error: null };
  } catch (e) {
    const code = e instanceof FetchError ? e.kind : "network";
    return { status: "error", registeredAt: null, rdapHost: host, error: code.slice(0, 64) };
  }
}

/** Sonraki denetim anı. Hatalarda deneme sayısına göre geri çekilir (1, 3, 7, 30 gün). */
export function nextCheckAt(
  status: DomainRegistrationStatus,
  attempts: number,
  now: number,
): number {
  if (status === "error" || status === "rate_limited") {
    const steps = [1, 3, 7, 30];
    return now + steps[Math.min(Math.max(attempts - 1, 0), steps.length - 1)]! * DAY;
  }
  return now + RECHECK_MS[status];
}
