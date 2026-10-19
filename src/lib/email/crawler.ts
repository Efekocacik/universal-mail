import type { ContactType, EmailSourceType } from "@/lib/db/schema";
import { normalizeHost } from "./address";
import { fallbackPaths, pickContactLinks } from "./candidates";
import { extractPage } from "./extract";
import { RobotsPolicy } from "./robots";
import { FetchError, type FetchFn, type FetchResult } from "./safe-fetch";

/** Bir web sitesini nazikçe tarayıp e-posta ve iletişim bağlantılarını toplar (SRS 4.5, FR-ENR-01/05). */
export interface CrawlOptions {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  /** Tam User-Agent dizesi (tanımlanabilir olmalı). */
  userAgent: string;
  /** robots.txt `User-agent` eşleştirmesi için belirteç. */
  agentToken: string;
  /** İstekler arası en az bekleme (ms). Üretimde 1000'den az olmamalıdır. */
  delayMs: number;
  /** Site başına en fazla istek (robots.txt ve yönlendirmeler dahil). */
  maxRequests: number;
  timeoutMs: number;
  /** Sayfa dili tahmini (aday sayfa sıralaması için). */
  language: string;
  /** Yalnızca testler. */
  allowPrivate?: boolean;
  shouldStop?: () => boolean;
}

export interface FoundEmail {
  email: string;
  sourceType: EmailSourceType;
  sourceUrl: string;
}

export interface FoundContact {
  type: ContactType;
  url: string;
}

export type SiteOutcome = "ok" | "blocked" | "failed";

export interface SiteResult {
  outcome: SiteOutcome;
  /** Geçici bir hata mı? (24 saat sonra bir kez yeniden denenir; engelleme durumunda asla.) */
  retryable: boolean;
  /** Kısa neden kodu: robots_disallow, robots_forbidden, http_403, http_404, http_429, http_5xx, timeout, network, ... */
  reason: string | null;
  siteHost: string;
  pages: string[];
  requests: number;
  emails: FoundEmail[];
  contacts: FoundContact[];
  /** Sayfa neredeyse boştu: içerik büyük olasılıkla JavaScript ile oluşuyor (Faz 2'de çalıştırılmaz). */
  jsHint: boolean;
}

const MAX_CRAWL_DELAY_MS = 10_000;

function isBotWall(res: FetchResult): boolean {
  if (res.status === 401 || res.status === 403) return true;
  if (res.headers["cf-mitigated"] === "challenge") return true;
  if (
    res.status === 503 &&
    /just a moment|cf-chl|challenge-platform|attention required/i.test(res.body)
  )
    return true;
  return false;
}

function normalizeStart(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

export async function crawlSite(siteUrl: string, o: CrawlOptions): Promise<SiteResult> {
  const start = normalizeStart(siteUrl);
  const base: SiteResult = {
    outcome: "failed",
    retryable: false,
    reason: null,
    siteHost: "",
    pages: [],
    requests: 0,
    emails: [],
    contacts: [],
    jsHint: false,
  };
  if (!start) return { ...base, reason: "bad_url" };
  const siteHost = normalizeHost(start.hostname);
  const result: SiteResult = { ...base, siteHost };

  let lastRequestAt = 0;
  let crawlDelay = 0;
  const sameSite = (_from: URL, to: URL) => normalizeHost(to.hostname) === siteHost;

  type Got = { res: FetchResult } | { error: FetchError };
  const get = async (url: string): Promise<Got | "budget"> => {
    if (result.requests >= o.maxRequests) return "budget";
    if (o.shouldStop?.()) return "budget";
    const wait =
      lastRequestAt === 0
        ? 0
        : Math.max(0, lastRequestAt + Math.max(o.delayMs, crawlDelay) - Date.now());
    if (wait > 0) await o.sleep(wait);
    lastRequestAt = Date.now();
    result.requests += 1;
    try {
      const res = await o.fetch(url, {
        userAgent: o.userAgent,
        timeoutMs: o.timeoutMs,
        allowRedirect: sameSite,
        allowPrivate: o.allowPrivate,
      });
      result.requests += res.hops ?? 0; // her yönlendirme ayrı bir istektir
      return { res };
    } catch (e) {
      if (e instanceof FetchError) return { error: e };
      return { error: new FetchError("network", (e as Error).message) };
    }
  };

  const fail = (reason: string, retryable: boolean): SiteResult => ({
    ...result,
    outcome: "failed",
    retryable,
    reason,
  });
  const block = (reason: string): SiteResult => ({
    ...result,
    outcome: "blocked",
    retryable: false,
    reason,
  });

  // 1) robots.txt
  const robotsGot = await get(`${start.origin}/robots.txt`);
  if (robotsGot === "budget") return fail("stopped", true);
  let policy = RobotsPolicy.allowAll();
  let origin = start.origin;
  if ("error" in robotsGot) {
    const e = robotsGot.error;
    return fail(e.kind === "network" ? `network` : e.kind, e.retryable);
  }
  const rr = robotsGot.res;
  origin = new URL(rr.url).origin;
  if (rr.status === 401 || rr.status === 403) return block("robots_forbidden");
  if (rr.status >= 500) return fail("robots_unavailable", true);
  if (rr.status === 429) return fail("http_429", true);
  if (rr.status === 200 && !rr.skippedBody) {
    policy = RobotsPolicy.parse(rr.body, o.agentToken);
    crawlDelay = Math.min(policy.crawlDelayMs ?? 0, MAX_CRAWL_DELAY_MS);
  }

  // 2) ana sayfa
  const homePath = `${start.pathname}${start.search}` || "/";
  if (!policy.isAllowed(homePath)) return block("robots_disallow");
  const homeGot = await get(`${origin}${homePath}`);
  if (homeGot === "budget") return fail("stopped", true);
  if ("error" in homeGot) return fail(homeGot.error.kind, homeGot.error.retryable);
  const home = homeGot.res;
  if (isBotWall(home)) return block(`http_${home.status}`);
  if (home.status === 404 || home.status === 410) return fail("http_404", false);
  if (home.status === 429) return fail("http_429", true);
  if (home.status >= 500) return fail("http_5xx", true);
  if (home.status < 200 || home.status >= 300) return fail(`http_${home.status}`, false);

  const emails = new Map<string, FoundEmail>();
  const contacts = new Map<string, FoundContact>();
  const ingest = (res: FetchResult, parsed?: ReturnType<typeof extractPage> | null): void => {
    result.pages.push(res.url);
    if (res.skippedBody || !res.body) return;
    const page = parsed ?? extractPage(res.body, res.url);
    for (const e of page.emails)
      if (!emails.has(e.email))
        emails.set(e.email, { email: e.email, sourceType: e.sourceType, sourceUrl: res.url });
    for (const c of page.contacts) contacts.set(`${c.type}|${c.url}`, c);
    if (page.hasContactForm)
      contacts.set(`contact_form|${res.url}`, { type: "contact_form", url: res.url });
    if (res.url === home.url && page.textLength < 120 && page.emails.length === 0)
      result.jsHint = true;
  };
  const homePage = home.skippedBody || !home.body ? null : extractPage(home.body, home.url);
  ingest(home, homePage);

  // 3) iletişim / kurumsal sayfalar: önce ana sayfadaki bağlantılar, sonra dile göre yedek adresler
  const linked = homePage ? pickContactLinks(homePage.links, siteHost) : [];
  const candidates = [...linked, ...fallbackPaths(o.language).map((p) => `${origin}${p}`)];
  const tried = new Set<string>([home.url]);
  let extraFetched = 0;
  for (const url of candidates) {
    if (tried.has(url)) continue;
    tried.add(url);
    const u = new URL(url);
    if (!policy.isAllowed(`${u.pathname}${u.search}`)) continue;
    if (emails.size > 0 && (extraFetched >= 1 || emails.size >= 3)) break;
    const got = await get(url);
    if (got === "budget") break;
    if ("error" in got) {
      if (got.error.retryable) continue;
      break;
    }
    const res = got.res;
    if (isBotWall(res) || res.status === 429) break; // engel/limit: daha fazla zorlanmaz
    if (res.status >= 200 && res.status < 300) {
      ingest(res);
      extraFetched += 1;
    }
  }

  return {
    ...result,
    outcome: "ok",
    retryable: false,
    reason: null,
    emails: [...emails.values()],
    contacts: [...contacts.values()],
  };
}
