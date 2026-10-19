/**
 * Harici e-posta bulma servisi (SRS 4.5 adım 2, FR-ENR-04): yalnızca kullanıcı açıkça etkinleştirir ve kendi API
 * anahtarını girerse, yerel taramada adres bulunamayan işletmeler için çalışır. Servise yalnızca işletmenin alan adı
 * gönderilir. Şu an Hunter.io (Domain Search v2) desteklenir; arayüz başka sağlayıcılar için hazırdır.
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

export interface ExternalEmailProvider {
  readonly id: "hunter";
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
