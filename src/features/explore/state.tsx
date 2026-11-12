"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { toSearchParams } from "@/lib/client/api";
import type { BBox } from "@/lib/client/types";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  toApiFilters,
  type LeadSort,
  type UiFilters,
} from "./filters";
import { t } from "@/lib/i18n";
import type { LeadLifecycle } from "@/lib/leads/query";
import {
  EMPTY_SELECTION,
  MAX_SELECTION,
  onFiltersChanged,
  selectIds as selectIdsModel,
  selectQuery as selectQueryModel,
  selectRange as selectRangeModel,
  toggleId,
  type Selection,
  type SelectionUpdate,
} from "./selection";

export {
  countActiveFilters,
  EMPTY_FILTERS,
  toApiFilters,
  type LeadSort,
  type UiFilters,
} from "./filters";
/** "/" kısayolunun odakladığı arama kutusu. */
export const SEARCH_INPUT_ID = "lead-search";

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

/** Kısayolla açılabilen pencereler (düğmeler bunlara bağlıdır; DOM tıklaması taklit edilmez). */
export type ExploreDialog = "campaign" | "findEmails" | null;

export interface ActiveSavedFilter {
  id: number;
  name: string;
  /** Uygulandığı andaki süzgeçler ("Değişti · Güncelle" göstergesi için). */
  snapshot: UiFilters;
}

/** Bağlantıdan gelen başlangıç süzgeçleri (gösterge paneli ve bildirimler; bkz. app/(app)/page.tsx). */
export interface InitialExploreState {
  scanId?: number;
  lifecycle?: LeadLifecycle[];
  detectedSince?: number;
  archived?: boolean;
}

interface ExploreContextValue {
  filters: UiFilters;
  setFilters: (patch: Partial<UiFilters>) => void;
  /** Süzgeçleri bütünüyle değiştirir (kayıtlı süzgeç uygulama). */
  applyFilters: (f: UiFilters, opts?: { bbox?: BBox | null; sort?: LeadSort }) => void;
  resetFilters: () => void;
  activeFilterCount: number;
  sort: LeadSort;
  setSort: (s: LeadSort) => void;
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
  /** "Sonuçlara sığdır" isteği (kısayol F); harita paneli dinler. */
  fitNonce: number;
  requestFit: () => void;
  /** API'ye gönderilecek süzgeç parametreleri (haritadaki alan dahil). */
  apiFilters: Record<string, unknown>;
  /** Harita noktaları için süzgeçler: alan (bbox) HARİÇ; böylece kaydırınca işaretçiler kaybolmaz. */
  mapFilters: Record<string, unknown>;
  /** `apiFilters`in sorgu dizesi (seçim geçerliliği ve toplu işlemler için). */
  filterQuery: string;
  selection: Selection;
  toggleSelect: (id: number) => void;
  selectRange: (toId: number, ordered: readonly number[]) => void;
  selectIds: (ids: readonly number[]) => boolean;
  selectQuery: (filterQuery: string, count: number, source: "view" | "all") => void;
  clearSelection: () => void;
  dialog: ExploreDialog;
  openDialog: (d: ExploreDialog) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  activeSaved: ActiveSavedFilter | null;
  setActiveSaved: (s: ActiveSavedFilter | null) => void;
}

const Ctx = createContext<ExploreContextValue | null>(null);

export function useExplore(): ExploreContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useExplore yalnızca ExploreProvider içinde kullanılabilir.");
  return v;
}

export function ExploreProvider({
  children,
  initial,
}: {
  children: React.ReactNode;
  initial?: InitialExploreState;
}) {
  const [filters, setFiltersState] = useState<UiFilters>({
    ...EMPTY_FILTERS,
    scanId: initial?.scanId,
    lifecycle: initial?.lifecycle ?? [],
    detected: initial?.detectedSince !== undefined ? { since: initial.detectedSince } : null,
    archived: initial?.archived === true,
  });
  const [sort, setSort] = useState<LeadSort>("novelty");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<"list" | "scan">("list");
  const [draft, setDraft] = useState<DraftRegion | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>(null);
  const [viewBounds, setViewBoundsState] = useState<BBox | null>(null);
  const [onlyInView, setOnlyInView] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [dialog, openDialog] = useState<ExploreDialog>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activeSaved, setActiveSaved] = useState<ActiveSavedFilter | null>(null);

  const setFilters = useCallback(
    (patch: Partial<UiFilters>) => setFiltersState((f) => ({ ...f, ...patch })),
    [],
  );
  const resetFilters = useCallback(() => {
    setFiltersState({ ...EMPTY_FILTERS });
    setActiveSaved(null);
  }, []);
  const setViewBounds = useCallback((b: BBox) => setViewBoundsState(b), []);
  const requestFocus = useCallback(
    (r: Omit<FocusRequest, "nonce">) => setFocus({ ...r, nonce: Date.now() + Math.random() }),
    [],
  );
  const requestFit = useCallback(() => setFitNonce((n) => n + 1), []);

  const applyFilters = useCallback(
    (f: UiFilters, opts?: { bbox?: BBox | null; sort?: LeadSort }) => {
      setFiltersState({ ...f });
      if (opts?.sort) setSort(opts.sort);
      if (opts?.bbox) {
        // Kaydedilmiş alan: harita oraya gider, liste yalnızca o alanı gösterir.
        setViewBoundsState(opts.bbox);
        setOnlyInView(true);
        requestFocus({ fit: opts.bbox });
      } else {
        setOnlyInView(false);
      }
    },
    [requestFocus],
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

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);

  const apiFilters = useMemo(
    () => toApiFilters(filters, viewBounds, onlyInView),
    [filters, viewBounds, onlyInView],
  );
  const mapFilters = useMemo(() => toApiFilters(filters, null, false), [filters]);
  const filterQuery = useMemo(() => toSearchParams(apiFilters).toString(), [apiFilters]);

  // Seçim değişiklikleri: sınır aşılırsa kullanıcıya söylenir (sessiz kesme yok). Yan etkiler (bildirim) setState
  // güncelleyicisinin DIŞINDA kalsın diye güncel seçim bir ref'ten okunur.
  const selRef = useRef(selection);
  selRef.current = selection;
  const applyUpdate = useCallback((u: SelectionUpdate) => {
    if (u.notice === "cap")
      toast.warning(t("selection.cap", { n: MAX_SELECTION.toLocaleString("tr-TR") }));
    selRef.current = u.selection;
    setSelection(u.selection);
    return u.notice === null;
  }, []);
  const toggleSelect = useCallback(
    (id: number) => void applyUpdate(toggleId(selRef.current, id)),
    [applyUpdate],
  );
  const selectRange = useCallback(
    (toId: number, ordered: readonly number[]) =>
      void applyUpdate(selectRangeModel(selRef.current, toId, ordered)),
    [applyUpdate],
  );
  const selectIds = useCallback(
    (ids: readonly number[]) => applyUpdate(selectIdsModel(ids)),
    [applyUpdate],
  );
  const basisRef = useRef(filterQuery);
  basisRef.current = filterQuery;
  const selectQuery = useCallback(
    (q: string, count: number, source: "view" | "all") =>
      void applyUpdate({
        selection: selectQueryModel(q, basisRef.current, count, source),
        notice: null,
      }),
    [applyUpdate],
  );
  const clearSelection = useCallback(
    () => void applyUpdate({ selection: EMPTY_SELECTION, notice: null }),
    [applyUpdate],
  );

  // Süzgeç değişince "süzgece uyan tümü" seçimi geçersizleşir (yanlış kümeye işlem yapılmasın).
  useEffect(() => {
    const r = onFiltersChanged(selRef.current, filterQuery);
    if (!r.invalidated) return;
    toast.info(t("selection.invalidated"));
    selRef.current = r.selection;
    setSelection(r.selection);
  }, [filterQuery]);

  const value: ExploreContextValue = {
    filters,
    setFilters,
    applyFilters,
    resetFilters,
    activeFilterCount,
    sort,
    setSort,
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
    fitNonce,
    requestFit,
    apiFilters,
    mapFilters,
    filterQuery,
    selection,
    toggleSelect,
    selectRange,
    selectIds,
    selectQuery,
    clearSelection,
    dialog,
    openDialog,
    shortcutsOpen,
    setShortcutsOpen,
    activeSaved,
    setActiveSaved,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
