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
  place: {
    placeId: string;
    source: "google" | "demo";
    name: string;
    formattedAddress: string | null;
    lat: number;
    lng: number;
    countryCode: string | null;
    city: string | null;
    primaryType: string | null;
    types: string[];
    businessStatus: string | null;
    openingDate: string | null;
    website: string | null;
    phone: string | null;
    intlPhone: string | null;
    userRatingCount: number | null;
    googleMapsUri: string | null;
    googleFetchedAt: number;
    enrichedAt: number | null;
    firstSeenAt: number;
    newDetectedAt: number | null;
    openedDetectedAt: number | null;
    notFoundInScanId: number | null;
  } | null;
  googleDataStale: boolean;
  googleCacheDays: number;
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
  };
  secrets: { placesKey: SecretInfo; mapsKey: SecretInfo };
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
