"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { BBox, LeadStatus, NoveltyLabel } from "@/lib/client/types";

export interface UiFilters {
  q: string;
  countries: string[];
  city: string;
  categories: string[];
  novelty: NoveltyLabel[];
  leadStatus: LeadStatus[];
  businessStatus: string[];
  hasWebsite: "any" | "yes" | "no";
  scanId?: number;
  hideNotFound: boolean;
}

export const EMPTY_FILTERS: UiFilters = {
  q: "",
  countries: [],
  city: "",
  categories: [],
  novelty: [],
  leadStatus: [],
  businessStatus: [],
  hasWebsite: "any",
  hideNotFound: false,
};

export interface DraftRegion {
  kind: "city" | "bbox" | "circle";
  name: string;
  countryCode?: string | null;
  bbox: BBox;
  circle?: { lat: number; lng: number; radiusM: number };
  cityId?: number;
  radiusKm?: number;
}

export type DrawMode = null | "rect" | "circle";

export interface FocusRequest {
  nonce: number;
  lat?: number;
  lng?: number;
  zoom?: number;
  fit?: BBox;
}

interface ExploreContextValue {
  filters: UiFilters;
  setFilters: (patch: Partial<UiFilters>) => void;
  resetFilters: () => void;
  activeFilterCount: number;
  selectedId: number | null;
  select: (id: number | null, opts?: { focus?: boolean; lat?: number; lng?: number }) => void;
  tab: "list" | "scan";
  setTab: (tab: "list" | "scan") => void;
  draft: DraftRegion | null;
  setDraft: (r: DraftRegion | null) => void;
  drawMode: DrawMode;
  setDrawMode: (m: DrawMode) => void;
  viewBounds: BBox | null;
  setViewBounds: (b: BBox) => void;
  onlyInView: boolean;
  setOnlyInView: (v: boolean) => void;
  focus: FocusRequest | null;
  requestFocus: (r: Omit<FocusRequest, "nonce">) => void;
  /** API'ye gönderilecek süzgeç parametreleri (haritadaki alan dahil). */
  apiFilters: Record<string, unknown>;
}

const Ctx = createContext<ExploreContextValue | null>(null);

export function useExplore(): ExploreContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExplore yalnızca ExploreProvider içinde kullanılabilir.");
  return v;
}

export function toApiFilters(
  f: UiFilters,
  bounds: BBox | null,
  onlyInView: boolean,
): Record<string, unknown> {
  return {
    q: f.q.trim() || undefined,
    countries: f.countries,
    city: f.city || undefined,
    categories: f.categories,
    novelty: f.novelty,
    status: f.leadStatus,
    businessStatus: f.businessStatus,
    hasWebsite: f.hasWebsite === "any" ? undefined : f.hasWebsite === "yes",
    scanId: f.scanId,
    notFound: f.hideNotFound ? false : undefined,
    bbox:
      onlyInView && bounds
        ? [bounds.south, bounds.west, bounds.north, bounds.east].map((n) => n.toFixed(5)).join(",")
        : undefined,
  };
}

export function ExploreProvider({
  children,
  initialScanId,
}: {
  children: React.ReactNode;
  initialScanId?: number;
}) {
  const [filters, setFiltersState] = useState<UiFilters>({
    ...EMPTY_FILTERS,
    scanId: initialScanId,
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<"list" | "scan">("list");
  const [draft, setDraft] = useState<DraftRegion | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [viewBounds, setViewBoundsState] = useState<BBox | null>(null);
  const [onlyInView, setOnlyInView] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  const setFilters = useCallback(
    (patch: Partial<UiFilters>) => setFiltersState((f) => ({ ...f, ...patch })),
    [],
  );
  const resetFilters = useCallback(() => setFiltersState({ ...EMPTY_FILTERS }), []);
  const setViewBounds = useCallback((b: BBox) => setViewBoundsState(b), []);
  const requestFocus = useCallback(
    (r: Omit<FocusRequest, "nonce">) => setFocus({ ...r, nonce: Date.now() + Math.random() }),
    [],
  );

  const select = useCallback(
    (id: number | null, opts?: { focus?: boolean; lat?: number; lng?: number }) => {
      setSelectedId(id);
      if (id !== null && opts?.focus && opts.lat !== undefined && opts.lng !== undefined) {
        requestFocus({ lat: opts.lat, lng: opts.lng, zoom: 16 });
      }
    },
    [requestFocus],
  );

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.q.trim()) n++;
    if (filters.countries.length) n++;
    if (filters.city) n++;
    if (filters.categories.length) n++;
    if (filters.novelty.length) n++;
    if (filters.leadStatus.length) n++;
    if (filters.businessStatus.length) n++;
    if (filters.hasWebsite !== "any") n++;
    if (filters.scanId !== undefined) n++;
    if (filters.hideNotFound) n++;
    return n;
  }, [filters]);

  const apiFilters = useMemo(
    () => toApiFilters(filters, viewBounds, onlyInView),
    [filters, viewBounds, onlyInView],
  );

  const value: ExploreContextValue = {
    filters,
    setFilters,
    resetFilters,
    activeFilterCount,
    selectedId,
    select,
    tab,
    setTab,
    draft,
    setDraft,
    drawMode,
    setDrawMode,
    viewBounds,
    setViewBounds,
    onlyInView,
    setOnlyInView,
    focus,
    requestFocus,
    apiFilters,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
