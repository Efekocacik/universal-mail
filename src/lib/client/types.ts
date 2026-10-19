import type { BudgetStatus } from "@/lib/budget";
import type { LeadRow, Facets } from "@/lib/leads/query";
import type { SetupState } from "@/lib/app/state";
import type { ScanEstimate } from "@/lib/scan/planner";
import type {
  NoveltyLabel,
  NoveltySignal,
  ScanProgress,
  ScanStatus,
  BBox,
} from "@/lib/domain/types";
import type { LeadStatus } from "@/lib/db/schema";
import type { LeadContactRow, LeadEmailRow, EnrichmentRow } from "@/lib/email/store";

export type {
  BudgetStatus,
  LeadRow,
  Facets,
  SetupState,
  ScanEstimate,
  NoveltyLabel,
  NoveltySignal,
  ScanProgress,
  ScanStatus,
  BBox,
  LeadStatus,
  LeadContactRow,
  LeadEmailRow,
  EnrichmentRow,
};

export interface AppConfig {
  setup: SetupState;
  provider: "google" | "mock";
  mapsKey: string | null;
  mapId: string;
  targetCountries: string[];
  novelty: { highAt: number; likelyAt: number; newWindowDays: number };
  language: "tr" | "en";
}

export interface StatusScan {
  id: number;
  status: ScanStatus;
  progress: ScanProgress;
  pauseReason: string | null;
  provider: "google" | "mock";
}

export interface AppStatus {
  provider: "google" | "mock";
  setupCompleted: boolean;
  budget: BudgetStatus;
  scans: StatusScan[];
  pendingJobs: number;
}

export interface CityResult {
  id: number;
  name: string;
  cc: string;
  lat: number;
  lng: number;
  pop: number;
  radiusKm: number;
  bbox: BBox;
}

export interface Category {
  id: number;
  key: string;
  name: string;
  placeTypes: string[];
  keywords: string[];
  enabled: boolean;
  builtIn: boolean;
  priority: number;
}

export interface ScanListItem {
  id: number;
  regionName: string;
  countryCode: string | null;
  status: ScanStatus;
  pauseReason: string | null;
  error: string | null;
  provider: "google" | "mock";
  strategy: "text" | "nearby";
  fieldProfile: "discovery" | "enrich";
  progress: ScanProgress;
  callsBySku: Record<string, number>;
  costUsd: number;
  isBaseline: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LeadDetailResponse {
  lead: {
    id: number;
    placeId: string | null;
    source: string;
    displayName: string | null;
    countryCode: string | null;
    city: string | null;
    categoryKey: string | null;
    noveltyScore: number;
    noveltyLabel: NoveltyLabel;
    noveltySignals: NoveltySignal[];
    status: LeadStatus;
    notes: string | null;
    tags: string[];
    language: string | null;
    createdAt: number;
    updatedAt: number;
  };
  /** Faz 2: işletmenin kendi web sitesinden bulunan e-postalar (kaynak sayfa, tür, doğrulama), bağlantılar ve işlem durumu. */
  emails: LeadEmailRow[];
  contacts: LeadContactRow[];
  enrichment: EnrichmentRow | null;
  /** Aynı e-postayı veya işletme alan adını paylaşan diğer lead'ler. */
  duplicates: {
    leadId: number;
    reason: "same_email" | "same_domain";
    value: string;
    displayName: string | null;
    city: string | null;
  }[];
  /** Kalıcı kayıt: yer kimliği, en çok 30 günlük konum ve türetilmiş bayraklar. */
  place: {
    placeId: string;
    source: "google" | "demo";
    lat: number | null;
    lng: number | null;
    wasFuture: boolean;
    isClosed: boolean;
    firstSeenAt: number;
    newDetectedAt: number | null;
    openedDetectedAt: number | null;
    notFoundInScanId: number | null;
    mapsUrl: string;
  } | null;
  /** Oturum önbelleğindeki Google içeriği; uygulama yeniden açıldığında null olur. */
  google: {
    name: string;
    formattedAddress: string | null;
    primaryType: string | null;
    types: string[];
    businessStatus: string | null;
    openingDate: string | null;
    website: string | null;
    phone: string | null;
    intlPhone: string | null;
    userRatingCount: number | null;
    fetchedAt: number;
    enrichedAt: number | null;
  } | null;
}

export interface GoogleDataSummary {
  cachedPlaces: number;
  storedCoordinates: number;
  maxRetentionDays: number;
}

export interface SettingsResponse {
  settings: {
    consent: { version: string; acceptedAt: number; name: string; title?: string } | null;
    "company.profile": CompanyProfile | null;
    "targets.countries": string[];
    "budget.monthlyUsd": number;
    "places.provider": "google" | "mock";
    "maps.mapId": string;
    "novelty.thresholds": { highAt: number; likelyAt: number; newWindowDays: number };
    "google.cacheDays": number;
    "mock.epoch": number;
    "ui.language": "tr" | "en";
    "enrichment.external": { enabled: boolean; provider: "hunter" };
    "enrichment.concurrency": number;
  };
  secrets: { placesKey: SecretInfo; mapsKey: SecretInfo; hunterKey: SecretInfo };
  setup: SetupState;
  app: { version: string; dataDir: string };
}

export interface SecretInfo {
  set: boolean;
  source: "store" | "env" | null;
  masked: string | null;
}

export interface CompanyProfile {
  legalName: string;
  address: string;
  taxId: string;
  phone: string;
  contactName: string;
  contactTitle?: string;
  website?: string;
}

export interface FindEmailsPreview {
  leads: number;
  ready: number;
  noWebsite: number;
  needsGoogle: number;
  alreadyDone: number;
  optedOut: number;
  willSearch: number;
  google: { load: boolean; places: number; estimatedCostUsd: number; remainingBudgetUsd: number };
  external: { enabled: boolean; configured: boolean; available: boolean };
}

export interface EnrichmentStatusResponse {
  jobs: { queued: number; running: number; scheduled: number };
  states: Record<string, number>;
  external: { enabled: boolean; provider: "hunter"; configured: boolean };
  concurrency: number;
}
