import { describe, expect, it, vi } from "vitest";
import { GooglePlacesClient } from "@/lib/places/client";
import { PlacesApiError, classifyGoogleError } from "@/lib/places/errors";
import { DISCOVERY_FIELDS, ENRICH_FIELDS } from "@/lib/places/fields";
import { formatOpeningDate, normalizeGooglePlace } from "@/lib/places/normalize";

const rawCafe = {
  id: "ChIJabc",
  displayName: { text: "Little Owl Café", languageCode: "en" },
  formattedAddress: "1 High Street, London",
  location: { latitude: 51.5, longitude: -0.12 },
  types: ["cafe", "food"],
  primaryType: "cafe",
  businessStatus: "OPERATIONAL",
  addressComponents: [
    { longText: "United Kingdom", shortText: "GB", types: ["country", "political"] },
    { longText: "London", shortText: "London", types: ["postal_town"] },
  ],
  googleMapsUri: "https://maps.google.com/?cid=1",
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof GooglePlacesClient>[0]> = {}) {
  const sleeps: number[] = [];
  const client = new GooglePlacesClient({
    getApiKey: async () => "TEST_KEY",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 100,
    ...extra,
  });
  return { client, sleeps };
}

const bbox = { south: 51.4, west: -0.2, north: 51.6, east: 0 };

describe("GooglePlacesClient.searchText", () => {
  it("doğru uç nokta, başlıklar ve gövdeyi gönderir", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ places: [rawCafe], nextPageToken: "TOKEN2" }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.searchText({
      textQuery: "cafe",
      includedType: "cafe",
      bbox,
      fields: DISCOVERY_FIELDS,
      includeFutureOpening: true,
    });

    expect(res.sku).toBe("text_search_pro");
    expect(res.nextPageToken).toBe("TOKEN2");
    expect(res.places).toHaveLength(1);
    expect(res.places[0]).toMatchObject({ placeId: "ChIJabc", countryCode: "GB", city: "London", source: "google" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("TEST_KEY");
    expect(headers["X-Goog-FieldMask"]).toBe(DISCOVERY_FIELDS.map((f) => `places.${f}`).join(","));
    expect(headers["X-Goog-FieldMask"]).not.toContain("userRatingCount");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      textQuery: "cafe",
      includedType: "cafe",
      strictTypeFiltering: true,
      includeFutureOpeningBusinesses: true,
      pageSize: 20,
      locationRestriction: {
        rectangle: { low: { latitude: 51.4, longitude: -0.2 }, high: { latitude: 51.6, longitude: 0 } },
      },
    });
    expect(body.pageToken).toBeUndefined();
  });

  it("sonraki sayfada pageToken gönderir ve zenginleştirme maskesinde Enterprise SKU döner", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ places: [] }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.searchText({
      textQuery: "pub",
      bbox,
      pageToken: "ABC",
      fields: ENRICH_FIELDS,
      includeFutureOpening: false,
    });
    expect(res.sku).toBe("text_search_enterprise");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.pageToken).toBe("ABC");
    expect(body.includedType).toBeUndefined();
    expect(body.includeFutureOpeningBusinesses).toBe(false);
  });

  it("kimliği veya konumu olmayan kayıtları atlar", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ places: [rawCafe, { id: "x" }, { location: { latitude: 1, longitude: 2 } }] }),
    );
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false });
    expect(res.places).toHaveLength(1);
  });

  it("anahtar yoksa istek atmadan auth hatası verir", async () => {
    const fetchMock = vi.fn();
    const { client } = makeClient(fetchMock as unknown as typeof fetch, { getApiKey: async () => undefined });
    await expect(
      client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("yeniden deneme ve hata sınıflandırma", () => {
  it("429 sonrası üstel geri çekilmeyle yeniden dener ve başarır", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) return jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many requests" } }, { status: 429 });
      return jsonResponse({ places: [rawCafe] });
    });
    const { client, sleeps } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false });
    expect(res.places).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("Retry-After başlığına uyar", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? jsonResponse({ error: { code: 429, message: "slow down" } }, { status: 429, headers: { "retry-after": "3" } })
        : jsonResponse({ places: [] });
    });
    const { client, sleeps } = makeClient(fetchMock as unknown as typeof fetch);
    await client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false });
    expect(sleeps).toEqual([3000]);
  });

  it("en fazla 3 yeniden denemeden sonra hata fırlatır", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: 503, message: "unavailable" } }, { status: 503 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false }),
    ).rejects.toMatchObject({ kind: "server" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 deneme + 3 yeniden deneme
  });

  it("ağ hatası 'network' olarak sınıflanır ve yeniden denenir", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const err = await client
      .searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlacesApiError);
    expect(err.kind).toBe("network");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("kalıcı hatalar (403/400) yeniden denenmez", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, { status: 403 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.searchText({ textQuery: "cafe", bbox, fields: DISCOVERY_FIELDS, includeFutureOpening: false }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Google hata gövdelerini anlaşılır türlere çevirir", () => {
    const billing = classifyGoogleError(403, {
      error: { code: 403, status: "PERMISSION_DENIED", message: "This API method requires billing to be enabled.", details: [{ reason: "BILLING_DISABLED" }] },
    });
    expect(billing.kind).toBe("billing");
    expect(billing.message).toContain("faturalandırma");

    const disabled = classifyGoogleError(403, {
      error: { code: 403, message: "Places API (New) has not been used in project 123 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] },
    });
    expect(disabled.kind).toBe("disabled");

    const keyInvalid = classifyGoogleError(400, {
      error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] },
    });
    expect(keyInvalid.kind).toBe("auth");

    const quota = classifyGoogleError(429, {
      error: { code: 429, message: "Quota exceeded for quota metric 'SearchText' per day", status: "RESOURCE_EXHAUSTED" },
    });
    expect(quota.kind).toBe("quota");
    expect(quota.isPausable).toBe(true);
    expect(quota.isRetryable).toBe(false);

    expect(classifyGoogleError(429, { error: { message: "rate limit" } }).kind).toBe("rate");
    expect(classifyGoogleError(400, { error: { message: "Invalid includedType" } }).kind).toBe("invalid");
    expect(classifyGoogleError(500, undefined).kind).toBe("server");
    expect(classifyGoogleError(418, undefined).kind).toBe("unknown");
  });
});

describe("searchNearby ve getDetails", () => {
  it("Nearby Search gövdesi ve yarıçap sınırı", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ places: [rawCafe] }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.searchNearby({
      includedTypes: ["cafe", "coffee_shop"],
      circle: { lat: 51.5, lng: -0.12, radiusM: 800 },
      fields: DISCOVERY_FIELDS,
      includeFutureOpening: true,
    });
    expect(res.sku).toBe("nearby_search_pro");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("places:searchNearby");
    expect(JSON.parse(init.body as string)).toMatchObject({
      includedTypes: ["cafe", "coffee_shop"],
      maxResultCount: 20,
      includeFutureOpeningBusinesses: true,
      locationRestriction: { circle: { center: { latitude: 51.5, longitude: -0.12 }, radius: 800 } },
    });

    await expect(
      client.searchNearby({ includedTypes: ["cafe"], circle: { lat: 0, lng: 0, radiusM: 60_000 }, fields: DISCOVERY_FIELDS, includeFutureOpening: false }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("Place Details öneksiz maske ile GET atar", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ...rawCafe, websiteUri: "https://owl.example", userRatingCount: 3 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.getDetails("ChIJabc", ["id", "websiteUri", "userRatingCount"]);
    expect(res.sku).toBe("place_details_enterprise");
    expect(res.place).toMatchObject({ website: "https://owl.example", userRatingCount: 3 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places/ChIJabc");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("id,websiteUri,userRatingCount");
  });
});

describe("normalizeGooglePlace", () => {
  it("openingDate tarih nesnesini biçimlendirir", () => {
    expect(formatOpeningDate({ year: 2027, month: 2, day: 5 })).toBe("2027-02-05");
    expect(formatOpeningDate({ year: 2027, month: 2, day: 0 })).toBe("2027-02");
    expect(formatOpeningDate({ year: 2027, month: 0, day: 0 })).toBe("2027");
    expect(formatOpeningDate({ year: 0, month: 1, day: 1 })).toBeUndefined();
    expect(formatOpeningDate(undefined)).toBeUndefined();
  });

  it("FUTURE_OPENING kaydını açılış tarihiyle çevirir", () => {
    const p = normalizeGooglePlace({
      ...rawCafe,
      businessStatus: "FUTURE_OPENING",
      openingDate: { year: 2027, month: 3, day: 1 },
    });
    expect(p).toMatchObject({ businessStatus: "FUTURE_OPENING", openingDate: "2027-03-01" });
  });

  it("şehir bileşeni sırası: locality > postal_town", () => {
    const p = normalizeGooglePlace({
      ...rawCafe,
      addressComponents: [
        { longText: "Greater London", shortText: "GL", types: ["administrative_area_level_2"] },
        { longText: "London", shortText: "London", types: ["postal_town"] },
        { longText: "Westminster", shortText: "W", types: ["locality"] },
        { longText: "Germany", shortText: "de", types: ["country"] },
      ],
    });
    expect(p).toMatchObject({ city: "Westminster", countryCode: "DE" });
  });

  it("ad yoksa yer tutucu kullanır", () => {
    expect(normalizeGooglePlace({ id: "x", location: { latitude: 1, longitude: 2 } })?.name).toBe("(adsız işletme)");
  });
});
