/**
 * Harici e-posta bulma servisi (SRS 4.5 adım 2, FR-ENR-04): yalnızca kullanıcı açıkça etkinleştirir ve kendi API
 * anahtarını girerse, yerel taramada adres bulunamayan işletmeler için çalışır. Servise yalnızca işletmenin alan adı
 * gönderilir. Hunter.io (Domain Search v2) ve Snov.io (Domain Search v2, OAuth istemci kimliği) desteklenir.
 * Bulunan adresler yerel taramadaki adreslerle AYNI doğrulamadan (sözdizimi + MX) ve gönderimdeki engelleme listesi
 * denetiminden geçer; sağlayıcı başına alan adı sınırı ve güven eşiği `service.ts`'tedir.
 */
export interface ExternalHit {
  email: string;
  /** Sağlayıcının güven puanı (0-100) veya bilinmiyorsa null. */
  confidence: number | null;
  /** Adresin görüldüğü kaynak sayfa (varsa). */
  sourceUrl: string | null;
}

export interface ExternalQuota {
  /** Kalan arama hakkı; sağlayıcı bildirmiyorsa null. */
  remaining: number | null;
  resetDate: string | null;
}

export type ExternalErrorKind = "auth" | "quota" | "rate_limit" | "network" | "bad_response";

export class ExternalProviderError extends Error {
  constructor(
    readonly kind: ExternalErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Faz 5: Hunter.io veya Snov.io (ayar `enrichment.external.provider`). */
export type ExternalProviderId = "hunter" | "snov";

export interface ExternalEmailProvider {
  readonly id: ExternalProviderId;
  search(domain: string): Promise<ExternalHit[]>;
  quota(): Promise<ExternalQuota>;
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const HUNTER = "https://api.hunter.io/v2";

interface HunterEmail {
  value?: unknown;
  confidence?: unknown;
  sources?: { uri?: unknown }[];
}

export function createHunterProvider(
  apiKey: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): ExternalEmailProvider {
  async function call(path: string): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await fetchImpl(`${HUNTER}${path}`, {
        headers: { "X-API-KEY": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new ExternalProviderError("network", `Hunter'a ulaşılamadı: ${(e as Error).message}`);
    }
    if (res.status === 401)
      throw new ExternalProviderError("auth", "Hunter API anahtarı geçersiz.");
    if (res.status === 429)
      throw new ExternalProviderError("quota", "Hunter kullanım kotası doldu.");
    if (res.status === 403)
      throw new ExternalProviderError(
        "rate_limit",
        "Hunter hız sınırına ulaşıldı; biraz bekleyin.",
      );
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ExternalProviderError(
        "bad_response",
        `Hunter yanıtı okunamadı (HTTP ${res.status}).`,
      );
    }
    if (res.status < 200 || res.status >= 300)
      throw new ExternalProviderError("bad_response", `Hunter hata verdi (HTTP ${res.status}).`);
    return (body ?? {}) as Record<string, unknown>;
  }

  return {
    id: "hunter",
    async search(domain) {
      const body = await call(`/domain-search?domain=${encodeURIComponent(domain)}&limit=10`);
      const emails = ((body.data as { emails?: HunterEmail[] } | undefined)?.emails ??
        []) as HunterEmail[];
      const hits: ExternalHit[] = [];
      for (const e of emails) {
        if (typeof e.value !== "string") continue;
        const uri = e.sources?.find((s) => typeof s.uri === "string")?.uri as string | undefined;
        hits.push({
          email: e.value,
          confidence: typeof e.confidence === "number" ? e.confidence : null,
          sourceUrl: uri ?? null,
        });
      }
      return hits;
    },
    async quota() {
      const body = await call("/account");
      const data = (body.data ?? {}) as {
        requests?: { searches?: { remaining?: unknown }; credits?: { remaining?: unknown } };
        reset_date?: unknown;
      };
      const credits = data.requests?.credits?.remaining;
      const searches = data.requests?.searches?.remaining;
      const remaining =
        typeof credits === "number" ? credits : typeof searches === "number" ? searches : null;
      return { remaining, resetDate: typeof data.reset_date === "string" ? data.reset_date : null };
    },
  };
}

/** Faz 5 sözleşmesindeki ad: harici zenginleştirme sağlayıcısı (Hunter/Snov) = `ExternalEmailProvider`. */
export type EnrichmentProvider = ExternalEmailProvider;

/** Demo kotası: ağsız sınama ucunun döndürdüğü sabit değer. */
export const DEMO_EXTERNAL_QUOTA: ExternalQuota = { remaining: 25, resetDate: null };

/**
 * Demo harici sağlayıcı (Faz 5 P0; sahibi: paket A). Ağa çıkmaz: yalnızca ayrılmış `.example` alan adları için
 * belirlenimci `contact@<alan>` (güven 60) döndürür; gerçek alan adlarında sonuç yoktur.
 */
export function createDemoExternalProvider(
  id: ExternalProviderId = "hunter",
): ExternalEmailProvider {
  return {
    id,
    async search(domain: string): Promise<ExternalHit[]> {
      const d = domain.trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.example$/.test(d)) return [];
      return [{ email: `contact@${d}`, confidence: 60, sourceUrl: null }];
    },
    async quota(): Promise<ExternalQuota> {
      return { ...DEMO_EXTERNAL_QUOTA };
    },
  };
}

/* ------------------------------------ Snov.io ------------------------------------ */

/**
 * Snov.io istemcisi. Uç adları Snov API belgesinden (2026-11) alındı; gerçek anahtarla hiç denenmedi (docs/12 açık
 * madde). Akış:
 *  1. `POST /v1/oauth/access_token` (client_credentials) → erişim belirteci; süresi dolana kadar (−60 sn) bellekte tutulur.
 *  2. `POST /v2/domain-search/domain-emails/start {domain}` → `meta.task_hash`.
 *  3. `GET /v2/domain-search/domain-emails/result/{task_hash}` → `status: "completed"` olana kadar sınırlı yoklama.
 *  4. Kota: `GET /v1/get-balance` → `data.balance` (kredi), `data.limit_resets_in` (gün).
 * Yanıttaki bağlantılar (`links.result`) İZLENMEZ: sonuç adresi yalnızca doğrulanmış `task_hash` ile kurulur (SSRF yok).
 * Snov güven puanı vermez (null).
 */
export const SNOV = "https://api.snov.io";

export type SnovFetch = (
  url: string,
  init: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface SnovOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: SnovFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Sonuç yoklama sayısı ve aralığı (varsayılan 6 × 1,5 sn). */
  polls?: number;
  pollMs?: number;
}

const snovTokens = new Map<string, { token: string; expiresAt: number }>();

/** Testler: bellekteki Snov belirteçlerini temizler. */
export function clearSnovTokenCache(): void {
  snovTokens.clear();
}

const TASK_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function createSnovProvider(o: SnovOptions): ExternalEmailProvider {
  const fetchImpl = o.fetchImpl ?? (fetch as unknown as SnovFetch);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const cacheKey = `${o.clientId}\u0000${o.clientSecret}`;

  async function send(
    url: string,
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    let res;
    try {
      res = await fetchImpl(url, {
        method: init.method,
        headers: {
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new ExternalProviderError("network", `Snov'a ulaşılamadı: ${(e as Error).message}`);
    }
    let body: unknown = {};
    try {
      body = await res.json();
    } catch {
      if (res.status >= 200 && res.status < 300)
        throw new ExternalProviderError(
          "bad_response",
          `Snov yanıtı okunamadı (HTTP ${res.status}).`,
        );
    }
    return { status: res.status, body: (body ?? {}) as Record<string, unknown> };
  }

  function check(status: number): void {
    if (status === 401 || status === 403) {
      snovTokens.delete(cacheKey);
      throw new ExternalProviderError("auth", "Snov istemci kimliği veya sırrı geçersiz.");
    }
    if (status === 402) throw new ExternalProviderError("quota", "Snov kredisi bitti.");
    if (status === 429)
      throw new ExternalProviderError("rate_limit", "Snov hız sınırına ulaşıldı; biraz bekleyin.");
    if (status < 200 || status >= 300)
      throw new ExternalProviderError("bad_response", `Snov hata verdi (HTTP ${status}).`);
  }

  async function token(): Promise<string> {
    const cached = snovTokens.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.token;
    const r = await send(`${SNOV}/v1/oauth/access_token`, {
      method: "POST",
      body: {
        grant_type: "client_credentials",
        client_id: o.clientId,
        client_secret: o.clientSecret,
      },
    });
    // Belirteç ucu yanlış kimlikte 400 de döndürebilir.
    if (r.status === 400)
      throw new ExternalProviderError("auth", "Snov istemci kimliği reddedildi.");
    check(r.status);
    const tok = r.body.access_token;
    if (typeof tok !== "string" || !tok)
      throw new ExternalProviderError("bad_response", "Snov erişim belirteci alınamadı.");
    const ttl = typeof r.body.expires_in === "number" ? r.body.expires_in : 3600;
    snovTokens.set(cacheKey, { token: tok, expiresAt: now() + Math.max(0, ttl - 60) * 1000 });
    return tok;
  }

  async function authed(url: string, method: "GET" | "POST", body?: unknown) {
    const r = await send(url, {
      method,
      headers: { authorization: `Bearer ${await token()}` },
      body,
    });
    check(r.status);
    return r.body;
  }

  return {
    id: "snov",
    async search(domain) {
      const started = await authed(`${SNOV}/v2/domain-search/domain-emails/start`, "POST", {
        domain,
      });
      const hash = (started.meta as { task_hash?: unknown } | undefined)?.task_hash;
      if (typeof hash !== "string" || !TASK_HASH_RE.test(hash))
        throw new ExternalProviderError("bad_response", "Snov arama görevi başlatılamadı.");
      const polls = o.polls ?? 6;
      for (let i = 0; i < polls; i++) {
        if (i > 0) await sleep(o.pollMs ?? 1500);
        const res = await authed(`${SNOV}/v2/domain-search/domain-emails/result/${hash}`, "GET");
        if (res.status !== "completed") continue;
        const data = Array.isArray(res.data) ? (res.data as { email?: unknown }[]) : [];
        const hits: ExternalHit[] = [];
        for (const e of data.slice(0, 50))
          if (typeof e?.email === "string")
            hits.push({ email: e.email, confidence: null, sourceUrl: null });
        return hits;
      }
      // Süre içinde bitmedi: bu alan adı için sonuç yok sayılır (sonraki aramada yeniden denenebilir).
      return [];
    },
    async quota() {
      const body = await authed(`${SNOV}/v1/get-balance`, "GET");
      const data = (body.data ?? {}) as { balance?: unknown; limit_resets_in?: unknown };
      const bal =
        typeof data.balance === "number"
          ? data.balance
          : typeof data.balance === "string"
            ? Number.parseFloat(data.balance)
            : Number.NaN;
      const days = data.limit_resets_in;
      return {
        remaining: Number.isFinite(bal) ? Math.floor(bal) : null,
        resetDate:
          typeof days === "number" && Number.isFinite(days) && days >= 0
            ? new Date(now() + days * 86_400_000).toISOString().slice(0, 10)
            : null,
      };
    },
  };
}
