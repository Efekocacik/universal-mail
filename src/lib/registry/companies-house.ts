import { z } from "zod";
import { clip, createSpacer, getJson, isIsoDay, type HttpDeps } from "./http";
import {
  REGISTRY_MAX_HITS,
  RegistryProviderError,
  type RegistryCompanyInput,
  type RegistryPage,
  type RegistryProvider,
  type RegistryQuery,
} from "./types";

/**
 * Companies House Advanced Search istemcisi (GB, SIC 2007).
 *  GET https://api.company-information.service.gov.uk/advanced-search/companies
 *      ?sic_codes=<csv>&incorporated_from=&incorporated_to=&company_status=active&location=&size=100&start_index=
 *  Yetki: HTTP Basic, kullanıcı adı = API anahtarı, parola boş. Hız sınırı 600 istek / 5 dk → istekler arası ≥ 0,5 sn.
 *  Sonuç yoksa API 404 döner (boş sayfa sayılır). `hits` > 5000 → `REGISTRY_TOO_MANY` (pencere/yer daraltılmalı).
 * Bilinen sınır: kayıtlı ofis adresi çoğu zaman işletmenin bulunduğu yer değildir (muhasebeci adresi); canlı eşleşme
 * oranı kanıtlanmamıştır (docs).
 */
export const CH_BASE_URL = "https://api.company-information.service.gov.uk";
export const CH_PAGE_SIZE = 100;
export const CH_MIN_INTERVAL_MS = 500;

const itemSchema = z
  .object({
    company_number: z.string().optional(),
    company_name: z.string().optional(),
    date_of_creation: z.string().optional(),
    company_status: z.string().optional(),
    sic_codes: z.array(z.string()).optional(),
    registered_office_address: z
      .object({
        postal_code: z.string().optional(),
        locality: z.string().optional(),
        address_line_1: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    hits: z.number().int().nonnegative().optional(),
    items: z.array(itemSchema).optional(),
  })
  .passthrough();

export function mapChItem(raw: z.infer<typeof itemSchema>): RegistryCompanyInput | null {
  const id = clip(raw.company_number, 40);
  const name = clip(raw.company_name, 300);
  if (!id || !name || !isIsoDay(raw.date_of_creation)) return null;
  const addr = raw.registered_office_address;
  return {
    externalId: id,
    name,
    tradingName: null,
    countryCode: "GB",
    activityScheme: "SIC2007",
    activityCodes: (raw.sic_codes ?? []).filter((c) => /^\d{4,5}$/.test(c)).slice(0, 20),
    incorporatedOn: raw.date_of_creation,
    postcode: clip(addr?.postal_code, 16),
    locality: clip(addr?.locality, 120),
    addressLine: clip(addr?.address_line_1, 200),
    registryStatus: clip(raw.company_status, 40),
  };
}

export interface CompaniesHouseDeps extends HttpDeps {
  getKey: () => Promise<string | undefined>;
  baseUrl?: string;
}

export function createCompaniesHouseProvider(deps: CompaniesHouseDeps): RegistryProvider {
  const spacer = createSpacer({ minIntervalMs: CH_MIN_INTERVAL_MS, ...deps });
  const base = deps.baseUrl ?? CH_BASE_URL;

  async function request(params: URLSearchParams, signal?: AbortSignal) {
    const key = await deps.getKey();
    if (!key)
      throw new RegistryProviderError("REGISTRY_KEY_MISSING", "Companies House anahtarı yok.");
    const url = new URL("/advanced-search/companies", base);
    url.search = params.toString();
    await spacer();
    return getJson(
      url,
      { Authorization: `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}` },
      { ...deps, signal, emptyOn404: true },
    );
  }

  return {
    source: "companies_house",
    isDemo: false,
    async search(q: RegistryQuery, opts = {}): Promise<RegistryPage> {
      const start = q.cursor ? Number(q.cursor) : 0;
      if (!Number.isInteger(start) || start < 0)
        throw new RegistryProviderError("REGISTRY_BAD_RESPONSE", "Geçersiz sayfa imleci.");
      const params = new URLSearchParams({
        sic_codes: q.activityCodes.join(","),
        incorporated_from: q.incorporatedFrom,
        incorporated_to: q.incorporatedTo,
        company_status: "active",
        size: String(CH_PAGE_SIZE),
        start_index: String(start),
      });
      if (q.locality) params.set("location", q.locality);
      const raw = await request(params, opts.signal);
      if (raw === null) return { items: [], total: 0, nextCursor: null };
      const parsed = pageSchema.safeParse(raw);
      if (!parsed.success)
        throw new RegistryProviderError(
          "REGISTRY_BAD_RESPONSE",
          "Companies House yanıtı beklenen biçimde değil.",
        );
      const hits = parsed.data.hits ?? null;
      if (hits !== null && hits > REGISTRY_MAX_HITS)
        throw new RegistryProviderError("REGISTRY_TOO_MANY", `Çok fazla sonuç (${hits}).`);
      const rawItems = parsed.data.items ?? [];
      const items = rawItems.map(mapChItem).filter((x): x is RegistryCompanyInput => x !== null);
      const consumed = start + rawItems.length;
      const limit = Math.min(hits ?? REGISTRY_MAX_HITS, REGISTRY_MAX_HITS);
      return {
        items,
        total: hits,
        nextCursor: rawItems.length > 0 && consumed < limit ? String(consumed) : null,
      };
    },
    async test(opts = {}): Promise<void> {
      // En küçük yetkili istek: tek kayıt. Sonuç olmaması (404) da anahtarın geçerli olduğunu gösterir.
      await request(new URLSearchParams({ sic_codes: "56102", size: "1" }), opts.signal);
    },
  };
}
