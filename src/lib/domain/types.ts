/** Projenin ortak alan tipleri. Bu dosya hiçbir modüle bağımlı değildir. */

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Tarama bölgesi (arayüzden gelir). */
export interface RegionInput {
  kind: "city" | "bbox" | "circle";
  name: string;
  countryCode?: string | null;
  bbox: BBox;
  circle?: { lat: number; lng: number; radiusM: number };
  cityId?: number;
}

export type SearchStrategy = "text" | "nearby";
/** discovery: yalnızca Pro alanlar. enrich: web sitesi/telefon/yorum sayısı da (Enterprise, daha pahalı). */
export type FieldProfile = "discovery" | "enrich";
export type ProviderId = "google" | "mock";

export type ScanStatus =
  | "draft"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_stopped";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type NoveltyLabel = "future_opening" | "high" | "likely" | "low";

export interface NoveltySignal {
  id: string;
  /** Aynı gruptaki sinyallerden yalnızca en yüksek puan sayılır (mükerrer puanlamayı önler). */
  group: string;
  points: number;
  reason: string;
}

export interface ScanQuery {
  kind: "type" | "keyword";
  term: string;
  categoryKey?: string;
}

export interface ScanProgress {
  unitsTotal?: number;
  unitsDone?: number;
  unitsFailed?: number;
  placesFound?: number;
  callsTotal?: number;
  newPlaces?: number;
  futureOpening?: number;
}

/** Faturalandırma birimi (Google SKU). */
export type SkuId =
  | "text_search_ids"
  | "text_search_pro"
  | "text_search_enterprise"
  | "nearby_search_pro"
  | "nearby_search_enterprise"
  | "place_details_essentials"
  | "place_details_pro"
  | "place_details_enterprise";

/** Sağlayıcıdan gelen, normalleştirilmiş işletme kaydı. */
export interface PlaceRecord {
  placeId: string;
  source: "google" | "demo";
  name: string;
  formattedAddress?: string;
  lat: number;
  lng: number;
  countryCode?: string;
  city?: string;
  primaryType?: string;
  types: string[];
  businessStatus?: string;
  /** "YYYY", "YYYY-MM" veya "YYYY-MM-DD" */
  openingDate?: string;
  googleMapsUri?: string;
  website?: string;
  phone?: string;
  intlPhone?: string;
  userRatingCount?: number;
}
