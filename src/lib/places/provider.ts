import type { BBox, PlaceRecord, ProviderId, SkuId } from "@/lib/domain/types";

/**
 * Yer sağlayıcı arayüzü. Google ve demo sağlayıcı aynı sözleşmeyi uygular; tarama motoru
 * yalnızca bu arayüzü bilir. Yeni bir veri kaynağı (Faz 5 sicilleri vb.) bu arayüze değil,
 * `src/lib/sources` altındaki LeadSource sözleşmesine eklenir.
 */
export interface TextSearchRequest {
  /** Aranacak ifade. Tür aramalarında insan-okunur ifade, anahtar kelime aramalarında kelimenin kendisi. */
  textQuery: string;
  /** Google Table A türü (tür aramaları için). */
  includedType?: string;
  bbox: BBox;
  pageToken?: string;
  fields: readonly string[];
  includeFutureOpening: boolean;
  languageCode?: string;
  regionCode?: string;
}

export interface NearbySearchRequest {
  includedTypes: string[];
  circle: { lat: number; lng: number; radiusM: number };
  fields: readonly string[];
  includeFutureOpening: boolean;
  languageCode?: string;
  regionCode?: string;
}

export interface SearchResult {
  places: PlaceRecord[];
  nextPageToken?: string;
  /** Bu çağrının faturalandığı birim. */
  sku: SkuId;
}

export interface DetailsResult {
  place: PlaceRecord | null;
  sku: SkuId;
}

export interface PlacesProvider {
  readonly id: ProviderId;
  /** Text Search sayfa başına en fazla bu kadar, toplam en fazla `maxTextResults` sonuç döner. */
  readonly pageSize: number;
  readonly maxTextResults: number;
  readonly maxNearbyResults: number;
  searchText(req: TextSearchRequest): Promise<SearchResult>;
  searchNearby(req: NearbySearchRequest): Promise<SearchResult>;
  getDetails(placeId: string, fields: readonly string[]): Promise<DetailsResult>;
}

/** İnsan-okunur arama ifadesi: tür adındaki alt çizgiler boşluğa çevrilir. */
export function typeToQuery(type: string): string {
  return type.replace(/_/g, " ");
}
