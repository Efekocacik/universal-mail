import type { PlaceRecord } from "@/lib/domain/types";
import { sleep as defaultSleep } from "@/lib/util";
import { classifyGoogleError, PlacesApiError, userMessageFor } from "./errors";
import { detailsFieldMask, searchFieldMask, skuFor } from "./fields";
import { normalizeGooglePlace } from "./normalize";
import type {
  DetailsResult,
  NearbySearchRequest,
  PlacesProvider,
  SearchResult,
  TextSearchRequest,
} from "./provider";

const BASE_URL = "https://places.googleapis.com/v1";

export interface GooglePlacesClientOptions {
  /** Anahtar her istekte çağrılır; böylece ayarlardan değişirse yeniden başlatma gerekmez. */
  getApiKey: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** 429/5xx/ağ hatalarında en fazla bu kadar yeniden deneme (NFR-04: 3). */
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export class GooglePlacesClient implements PlacesProvider {
  readonly id = "google" as const;
  readonly pageSize = 20;
  readonly maxTextResults = 60;
  readonly maxNearbyResults = 20;

  private readonly getApiKey: GooglePlacesClientOptions["getApiKey"];
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(opts: GooglePlacesClientOptions) {
    this.getApiKey = opts.getApiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 800;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  async searchText(req: TextSearchRequest): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      textQuery: req.textQuery,
      locationRestriction: {
        rectangle: {
          low: { latitude: req.bbox.south, longitude: req.bbox.west },
          high: { latitude: req.bbox.north, longitude: req.bbox.east },
        },
      },
      pageSize: this.pageSize,
      includeFutureOpeningBusinesses: req.includeFutureOpening,
      languageCode: req.languageCode ?? "en",
    };
    if (req.includedType) {
      body.includedType = req.includedType;
      body.strictTypeFiltering = true;
    }
    if (req.regionCode) body.regionCode = req.regionCode;
    if (req.pageToken) body.pageToken = req.pageToken;

    const json = await this.post("/places:searchText", searchFieldMask(req.fields), body);
    return {
      places: this.parsePlaces(json),
      nextPageToken: typeof json.nextPageToken === "string" ? json.nextPageToken : undefined,
      sku: skuFor("text", req.fields),
    };
  }

  async searchNearby(req: NearbySearchRequest): Promise<SearchResult> {
    if (req.circle.radiusM <= 0 || req.circle.radiusM > 50_000) {
      throw new PlacesApiError(
        "invalid",
        "Nearby Search yarıçapı 0–50.000 m aralığında olmalıdır.",
      );
    }
    const body: Record<string, unknown> = {
      includedTypes: req.includedTypes,
      maxResultCount: this.maxNearbyResults,
      locationRestriction: {
        circle: {
          center: { latitude: req.circle.lat, longitude: req.circle.lng },
          radius: req.circle.radiusM,
        },
      },
      includeFutureOpeningBusinesses: req.includeFutureOpening,
      languageCode: req.languageCode ?? "en",
    };
    if (req.regionCode) body.regionCode = req.regionCode;

    const json = await this.post("/places:searchNearby", searchFieldMask(req.fields), body);
    return { places: this.parsePlaces(json), sku: skuFor("nearby", req.fields) };
  }

  async getDetails(placeId: string, fields: readonly string[]): Promise<DetailsResult> {
    const json = await this.request(`/places/${encodeURIComponent(placeId)}`, {
      method: "GET",
      mask: detailsFieldMask(fields),
    });
    return { place: normalizeGooglePlace(json), sku: skuFor("details", fields) };
  }

  private parsePlaces(json: Record<string, unknown>): PlaceRecord[] {
    const raw = Array.isArray(json.places) ? json.places : [];
    return raw.map(normalizeGooglePlace).filter((p): p is PlaceRecord => p !== null);
  }

  private post(path: string, mask: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request(path, { method: "POST", mask, body });
  }

  private async request(
    path: string,
    opts: { method: "GET" | "POST"; mask: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const key = await this.getApiKey();
    if (!key) {
      throw new PlacesApiError(
        "auth",
        "Google Places API anahtarı tanımlı değil. Ayarlar'dan anahtarı girin.",
      );
    }

    let lastError: PlacesApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = lastError?.retryAfterMs ?? this.baseDelayMs * 2 ** (attempt - 1);
        await this.sleep(Math.min(wait, 30_000));
      }
      try {
        return await this.once(path, key, opts);
      } catch (e) {
        if (!(e instanceof PlacesApiError)) throw e;
        lastError = e;
        if (!e.isRetryable) throw e;
      }
    }
    throw lastError ?? new PlacesApiError("unknown", userMessageFor("unknown"));
  }

  private async once(
    path: string,
    key: string,
    opts: { method: "GET" | "POST"; mask: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": opts.mask,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new PlacesApiError("network", userMessageFor("network"), {
        reason: e instanceof Error ? e.name : undefined,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch {
        throw new PlacesApiError("unknown", userMessageFor("unknown", "yanıt çözümlenemedi"));
      }
    }

    let errBody: unknown;
    try {
      errBody = await res.json();
    } catch {
      errBody = undefined;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw classifyGoogleError(
      res.status,
      errBody,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
}
