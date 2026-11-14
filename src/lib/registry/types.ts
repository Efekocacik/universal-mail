import type { ActivityScheme, RegistrySource } from "@/lib/db/schema";

/**
 * Faz 5 (P0 sözleşmesi, sahibi: paket R): resmî şirket sicili sağlayıcı arayüzü. Companies House (GB, SIC 2007) ve INSEE
 * Sirene (FR, NAF) aynı arayüzü uygular; demo kipinde (`places.provider = "mock"`) `isDemo = true` sağlayıcı ağsız,
 * belirlenimci kayıt üretir. Sağlayıcı yalnızca SİCİL verisi döndürür (Google içeriği ASLA); eşleştirme ayrıdır.
 */

export type { ActivityScheme, RegistrySource } from "@/lib/db/schema";

/** Sicil ülkesi (kaynağa göre sabit). */
export const REGISTRY_COUNTRY: Record<RegistrySource, "GB" | "FR"> = {
  companies_house: "GB",
  insee: "FR",
};

/** Kaynağın varsayılan faaliyet kodu şeması (INSEE için ayar `registry.insee.scheme` geçerlidir). */
export const REGISTRY_DEFAULT_SCHEME: Record<RegistrySource, ActivityScheme> = {
  companies_house: "SIC2007",
  insee: "NAFRev2",
};

/** Tek çalışmada çekilebilecek en çok kayıt; aşılırsa `REGISTRY_TOO_MANY` (pencere/yer daraltılmalı). */
export const REGISTRY_MAX_HITS = 5000;

/** İş türleri (worker kaydı: `registerRegistryJobs`). */
export const REGISTRY_FETCH_JOB = "registry.fetch";
export const REGISTRY_MATCH_JOB = "registry.match";

export interface RegistryQuery {
  scheme: ActivityScheme;
  /** SIC (5 hane) veya NAF (ör. 56.30Z) kodları; 1–20. */
  activityCodes: string[];
  /** Kuruluş penceresi 'YYYY-MM-DD' (UTC), iki uç dahil. */
  incorporatedFrom: string;
  incorporatedTo: string;
  /** Serbest metin yer süzgeci (ör. şehir); yoksa null. */
  locality: string | null;
  /** Sağlayıcıya özgü sayfa imleci (CH `start_index`, INSEE `curseur`); ilk sayfa için null. */
  cursor: string | null;
}

/** Sağlayıcının döndürdüğü tek şirket (henüz normalleştirilmemiş; `name_norm`/kategori servis tarafında türetilir). */
export interface RegistryCompanyInput {
  externalId: string;
  name: string;
  tradingName: string | null;
  countryCode: "GB" | "FR";
  activityScheme: ActivityScheme;
  activityCodes: string[];
  /** 'YYYY-MM-DD' */
  incorporatedOn: string;
  postcode: string | null;
  locality: string | null;
  addressLine: string | null;
  registryStatus: string | null;
}

export interface RegistryPage {
  items: RegistryCompanyInput[];
  /** Sağlayıcının bildirdiği toplam isabet (bilinmiyorsa null). */
  total: number | null;
  /** Sonraki sayfanın imleci; son sayfada null. */
  nextCursor: string | null;
}

export interface RegistryProvider {
  readonly source: RegistrySource;
  readonly isDemo: boolean;
  search(query: RegistryQuery, opts?: { signal?: AbortSignal }): Promise<RegistryPage>;
  /** Anahtarı en küçük yetkili istekle sınar (demo: ağsız başarı). Hata `RegistryProviderError` fırlatır. */
  test(opts?: { signal?: AbortSignal }): Promise<void>;
}

/** Çalışma hata kodları (`registry_runs.error_code`, `registry.error.<KOD>` metni). */
export const REGISTRY_RUN_ERROR_CODES = [
  "REGISTRY_AUTH",
  "REGISTRY_RATE",
  "REGISTRY_UPSTREAM",
  "REGISTRY_BAD_RESPONSE",
  "REGISTRY_KEY_MISSING",
  "REGISTRY_TOO_MANY",
] as const;
export type RegistryRunErrorCode = (typeof REGISTRY_RUN_ERROR_CODES)[number];

export class RegistryProviderError extends Error {
  constructor(
    readonly code: RegistryRunErrorCode,
    message: string,
    /** 429'da sağlayıcının `Retry-After` süresi (ms), varsa. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RegistryProviderError";
  }
}

const DAY_MS = 86_400_000;

/** Kuruluş penceresi: bugün (UTC) − `windowDays` … bugün. Saat dilimi bağımsız, iki uç dahil. */
export function registryWindow(windowDays: number, now: number): { from: string; to: string } {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365)
    throw new RangeError("windowDays 1–365 olmalı.");
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - windowDays * DAY_MS), to: day(now) };
}
